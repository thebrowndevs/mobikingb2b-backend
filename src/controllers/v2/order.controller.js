import mongoose from 'mongoose';
import { v4 as uuidv4 } from "uuid";
import { Order } from "../../models/order.model.js";
import { Product } from '../../models/product.model.js';
import { Stock } from '../../models/stock.model.js';
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from '../../utils/asyncHandler.js';
import { STOCK_TYPES, ORDER_TYPES } from '../../constants.js';
import { User } from '../../models/user.model.js';
import { Cart } from "../../models/cart.model.js";
import { Address } from "../../models/address.model.js";
import { Coupon } from "../../models/coupon.model.js";
import { Variant } from "../../models/variant.model.js";
import { Inventory } from "../../models/inventory.model.js";
import { CompanyDetails } from "../../models/company_details.model.js";
import { initiatePhonepePayment, checkPhonepeOrderStatus, refundPhonepePayment } from "../../services/phonepe.service.js";
import { initiateRazorpayPayment, refundRazorpayPayment } from "../../services/razorpay.service.js";
import { confirmOrderPaymentLogic } from "../../services/payment.service.js";
import { PartialRequests } from "../../models/partialOrderRequests.model.js";
import { getShiprocketOrderDetails, createShiprocketReturnOrder } from "../../services/shiprocket.service.js";

const syncProductStock = async (productId, session) => {
    const variants = await Variant.find({ productId }).session(session);
    let totalStockSum = 0;
    let availableStockSum = 0;
    for (const v of variants) {
        totalStockSum += v.totalStock || 0;
        availableStockSum += v.availableStock || 0;
    }

    await Product.findByIdAndUpdate(
        productId,
        {
            totalStock: totalStockSum,
            totalProductStock: totalStockSum,
            availableStock: availableStockSum
        },
        { session }
    );

    const inventory = await Inventory.findOne({ product: productId }).session(session);
    if (inventory) {
        inventory.physicalStock = totalStockSum;
        await inventory.save({ session });
    }
};

/* ─────────────────────────────────────────────────────────────────────
   adjustStock (v2) — Cancel / Return pe stock wapas karta hai for variant support
   ───────────────────────────────────────────────────────────────────── */
async function adjustStock(
    order,
    {
        type = STOCK_TYPES.CANCEL,
        session: externalSession = null,
    } = {}
) {
    if (
        !order ||
        order.abondonedOrder ||
        !Array.isArray(order.items) ||
        order.items.length === 0
    ) {
        return null;
    }

    const ownSession = !externalSession;
    const session = externalSession ?? await mongoose.startSession();

    const run = async () => {
        const lockedOrder = await Order.findOneAndUpdate(
            {
                _id: order._id,
                _restockDone: { $ne: true }
            },
            { $set: { _restockDone: true } },
            { new: true, session }
        );

        if (!lockedOrder) {
            console.warn(
                `[adjustStock v2] Skipped — _restockDone already true ` +
                `for order ${order._id} (type: ${type})`
            );
            return null;
        }

        const stockEntries = [];

        for (const item of lockedOrder.items) {
            const qty = Math.floor(Number(item.quantity));
            if (qty <= 0) continue;

            const productId = item.productId?._id
                ? String(item.productId._id)
                : String(item.productId);

            const variantKey = String(item.variantName || "").trim();
            if (!variantKey) {
                throw new ApiError(400, `Missing variantName for product ${productId}`);
            }

            const isScratchy = !!item.isScratchy;

            if (isScratchy) {
                // Scratchy variants are stored inside Product document's scratchyVariants map
                const afterRestore = await Product.findOneAndUpdate(
                    { _id: productId },
                    {
                        $inc: {
                            totalStock: qty,
                            scratchyStock: qty,
                            [`scratchyVariants.${variantKey}`]: qty
                        }
                    },
                    { new: true, session }
                ).select("scratchyVariants totalStock scratchyStock");

                if (!afterRestore) {
                    throw new ApiError(404, `Product "${productId}" not found — restore failed`);
                }

                const updatedStock = afterRestore.scratchyVariants.get(variantKey);
                const previousStock = updatedStock - qty;

                stockEntries.push({
                    orderId: lockedOrder.orderId,
                    type,
                    variantName: variantKey,
                    quantity: qty,
                    previousStock,
                    updatedStock,
                    productId,
                    isScratchy: true
                });
            } else {
                // Regular variants are stored in the Variant model
                const variant = await Variant.findOne({ productId, name: variantKey }).session(session);
                if (variant) {
                    const previousAvailable = variant.availableStock;
                    const previousPhysical = variant.totalStock;

                    // Restock available and total variant stock
                    variant.availableStock += qty;
                    variant.totalStock += qty;

                    // Restore remainingStock & availableStock to purchaseSets
                    if (item.purchaseSetId) {
                        const set = variant.purchaseSets.id(item.purchaseSetId);
                        if (set) {
                            set.remainingStock += qty;
                            set.availableStock += qty;
                        } else if (variant.purchaseSets.length > 0) {
                            variant.purchaseSets[0].remainingStock += qty;
                            variant.purchaseSets[0].availableStock += qty;
                        }
                    } else if (variant.purchaseSets.length > 0) {
                        variant.purchaseSets[0].remainingStock += qty;
                        variant.purchaseSets[0].availableStock += qty;
                    }

                    await variant.save({ session });

                    // Sync parent product and inventory stock levels
                    await syncProductStock(productId, session);

                    stockEntries.push({
                        orderId: lockedOrder.orderId,
                        type,
                        variantName: variantKey,
                        quantity: qty,
                        previousStock: previousPhysical,
                        updatedStock: variant.totalStock,
                        productId,
                        isScratchy: false
                    });
                }
            }
        }

        if (stockEntries.length > 0) {
            await Stock.insertMany(stockEntries, { session });
        }

        return { restored: true };
    };

    try {
        if (ownSession) {
            let result = null;
            await session.withTransaction(async () => {
                result = await run();
            });
            return result;
        } else {
            return await run();
        }
    } catch (err) {
        console.error("[adjustStock v2] failed:", err);
        throw err;
    } finally {
        if (ownSession) session.endSession();
    }
}

/* ─────────────────────────────────────────────────────────────────────
   createPosOrder (v2) — POS order create with scratchy variant support
───────────────────────────────────────────────────────────────────── */
const createPosOrder = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();

    try {
        const {
            userId,
            name, phoneNo,
            orderAmount,
            gst,
            comments,
            discount,
            subtotal,
            method = 'Cash',
            items
        } = req.body;

        if (
            !userId ||
            !name || !phoneNo ||
            !orderAmount ||
            !method || !items
        ) {
            throw new ApiError(400, 'Required details not found.');
        }

        const nowIso = new Date().toISOString();
        const paymentDate = (method == "Cash" || method == "Online") ? new Date() : null;
        let newOrderDoc = new Order({
            userId,
            name: name.trim(),
            phoneNo: phoneNo.trim(),
            method,
            type: ORDER_TYPES.POS,
            status: 'Delivered',
            deliveredAt: nowIso,
            orderState: "Confirmed",
            paymentStatus: method == 'Online' ? 'Pending' : 'Paid',
            paymentDate,
            orderId: uuidv4().split('-')[0].toUpperCase(),
            orderAmount,
            discount,
            gst,
            subtotal,
            items,
            comments
        });

        let updatedUser = null;
        await session.withTransaction(async () => {
            newOrderDoc = await newOrderDoc.save({ session });

            const stockEntries = [];

            for (const item of newOrderDoc.items) {
                const qty = Math.floor(Number(item.quantity));
                if (!Number.isInteger(qty) || qty <= 0) {
                    throw new ApiError(400, `Invalid quantity for product ${item.productId}`);
                }

                const variantKey = String(item.variantName || "").trim();
                if (!variantKey) {
                    throw new ApiError(400, `Missing variantName for product ${item.productId}`);
                }

                const isScratchy = !!item.isScratchy;

                const updateQuery = isScratchy ? {
                    _id: item.productId,
                    totalStock: { $gte: qty },
                    scratchyStock: { $gte: qty },
                    [`scratchyVariants.${variantKey}`]: { $gte: qty }
                } : {
                    _id: item.productId,
                    totalStock: { $gte: qty },
                    [`variants.${variantKey}`]: { $gte: qty }
                };

                const updateFields = isScratchy ? {
                    $inc: {
                        totalStock: -qty,
                        scratchyStock: -qty,
                        [`scratchyVariants.${variantKey}`]: -qty
                    }
                } : {
                    $inc: {
                        totalStock: -qty,
                        [`variants.${variantKey}`]: -qty
                    }
                };

                const selectFields = "variants scratchyVariants totalStock scratchyStock";

                const afterDecrement = await Product.findOneAndUpdate(
                    updateQuery,
                    updateFields,
                    { new: true, session }
                ).select(selectFields);

                if (!afterDecrement) {
                    throw new ApiError(400, `Insufficient stock or variant "${variantKey}" not found`);
                }

                const updatedStock = isScratchy
                    ? afterDecrement.scratchyVariants.get(variantKey)
                    : afterDecrement.variants.get(variantKey);
                const previousStock = updatedStock + qty;

                stockEntries.push({
                    orderId: newOrderDoc.orderId,
                    orderRef: newOrderDoc._id,
                    type: STOCK_TYPES.PURCHASE,
                    variantName: variantKey,
                    purchasePrice: item.price,
                    quantity: qty,
                    previousStock,
                    updatedStock,
                    productId: item.productId,
                    isScratchy
                });
            }

            if (stockEntries.length > 0) {
                await Stock.insertMany(stockEntries, { session });
            }

            const uniqueProductIds = new Set();
            newOrderDoc.items.forEach(it => {
                if (it.productId && it.productId._id) {
                    uniqueProductIds.add(it.productId._id.toString());
                }
            });

            const productOrderOps = Array.from(uniqueProductIds).map(productId => ({
                updateOne: {
                    filter: { _id: productId },
                    update: { $push: { orders: newOrderDoc._id } }
                }
            }));

            // console.log("Product Ids: ",productOrderOps);
            if (productOrderOps.length > 0) {
                const productResult = await Product.bulkWrite(productOrderOps, { session });
                console.log('Order pushed to products:', productResult);
            } else {
                console.warn('⚠️ No valid products found to push order');
            }

            // Add order to user
            updatedUser = await User.findByIdAndUpdate(
                userId,
                { $push: { orders: newOrderDoc._id } },
                { new: true, session }
            )
            // .select('-password -refreshToken')
            //     .populate({
            //         path: "cart",
            //         populate: {
            //             path: "items.productId",
            //             model: "Product",
            //             populate: {
            //                 path: "category",  // This is the key part
            //                 model: "SubCategory"
            //             }
            //         }
            //     })
            //     .populate("wishlist")
            //     .populate("address")
            //     .populate("orders")
            //     .exec();

            if (!updatedUser) throw new ApiError(500, "Failed to update user orders");
        });

        return res.status(201).json(
            new ApiResponse(201, { order: newOrderDoc }, "POS Order created successfully")
        );

    } catch (err) {
        throw err;
    } finally {
        session.endSession();
    }
});

/* ─────────────────────────────────────────────────────────────────────
   cancelPosOrder (v2) — Cancel POS order with scratchy variant support (API route v2 not migrated for now, but controller ready)
───────────────────────────────────────────────────────────────────── */
const cancelPosOrder = asyncHandler(async (req, res) => {
    const { orderId, reason } = req.body;
    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, 'Order not found');
    }
    if (order.status === "Cancelled") {
        throw new ApiError(400, 'Order already cancelled');
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            order.status = 'Cancelled';
            order.reason = reason;
            await order.save({ session });

            await adjustStock(order, { type: STOCK_TYPES.CANCEL, session });
        });
    } finally {
        session.endSession();
    }

    return res.status(200).json(
        new ApiResponse(200, { order }, "POS Order cancelled and stock restored successfully")
    );
});

/* ─────────────────────────────────────────────────────────────────────
   createOnlineOrderV2 — Online order creation with dynamic gateway routing (PhonePe vs Razorpay)
   and stock reservation
───────────────────────────────────────────────────────────────────── */
const createOnlineOrderV2 = asyncHandler(async (req, res) => {
    const { gateway } = req.body;

    if (!gateway || !["razorpay", "phonepe"].includes(gateway)) {
        throw new ApiError(400, "Invalid or missing payment gateway selection.");
    }

    // Check gateway toggles in CompanyDetails
    const settings = await CompanyDetails.findOne();
    if (settings && settings.paymentGatewaySettings) {
        if (gateway === "phonepe" && !settings.paymentGatewaySettings.enablePhonepe) {
            throw new ApiError(400, "PhonePe payment gateway is currently disabled.");
        }
        if (gateway === "razorpay" && !settings.paymentGatewaySettings.enableRazorpay) {
            throw new ApiError(400, "Razorpay payment gateway is currently disabled.");
        }
    }

    const session = await mongoose.startSession();

    try {
        let {
            userId, cartId,
            name, email, phoneNo,
            orderAmount,
            coupon,
            comments,
            discount,
            deliveryCharge = 0,
            gst,
            subtotal,
            address,
            addressId,
            isAppOrder
        } = req.body;

        let couponData = {};
        let findCoupon = null;

        if (coupon) {
            findCoupon = await Coupon.findById(coupon);
            if (!findCoupon) {
                throw new ApiError(404, "Coupon not found");
            }

            const start = new Date(findCoupon?.startDate);
            const end = new Date(findCoupon?.endDate);
            const now = Date.now();

            if (start.getTime() > now) {
                throw new ApiError(400, "Offer not started yet");
            }

            if (end.getTime() < now) {
                throw new ApiError(400, "Coupon expired");
            }

            // Enforce oneTime and oneTimeUser constraints
            if (findCoupon?.type === "oneTimeUser") {
                if (!findCoupon.userId || findCoupon.userId.toString() !== req.user?._id?.toString()) {
                    throw new ApiError(400, "Invalid Coupon");
                }
                if (findCoupon.appliedBy?.some(c => c?.user?.toString() === req.user?._id?.toString())) {
                    throw new ApiError(400, "Coupon already redeemed once");
                }
            }
            if (findCoupon?.type === "oneTime" && findCoupon.appliedBy?.some(c => c?.user?.toString() === req.user?._id?.toString())) {
                throw new ApiError(400, "Coupon already redeemed once");
            }

            couponData = {
                coupon: findCoupon._id,
                couponType: findCoupon.type,
                couponCode: findCoupon.code
            };
        }

        cartId = req?.user?.cart;
        if (!userId || !name || !phoneNo || !cartId || !subtotal || !address) {
            throw new ApiError(400, 'Required order details missing.');
        }

        if (deliveryCharge == undefined || deliveryCharge == null || deliveryCharge < 0) {
            throw new ApiError(400, 'Delivery charge cannot be negative.');
        }

        const cart = await Cart.findOne({ _id: cartId }).populate('items.productId');
        if (!cart || cart.items.length === 0) {
            throw new ApiError(400, 'Cart is empty or not found.');
        }

        const foundAddress = await Address.findById(addressId);
        const addressDetails = {
            address: `${foundAddress?.street || ""}, ${foundAddress?.street2 || ""}, ${foundAddress?.city || ""}, ${foundAddress?.state || ""}, ${foundAddress?.pinCode || ""}`,
            address2: foundAddress?.street2,
            city: foundAddress?.city,
            state: foundAddress?.state,
            country: foundAddress?.country,
            pincode: foundAddress?.pinCode
        };

        const paymentDate = new Date();
        const newOrder = new Order({
            gateway,
            ...couponData,
            ...addressDetails,
            userId,
            name: name.trim(),
            email: email.trim(),
            phoneNo: phoneNo.trim(),
            comments,
            addressId,
            method: 'Online',
            type: 'Regular',
            status: 'New',
            paymentStatus: 'Pending',
            paymentDate,
            isAppOrder,
            orderState: "Reserved",
            abondonedOrder: true,
            orderId: uuidv4().split('-')[0].toUpperCase(),
            orderAmount,
            deliveryCharge,
            gst,
            subtotal,
            items: cart.items
        });

        // Recalculate subtotal and deliveryCharge
        let subtotal_amount = 0;
        const categoryCharges = new Map();

        for (const item of newOrder.items) {
            const qty = Math.floor(Number(item.quantity));
            if (!Number.isInteger(qty) || qty <= 0) {
                throw new Error(`Invalid quantity for product ${item.productId?._id || item.productId}: ${item.quantity}`);
            }

            const variantKey = String(item.variantName || '').trim();
            if (!variantKey) {
                throw new Error(`Missing variantName for product ${item.productId._id}`);
            }

            const prod = await Product.findOne({ _id: item.productId._id })
                .session(session)
                .populate("category")
                .exec();

            if (!prod || !prod.category) {
                throw new ApiError(400, `Product or category missing for ${item.productId._id}`);
            }

            if (!prod?.variants) {
                throw new ApiError(404, `Variants not found for product ${item?.productId?._id}`);
            }

            if (!prod.variants?.has(variantKey)) {
                throw new ApiError(404, `Variant "${variantKey}" not found for product ${item?.productId?._id}`);
            }

            const previousStock = prod.variants.get(variantKey);
            if (previousStock < qty) {
                throw new ApiError(400, `Insufficient stock for ${variantKey}`);
            }

            subtotal_amount += item.price * item.quantity;
            const categoryId = prod.category._id.toString();
            const deliveryCharge = prod.category.deliveryCharge || 0;

            if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
                categoryCharges.set(categoryId, deliveryCharge);
            }
        }

        let values = Array.from(categoryCharges.values());
        let totalDeliveryCharge = Math.max(...values);
        if (!isFinite(totalDeliveryCharge) || totalDeliveryCharge === undefined) {
            totalDeliveryCharge = 0;
        }

        newOrder.subtotal = subtotal_amount;
        newOrder.deliveryCharge = totalDeliveryCharge;

        let discountedAmount = 0;
        if (findCoupon) {
            discountedAmount = subtotal_amount * (parseFloat(findCoupon?.percent) * 0.01);
            discountedAmount = parseFloat(discountedAmount.toFixed(2));
            if (discountedAmount >= findCoupon?.value) {
                discountedAmount = parseFloat(findCoupon?.value);
            }
        }

        newOrder.discount = discountedAmount;
        newOrder.orderAmount = (subtotal_amount - (discountedAmount || 0) + totalDeliveryCharge).toFixed(2);

        // Initiate Gateway specific payment details
        let gatewayResponse = {};
        const reqOrigin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
        const backendOrigin = `${req.protocol}://${req.get('host')}`;

        if (gateway === "phonepe") {
            const tempOrderId = "PH_" + Date.now() + Math.floor(Math.random() * 1000);
            const initiateRes = await initiatePhonepePayment(
                tempOrderId,
                newOrder.orderAmount,
                newOrder.phoneNo,
                reqOrigin,
                backendOrigin
            );
            newOrder.phonepeOrderId = tempOrderId;
            gatewayResponse = {
                gateway: "phonepe",
                redirectUrl: initiateRes.redirectUrl
            };
        } else {
            // razorpay
            const razorpayOrder = await initiateRazorpayPayment(newOrder._id, newOrder.orderAmount);
            newOrder.razorpayOrderId = razorpayOrder.id;
            gatewayResponse = {
                gateway: "razorpay",
                razorpayOrderId: razorpayOrder.id,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                key: process.env.RAZORPAY_KEY_ID
            };
        }

        await session.withTransaction(async () => {
            await newOrder.save({ session });

            // deduct stock and create logs
            const stockEntries = [];
            for (const item of newOrder.items) {
                const qty = Math.floor(Number(item.quantity));
                const variantKey = String(item.variantName || "").trim();

                const afterDecrement = await Product.findOneAndUpdate(
                    {
                        _id: item.productId._id,
                        totalStock: { $gte: qty },
                        [`variants.${variantKey}`]: { $gte: qty }
                    },
                    {
                        $inc: {
                            totalStock: -qty,
                            [`variants.${variantKey}`]: -qty
                        }
                    },
                    { new: true, session }
                ).select("variants totalStock");

                if (!afterDecrement) {
                    throw new ApiError(409, `Insufficient stock for variant ${variantKey}`);
                }

                const updatedStock = afterDecrement.variants.get(variantKey);
                const previousStock = updatedStock + qty;

                stockEntries.push({
                    type: STOCK_TYPES.PURCHASE,
                    orderId: newOrder.orderId,
                    orderRef: newOrder?._id,
                    variantName: variantKey,
                    purchasePrice: item.price,
                    quantity: qty,
                    previousStock,
                    updatedStock,
                    productId: item.productId._id
                });
            }

            const createdStocks = await Stock.insertMany(stockEntries, { session });
            newOrder.stockIds = createdStocks.map(s => s._id);
            await newOrder.save({ session });

            // Create new cart, update user with new cart and delete old cart
            const newCart = new Cart({
                userId: cart.userId,
                items: cart.items,
                totalCartValue: cart.totalCartValue
            });

            await newCart.save({ session, timestamps: false });
            await User.findByIdAndUpdate(
                cart.userId,
                { cart: newCart._id },
                { new: true, session }
            );

            await Cart.findByIdAndDelete(cart._id, { session });
        });

        const updatedUser = await User.findById(cart.userId)
            .select('-password -refreshToken')
            .populate({
                path: "cart",
                populate: {
                    path: "items.productId",
                    model: "Product",
                    populate: {
                        path: "category",
                        model: "SubCategory"
                    }
                }
            })
            .populate("wishlist")
            .populate("address")
            .populate("orders")
            .exec();

        return res.status(201).json(
            new ApiResponse(201, {
                ...gatewayResponse,
                newOrderId: newOrder._id,
                user: updatedUser
            }, `${gateway.toUpperCase()} Order Created Successfully`)
        );

    } catch (err) {
        console.error('createOnlineOrderV2 error:', err);
        return res.status(500).json({ message: err.message || 'Internal server error' });
    } finally {
        session.endSession();
    }
});

/* ─────────────────────────────────────────────────────────────────────
   phonepeCallbackV2 — Handles browser returns / GET queries from PhonePe
───────────────────────────────────────────────────────────────────── */
const phonepeCallbackV2 = asyncHandler(async (req, res) => {
    const transactionId = req.query.id;
    if (!transactionId) {
        return res.status(400).send("Missing transaction identity parameter.");
    }

    try {
        const order = await Order.findOne({ phonepeOrderId: transactionId });
        if (!order) {
            return res.status(404).send("Corresponding order record not found.");
        }

        const phonepeStatus = await checkPhonepeOrderStatus(transactionId);
        const baseFrontend = process.env.FRONTEND_URL;
        const successRedirect = req.query.successRedirect || `${baseFrontend}/account?tab=orders`;
        const failureRedirect = req.query.failureRedirect || `${baseFrontend}/checkout`;

        if (phonepeStatus.isPaid) {
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    // Update raw tracking parameters before confirmation
                    order.phonepePaymentId = phonepeStatus.paymentId;
                    order.phonepeRawResponse = phonepeStatus.rawResponse;
                    order.phonepeUtr = phonepeStatus.utr;
                    order.phonepePaymentMode = phonepeStatus.paymentMode;
                    await order.save({ session });

                    await confirmOrderPaymentLogic(
                        order._id,
                        null,
                        null,
                        session,
                        order.userId
                    );
                });
            } finally {
                session.endSession();
            }
            return res.redirect(successRedirect);
        } else {
            return res.redirect(failureRedirect);
        }
    } catch (error) {
        console.error("PhonePe callback processing failure:", error);
        return res.status(500).send("Internal Callback handler failure");
    }
});


/* ─────────────────────────────────────────────────────────────────────
   raisePartialReturnRequest (v2)
───────────────────────────────────────────────────────────────────── */
export const raisePartialReturnRequest = asyncHandler(async (req, res) => {
    const { orderId, reason, items } = req.body;
    // console.log("req: ", items);

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        throw new ApiError(400, "Valid Order ID is required");
    }

    if (!Array.isArray(items) || items.length === 0) {
        throw new ApiError(400, "At least one item must be selected for return");
    }

    const order = await Order.findById(orderId).populate({
        path: "items.productId",
        model: "Product"
    });

    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.status !== "Delivered" && order.status !== "New") {
        throw new ApiError(403, "Only delivered or new orders can be returned");
    }

    let validatedItems = [];
    for (const reqItem of items) {
        const matchedItem = order.items.find((it, index) => {
            return (reqItem?._id ? it?._id?.toString() == reqItem?._id?.toString() : false) ||
                (reqItem?.index
                    ? (it?.index == reqItem?.index || index == reqItem?.index) : false
                ) ||
                (reqItem?.productId ? (
                    (
                        it?.productId?._id?.toString() == reqItem?.productId?.toString() ||
                        it?.productId?._id?.toString() == reqItem?.productId?._id?.toString() ||
                        it?.productId?.toString() == reqItem?.productId?.toString()
                    ) &&
                    it?.variantName == reqItem?.variantName) &&
                    (it?.isScratchy?.toString() == reqItem?.isScratchy?.toString())
                    : false
                )
            // ||
            // (reqItem.productId && (it.productId?._id?.toString() === reqItem.productId.toString() ||
            //     it.productId?.toString() === reqItem.productId.toString()) &&
            //     (it.variantName === reqItem.variantName))
        });

        if (!matchedItem) {
            throw new ApiError(400, `Item ${reqItem.fullName || reqItem?.productId?.fullName || 'selected'} not found in order`);
        }

        if (matchedItem.isReturned || matchedItem.returnStatus == "Returned" || matchedItem.returnStatus === "Pending" || matchedItem.returnStatus == "Accepted"
            || matchedItem.partialReturnRequest
        ) {
            throw new ApiError(400, `Item "${matchedItem.fullName || matchedItem?.productId?.fullName}" has already been returned or has an active return request`);
        }

        if (reqItem.quantity > matchedItem.quantity) {
            throw new ApiError(400, `Return quantity (${reqItem.quantity}) cannot exceed ordered quantity (${matchedItem.quantity}) for ${matchedItem?.productId?.fullName}`);
        }

        validatedItems.push({
            index: matchedItem?.index || reqItem?.index,
            productId: matchedItem.productId?._id || matchedItem.productId,
            sku: matchedItem?.sku || matchedItem?._id,
            fullName: matchedItem?.fullName || matchedItem?.productId?.fullName,
            basePrice: matchedItem?.basePrice,
            variantName: matchedItem?.variantName,
            quantity: reqItem.quantity,
            isScratchy: matchedItem?.isScratchy,
            price: matchedItem?.price,
            returnStatus: "Pending"
        });
    }

    // console.log("order det/ails", order?.shiprocketOrderId, req.shiprocketToken)

    // Map against Shiprocket forward order details if present using service
    if (order?.shiprocketOrderId && req.shiprocketToken) {
        try {
            const shipData = await getShiprocketOrderDetails(order?.shiprocketOrderId, req.shiprocketToken);
            // console.log("shipData: ", shipData)
            if (shipData && Array.isArray(shipData?.products)) {
                validatedItems.forEach(item => {
                    const itemName = item?.fullName + (item?.variantName ? `\n , ${item?.variantName}` : "")
                    const srProd = shipData?.products.find(p => {
                        return p?.sku == item?.sku || p?.sku == item?._id?.toString()
                            || p?.name == itemName
                            || p?.name == itemName.slice(0, 200)
                    });


                    if (srProd && srProd?.product_id) {
                        item.product_id = srProd?.product_id;
                        item.sku = srProd?.sku;
                    }

                    // console.log("item: ", item)
                });
            }
        } catch (srErr) {
            console.warn("Shiprocket product mapping warning:", srErr?.response?.data || srErr?.message);
        }
    }

    // return res.status(201).json(
    //     new ApiResponse(200, "Order response", validatedItems)
    // )

    const partialRequest = new PartialRequests({
        type: "Partial Return",
        isRaised: true,
        raisedAt: new Date().toISOString(),
        isResolved: false,
        status: "Pending",
        reason: reason || "Partial Return Requested",
        items: validatedItems,
        orderRef: order._id
    });

    await partialRequest.save();

    for (const reqItem of validatedItems) {
        const itemIdx = order.items.findIndex((it, index) => {
            return (reqItem?._id ? it?._id?.toString() == reqItem?._id?.toString() : false) ||
                (reqItem?.index
                    ? (it?.index == reqItem?.index || index == reqItem?.index) : false
                ) ||
                (reqItem?.productId ? (
                    (
                        it?.productId?._id?.toString() == reqItem?.productId?.toString() ||
                        it?.productId?._id?.toString() == reqItem?.productId?._id?.toString() ||
                        it?.productId?.toString() == reqItem?.productId?.toString()
                    ) &&
                    it?.variantName == reqItem?.variantName) &&
                    (it?.isScratchy?.toString() == reqItem?.isScratchy?.toString())
                    : false
                );
        });

        // console.log("itemIdx: ", itemIdx)
        if (itemIdx !== -1) {
            order.items[itemIdx].index = reqItem?.index;
            order.items[itemIdx].product_id = reqItem?.product_id;
            order.items[itemIdx].partialReturnRequest = partialRequest._id;
            order.items[itemIdx].returnStatus = "Pending";
            order.items[itemIdx].returnQuantity = reqItem?.quantity;
        }
    }

    order.partialReturnRequests.push(partialRequest._id);
    order.markModified("items");
    order.markModified("partialReturnRequests");
    await order.save();

    return res.status(201).json(
        new ApiResponse(201, { partialRequest, order }, "Partial return request raised successfully")
    );
});

/* ─────────────────────────────────────────────────────────────────────
   getPaginatedPartialRequests (v2)
───────────────────────────────────────────────────────────────────── */
export const getPaginatedPartialRequests = asyncHandler(async (req, res) => {
    const {
        page = 1,
        limit = 10,
        status,
        startDate,
        endDate
    } = req.query;

    const searchQuery = req?.query?.searchQuery?.trim();
    const parsedPage = Math.max(1, parseInt(page));
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (parsedPage - 1) * parsedLimit;

    const baseFilter = {};

    if (startDate && endDate) {
        baseFilter.createdAt = {
            $gte: new Date(`${startDate}T00:00:00+05:30`),
            $lte: new Date(`${endDate}T23:59:59.999+05:30`)
        };
    }

    if (searchQuery) {
        delete baseFilter.createdAt;
        const words = searchQuery.split(/\s+/).filter(Boolean);
        const regexArray = words.map(w => new RegExp(w, "i"));

        const matchingOrders = await Order.find({
            $or: [
                { orderId: { $in: regexArray } },
                { phoneNo: { $in: regexArray } }
            ]
        }).select("_id").lean();

        const matchingOrderIds = matchingOrders.map(o => o._id);

        baseFilter.$or = [
            { $and: regexArray.map(r => ({ reason: r })) },
            { orderRef: { $in: matchingOrderIds } }
        ];
    }

    const filter = { ...baseFilter };
    if (status && status !== "all") {
        filter.status = status;
    }

    const [
        requests,
        totalCount,
        pendingCount,
        acceptedCount,
        rejectedCount,
        holdCount
    ] = await Promise.all([
        PartialRequests.find(filter)
            .populate({
                path: "orderRef",
                select: "orderId phoneNo name email phone orderAmount method",
            })
            .populate("returnOrderRef", "-items -scans -returnData")
            .populate("resolvedBy", "name email phone role")
            .populate("reopenedBy", "name email phone role")
            .populate("holdBy", "name email phone role")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parsedLimit)
            .lean(),

        PartialRequests.countDocuments(baseFilter),
        PartialRequests.countDocuments({ ...baseFilter, status: "Pending" }),
        PartialRequests.countDocuments({ ...baseFilter, status: "Accepted" }),
        PartialRequests.countDocuments({ ...baseFilter, status: "Rejected" }),
        PartialRequests.countDocuments({ ...baseFilter, status: "Hold" }),
    ]);

    const totalPages = Math.ceil((status && status !== "all" ? requests.length : totalCount) / parsedLimit);

    return res.status(200).json(
        new ApiResponse(200, {
            requests,
            totalCount,
            pendingCount,
            acceptedCount,
            rejectedCount,
            holdCount,
            pagination: {
                page: parsedPage,
                limit: parsedLimit,
                totalPages,
                hasNextPage: parsedPage < totalPages,
                hasPrevPage: parsedPage > 1
            }
        }, "Partial return requests fetched successfully")
    );
});

/* ─────────────────────────────────────────────────────────────────────
   rejectPartialReturnRequest (v2)
───────────────────────────────────────────────────────────────────── */
export const rejectPartialReturnRequest = asyncHandler(async (req, res) => {
    const { requestId, reason } = req.body;

    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
        throw new ApiError(400, "Valid Request ID is required");
    }

    const partialRequest = await PartialRequests.findById(requestId);
    if (!partialRequest) {
        throw new ApiError(404, "Partial return request not found");
    }

    if (partialRequest.isResolved) {
        throw new ApiError(400, "Partial return request is already resolved");
    }

    partialRequest.status = "Rejected";
    partialRequest.isResolved = true;
    partialRequest.resolvedAt = new Date().toISOString();
    partialRequest.resolvedBy = req.user?._id;
    if (reason) {
        partialRequest.reason = `${partialRequest.reason || ''} [Rejection Reason: ${reason}]`;
    }
    await partialRequest.save();

    const order = await Order.findById(partialRequest.orderRef);
    if (order) {
        order.items.forEach(it => {
            if (it.partialReturnRequest?.toString() === partialRequest._id.toString()) {
                it.returnStatus = "Rejected";
                it.returnQuantity = undefined;
                it.partialReturnRequest = undefined;
            }
        });
        order.markModified("items");
        await order.save();
    }

    return res.status(200).json(
        new ApiResponse(200, { partialRequest }, "Partial return request rejected successfully")
    );
});

/* ─────────────────────────────────────────────────────────────────────
   holdPartialReturnRequest (v2)
───────────────────────────────────────────────────────────────────── */
export const holdPartialReturnRequest = asyncHandler(async (req, res) => {
    const { requestId } = req.body;

    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
        throw new ApiError(400, "Valid Request ID is required");
    }

    const partialRequest = await PartialRequests.findById(requestId);
    if (!partialRequest) {
        throw new ApiError(404, "Partial return request not found");
    }

    if (partialRequest.status !== "Pending") {
        throw new ApiError(400, "Only Pending requests can be placed on Hold");
    }

    partialRequest.status = "Hold";
    partialRequest.isResolved = false;
    partialRequest.holdBy = req.user?._id;
    partialRequest.holdAt = new Date();
    await partialRequest.save();

    const order = await Order.findById(partialRequest.orderRef);
    if (order) {
        order.items.forEach(it => {
            if (it.partialReturnRequest?.toString() === partialRequest._id.toString()) {
                it.returnStatus = "Pending";
            }
        });
        order.markModified("items");
        await order.save();
    }

    const updatedRequest = await PartialRequests.findById(requestId)
        .populate({
            path: "orderRef",
            select: "orderId userId phoneNo status shippingAddress totalAmount type",
            populate: { path: "userId", select: "name email phone role" }
        })
        .populate("returnOrderRef", "orderId status returnData shippingStatus")
        .populate("items.productId", "fullName photos price sku")
        .populate("replies.messagedBy", "name email phone role")
        .populate("resolvedBy", "name email phone role")
        .populate("reopenedBy", "name email phone role")
        .populate("holdBy", "name email phone role")
        .lean();

    return res.status(200).json(
        new ApiResponse(200, { partialRequest: updatedRequest }, "Partial return request placed on Hold successfully")
    );
});

/* ─────────────────────────────────────────────────────────────────────
   acceptPartialReturnRequest (v2)
───────────────────────────────────────────────────────────────────── */
export const acceptPartialReturnRequest = asyncHandler(async (req, res) => {
    const { requestId, phoneNo } = req.body;

    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
        throw new ApiError(400, "Valid Request ID is required");
    }

    const partialRequest = await PartialRequests.findById(requestId);
    if (!partialRequest) {
        throw new ApiError(404, "Partial return request not found");
    }

    if (partialRequest.isResolved) {
        throw new ApiError(400, "Partial return request is already resolved");
    }

    let order = await Order.findById(partialRequest.orderRef)
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate("addressId");

    if (!order) {
        throw new ApiError(404, "Parent order not found");
    }

    const session = await mongoose.startSession();
    let newReturnOrder = null;
    // return res.status(200).json(
    //     new ApiResponse(200, {}, "Partial return request accepted successfully")
    // );
    try {
        // Branch A: No Shiprocket Forward Order
        if (!order.shiprocketOrderId) {
            await session.withTransaction(async () => {
                const returnOrderIdStr = `PR${order?.returnOrderRef?.length + 1
                    }_${order.orderId}`;
                const totalReturnAmount = partialRequest?.items?.reduce((acc, it) => acc + (Number(it?.price) * Number(it?.quantity)), 0);

                newReturnOrder = new Order({
                    orderId: returnOrderIdStr,
                    type: ORDER_TYPES.PARTIAL_RETURN || "Partial Return",
                    status: "Returned",
                    userId: order?.userId?._id || order?.userId,
                    items: partialRequest?.items,
                    name: order?.name,
                    phoneNo: order?.phoneNo || phoneNo,
                    email: order?.email,
                    address: order?.address,
                    city: order?.city,
                    state: order?.state,
                    pincode: order?.pincode,
                    country: order?.country,
                    addressId: order?.addressId?._id || order?.addressId,
                    method: order?.method,
                    orderAmount: totalReturnAmount,
                    subtotal: totalReturnAmount,
                    shippingStatus: "Returned",
                    partialReturnRequests: [requestId]
                });

                await newReturnOrder.save({ session });

                // Link return order to User's orders array
                if (order?.userId) {
                    await User.findByIdAndUpdate(
                        order.userId?._id || order.userId,
                        { $addToSet: { orders: newReturnOrder._id } },
                        { session }
                    );
                }

                await adjustStock(newReturnOrder, {
                    type: STOCK_TYPES.RETURN,
                    session
                });

                partialRequest.status = "Accepted";
                partialRequest.isResolved = true;
                partialRequest.resolvedAt = new Date().toISOString();
                partialRequest.resolvedBy = req.user?._id;
                partialRequest.returnOrderRef = newReturnOrder._id;
                await partialRequest.save({ session });

                partialRequest?.items?.forEach(reqIt => {
                    const parentIt = order?.items?.find((it, index) => {
                        return (reqIt?._id ? it?._id?.toString() == reqIt?._id?.toString() : false) ||
                            (reqIt?.index
                                ? (it?.index == reqIt?.index || index == reqIt?.index) : false
                            ) ||
                            (reqIt?.productId ? (
                                (
                                    it?.productId?._id?.toString() == reqIt?.productId?.toString() ||
                                    it?.productId?._id?.toString() == reqIt?.productId?._id?.toString() ||
                                    it?.productId?.toString() == reqIt?.productId?.toString()
                                    // ||
                                    // it?.product_id == reqIt?.product_id
                                ) &&
                                it?.variantName == reqIt?.variantName) &&
                                (it?.isScratchy?.toString() == reqIt?.isScratchy?.toString())
                                : false
                            );
                    });
                    if (parentIt) {
                        parentIt.isReturned = true;
                        parentIt.returnStatus = "Returned";
                        parentIt.returnOrderRef = newReturnOrder._id;
                    }
                });

                order.returnOrderRef.push(newReturnOrder._id);
                order.markModified("items");
                order.markModified("returnOrderRef");
                await order.save({ session });
            });

            return res.status(200).json(
                new ApiResponse(200, { partialRequest, returnOrder: newReturnOrder }, "Partial return accepted successfully")
            );
        }

        // Branch B: Shiprocket Order Exists using service
        const orderData = await getShiprocketOrderDetails(order.shiprocketOrderId, req.shiprocketToken);
        if (!orderData) {
            throw new ApiError(404, "Shiprocket forward order details not found");
        }

        const order_items = partialRequest.items.map(reqIt => {
            const matchedSrProd = orderData?.products?.find(p => p?.product_id === reqIt?.product_id);
            let itemName = reqIt?.fullName + (reqIt?.variantName ? `\n , ${reqIt?.variantName}` : "")
            return {
                name: matchedSrProd?.name || itemName,
                sku: matchedSrProd?.sku || reqIt?.sku,
                selling_price: matchedSrProd?.selling_price || reqIt?.price,
                units: matchedSrProd?.quantity || reqIt?.quantity,
                qc_enable: false
            };
        });

        const returnOrderIdStr = `PR${order?.returnOrderRef?.length + 1}_${order.orderId}`;
        const totalReturnAmount = order_items.reduce((acc, it) => acc + (Number(it.selling_price) * Number(it.units)), 0);

        const payload = {
            order_id: returnOrderIdStr,
            order_date: orderData?.order_date,
            channel_id: orderData?.channel_id,
            pickup_customer_name: orderData?.customer_name,
            pickup_email: orderData?.customer_email,
            pickup_phone: order?.phoneNo || phoneNo || orderData?.customer_phone,
            pickup_address: orderData?.customer_address,
            pickup_address_2: orderData?.customer_address_2,
            pickup_city: orderData?.customer_city,
            pickup_state: orderData?.customer_state,
            pickup_country: orderData?.customer_country,
            pickup_pincode: orderData?.customer_pincode,
            shipping_customer_name: orderData?.pickup_address?.name,
            shipping_email: orderData?.pickup_address?.email,
            shipping_phone: orderData?.pickup_address?.phone,
            shipping_address: orderData?.pickup_address?.address,
            shipping_address_2: orderData?.pickup_address?.address_2,
            shipping_city: orderData?.pickup_address?.city,
            shipping_country: orderData?.pickup_address?.country,
            shipping_pincode: orderData?.pickup_address?.pin_code,
            shipping_state: orderData?.pickup_address?.state,
            order_items: order_items,
            payment_method: orderData?.payment_method,
            sub_total: totalReturnAmount,
            weight: orderData?.shipments?.weight || 0.5,
            length: orderData?.shipments?.length || 10,
            breadth: orderData?.shipments?.breadth || 10,
            height: orderData?.shipments?.height || 10,
            request_pickup: true
        };

        const data = await createShiprocketReturnOrder(payload, req.shiprocketToken);

        if (data?.status_code !== 21) {
            throw new ApiError(500, `Could not create partial return order on Shiprocket: ${data?.status || 'Failed'}`);
        }

        newReturnOrder = new Order({
            orderId: returnOrderIdStr,
            type: ORDER_TYPES.PARTIAL_RETURN || "Partial Return",
            status: "Return Initiated",
            userId: order.userId?._id || order.userId,
            items: partialRequest.items,
            name: order?.name,
            phoneNo: order?.phoneNo || phoneNo,
            email: order?.email,
            address: order?.address,
            city: order?.city,
            state: order?.state,
            pincode: order?.pincode,
            country: order?.country,
            addressId: order?.addressId?._id || order?.addressId,
            method: order?.method,
            orderAmount: totalReturnAmount,
            subtotal: totalReturnAmount,
            shipmentId: data?.shipment_id,
            shiprocketOrderId: data?.order_id,
            shiprocketChannelId: data?.channel_order_id,
            shiprocketOrderCreatedAt: new Date(),
            returnData: {
                ...data,
                isReturnInitiated: true,
                orderId: returnOrderIdStr,
                shippingStatus: "Return Order Created"
            },
            shippingStatus: data?.status || "Return Order Created",
            partialReturnRequests: [requestId]
        });

        await newReturnOrder.save();

        // Link return order to User's orders array
        if (order?.userId) {
            await User.findByIdAndUpdate(
                order.userId?._id || order.userId,
                { $addToSet: { orders: newReturnOrder._id } }
            );
        }

        partialRequest.status = "Accepted";
        partialRequest.isResolved = true;
        partialRequest.resolvedAt = new Date().toISOString();
        partialRequest.resolvedBy = req.user?._id;
        partialRequest.returnOrderRef = newReturnOrder._id;
        await partialRequest.save();

        partialRequest.items.forEach(reqIt => {
            const parentIt = order.items.find((it, index) => {
                return (reqIt?._id ? it?._id?.toString() == reqIt?._id?.toString() : false) ||
                    (reqIt?.index
                        ? (it?.index == reqIt?.index || index == reqIt?.index) : false
                    ) ||
                    (reqIt?.productId ? (
                        (
                            it?.productId?._id?.toString() == reqIt?.productId?.toString() ||
                            it?.productId?._id?.toString() == reqIt?.productId?._id?.toString() ||
                            it?.productId?.toString() == reqIt?.productId?.toString()
                            // ||
                            // it?.product_id == reqIt?.product_id
                        ) &&
                        it?.variantName == reqIt?.variantName) &&
                        (it?.isScratchy?.toString() == reqIt?.isScratchy?.toString())
                        : false
                    );
            });
            if (parentIt) {
                // parentIt.isReturned = true;
                parentIt.returnStatus = "Return Accepted";
                parentIt.returnOrderRef = newReturnOrder._id;
            }
        });

        order.returnOrderRef.push(newReturnOrder._id);
        order.markModified("items");
        order.markModified("returnOrderRef");
        await order.save();

        return res.status(200).json(
            new ApiResponse(200, { partialRequest, returnOrder: newReturnOrder }, "Partial Return Order created with Shiprocket successfully")
        );

    } finally {
        session.endSession();
    }
});

/* ─────────────────────────────────────────────────────────────────────
   getPartialReturnRequestById (v2)
───────────────────────────────────────────────────────────────────── */
export const getPartialReturnRequestById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        throw new ApiError(400, "Valid Request ID is required");
    }

    const partialRequest = await PartialRequests.findById(id)
        .populate({
            path: "orderRef",
            populate: [
                { path: "userId", select: "name email phone role" },
                { path: "addressId" },
                {
                    path: "items.productId",
                    select: "name fullName images photos price sku"
                }
            ]
        })
        .populate({
            path: "returnOrderRef",
            populate: [
                { path: "userId", select: "name email phone role" },
                { path: "addressId" },
                {
                    path: "items.productId",
                    select: "name fullName images photos price sku"
                }
            ]
        })
        .populate("items.productId", "name fullName images photos price sku")
        .populate("replies.messagedBy", "name email phone role")
        .populate("resolvedBy", "name email phone role")
        .populate("reopenedBy", "name email phone role")
        .populate("holdBy", "name email phone role")
        .lean();

    if (!partialRequest) {
        throw new ApiError(404, "Partial return request not found");
    }

    return res.status(200).json(
        new ApiResponse(200, { partialRequest }, "Partial return request fetched successfully")
    );
});

/* ─────────────────────────────────────────────────────────────────────
   sendPartialReturnReply (v2)
───────────────────────────────────────────────────────────────────── */
export const sendPartialReturnReply = asyncHandler(async (req, res) => {
    const { requestId, message } = req.body;

    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
        throw new ApiError(400, "Valid Request ID is required");
    }

    if (!message || message.trim() === "") {
        throw new ApiError(400, "Message content cannot be empty");
    }

    const partialRequest = await PartialRequests.findById(requestId);
    if (!partialRequest) {
        throw new ApiError(404, "Partial return request not found");
    }

    const reply = {
        message: message.trim(),
        messagedBy: req.user._id,
        messagedAt: new Date()
    };

    partialRequest.replies.push(reply);
    await partialRequest.save();

    const updatedRequest = await PartialRequests.findById(requestId)
        .populate({
            path: "orderRef",
            select: "orderId userId phoneNo status shippingAddress totalAmount type",
            populate: { path: "userId", select: "name email phone role" }
        })
        .populate("returnOrderRef", "orderId status returnData shippingStatus")
        .populate("items.productId", "fullName photos price sku")
        .populate("replies.messagedBy", "name email phone role")
        .populate("resolvedBy", "name email phone role")
        .populate("reopenedBy", "name email phone role")
        .populate("holdBy", "name email phone role")
        .lean();

    return res.status(200).json(
        new ApiResponse(200, { partialRequest: updatedRequest }, "Reply sent successfully")
    );
});

/* ─────────────────────────────────────────────────────────────────────
   getPartialReturnRequestsByOrderId (v2)
───────────────────────────────────────────────────────────────────── */
export const getPartialReturnRequestsByOrderId = asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        throw new ApiError(400, "Valid Order ID is required");
    }

    const requests = await PartialRequests.find({ orderRef: orderId })
        // .populate("items.productId", "name fullName images")
        // .populate("replies.messagedBy", "name email phone role")
        .lean();

    return res.status(200).json(
        new ApiResponse(200, { requests }, "Partial return requests fetched successfully")
    );
});

/* ─────────────────────────────────────────────────────────────────────
   initiateOrderRefund (v2)
   Triggers payment gateway refund for online orders (Razorpay/PhonePe)
───────────────────────────────────────────────────────────────────── */
export const initiateOrderRefund = asyncHandler(async (req, res) => {
    const { orderId, refundAmount } = req.body;

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        throw new ApiError(400, "Valid Order ID is required");
    }

    const parsedRefundAmount = parseFloat(refundAmount);
    if (isNaN(parsedRefundAmount) || parsedRefundAmount <= 0) {
        throw new ApiError(400, "Refund amount must be a positive number");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (parsedRefundAmount > order.orderAmount) {
        throw new ApiError(400, `Refund amount cannot exceed total order amount (₹${order.orderAmount.toFixed(2)})`);
    }

    // Determine the gateway
    let refundResult = null;
    let gatewayUsed = null;

    if (order.razorpayPaymentId) {
        gatewayUsed = "razorpay";
        refundResult = await refundRazorpayPayment(order.razorpayPaymentId, parsedRefundAmount);
    } else if (order.phonepeOrderId) {
        gatewayUsed = "phonepe";
        refundResult = await refundPhonepePayment(order.phonepeOrderId, parsedRefundAmount);
    } else {
        throw new ApiError(400, "No active online payment gateway details found for this order.");
    }

    if (!refundResult.success) {
        const errMsg = typeof refundResult.error === 'object'
            ? refundResult.error.description || JSON.stringify(refundResult.error)
            : refundResult.error;
        throw new ApiError(502, `Gateway refund failed: ${errMsg}`);
    }

    // Save refund details to database
    order.refundId = refundResult.refundId;
    order.refundAmount = parsedRefundAmount;
    order.refundStatus = "Success";
    order.refundedAt = new Date();
    order.refundedBy = req.user?._id;
    await order.save();

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                refundId: refundResult.refundId,
                refundAmount: parsedRefundAmount,
                refundStatus: "Success",
                gateway: gatewayUsed
            },
            "Refund initiated successfully via gateway"
        )
    );
});

/* ─────────────────────────────────────────────────────────────────────
   reopenPartialReturnRequest (v2)
───────────────────────────────────────────────────────────────────── */
export const reopenPartialReturnRequest = asyncHandler(async (req, res) => {
    const { requestId } = req.body;

    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
        throw new ApiError(400, "Valid Request ID is required");
    }

    const partialRequest = await PartialRequests.findById(requestId);
    if (!partialRequest) {
        throw new ApiError(404, "Partial return request not found");
    }

    partialRequest.status = "Pending";
    partialRequest.isResolved = false;
    partialRequest.reopenedBy = req.user?._id;
    partialRequest.reopenedAt = new Date();
    // partialRequest.resolvedBy = undefined;
    // partialRequest.resolvedAt = undefined;
    partialRequest.holdBy = undefined;
    partialRequest.holdAt = undefined;

    await partialRequest.save();

    const order = await Order.findById(partialRequest.orderRef);
    if (order) {
        order.items.forEach(it => {
            if (it.partialReturnRequest?.toString() === partialRequest._id.toString()) {
                it.returnStatus = "Pending";
            }
        });
        order.markModified("items");
        await order.save();
    }

    const updatedRequest = await PartialRequests.findById(requestId)
        .populate({
            path: "orderRef",
            select: "orderId userId phoneNo status shippingAddress totalAmount type",
            populate: { path: "userId", select: "name email phone role" }
        })
        .populate("returnOrderRef", "orderId status returnData shippingStatus")
        .populate("items.productId", "fullName photos price sku")
        .populate("replies.messagedBy", "name email phone role")
        .lean();

    return res.status(200).json(
        new ApiResponse(200, { partialRequest: updatedRequest }, "Partial return request reopened successfully")
    );
});

export {
    createPosOrder,
    cancelPosOrder,
    adjustStock,
    createOnlineOrderV2,
    phonepeCallbackV2
};
