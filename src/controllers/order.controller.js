import mongoose from 'mongoose';
import Razorpay from 'razorpay';
import axios from 'axios';
import crypto from 'crypto';
import { v4 as uuidv4 } from "uuid";
import { Order } from "../models/order.model.js";
import { Payment } from "../models/payment.model.js";
import { ActivityLog } from "../models/activity_log.model.js";
import { Cart } from "../models/cart.model.js";
import { Product } from '../models/product.model.js';   // <-- import Product
import { Quotation } from '../models/quotation.model.js';
import { Variant } from '../models/variant.model.js';
import { Inventory } from '../models/inventory.model.js';
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/user.model.js";
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkPickupStatus } from './shiprocket.controller.js';
import { Address } from '../models/address.model.js';
import { isNumber } from 'razorpay/dist/utils/razorpay-utils.js';
import { PaymentLink } from '../models/payment_link.model.js';
import { Coupon } from '../models/coupon.model.js';
import ExcelJS from "exceljs";
import { flattenOrder } from '../utils/flattenOrder.js'; // keep your util
import { Counter } from './../models/counter.model.js';
import { Stock } from '../models/stock.model.js';
import { STOCK_TYPES, ORDER_TYPES } from '../constants.js';
import { initiateRazorpayPaymentLink } from '../services/razorpay.service.js';
import { initiatePhonepePaymentLink } from '../services/phonepe.service.js';
import { CompanyDetails } from '../models/company_details.model.js';
import { recalculateOrderTotals, syncItemDiscount, determineSlabForQuantity } from '../utils/pricing.js';
import { logActivity } from "../utils/activityLogger.js";

const razorpayConfig = () => {
    const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    return razorpay;
}

// ******************************************************
//                  PLACE, ACCEPT, REJECT ORDER CONTROLLERS
// ******************************************************

const paymentLinkWebhook = asyncHandler(async (req, res) => {
    console.log("Payment Webhook called:", req.body);
    const secret = process.env.RAZORPAY_KEY_SECRET;

    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(JSON.stringify(req.body))
        .digest("hex");

    const signature = req.headers["x-razorpay-signature"];


    if (expectedSignature === signature) {

        const event = req.body;
        const paymentLink = event?.payload?.payment_link?.entity;
        const payment = event?.payload?.payment?.entity;
        const paymentLinkId = paymentLink?.id;
        // const referenceId = paymentLink.reference_id;
        const status = paymentLink?.status;

        // console.log("✅ Payment Link Paid:");
        // console.log("Payment Link ID:", paymentLinkId);
        // console.log("Reference ID:", referenceId);
        console.log("Payment Link:", paymentLink);
        console.log("Payment:", payment);
        console.log("Status:", status);

        const foundPaymentLink = await PaymentLink.findOneAndUpdate(
            {
                // orderId: paymentLink?.notes?.orderId,
                paymentLink_id: paymentLinkId
            },
            { status },
            { new: true }
        );

        if (event.event === "payment_link.paid") {
            const paymentDate = new Date();
            const orderId = paymentLink?.notes?.orderId || foundPaymentLink?.orderId;
            const updatedOrder = await Order.findByIdAndUpdate(
                orderId,
                {
                    abondonedOrder: false,
                    razorpayOrderId: paymentLink?.order_id,
                    razorpayPaymentId: payment?.id,
                    paymentStatus: "Paid",
                    paymentDate
                },
                { new: true }
            );

            if (foundPaymentLink && foundPaymentLink.referenceId) {
                await Payment.findByIdAndUpdate(
                    foundPaymentLink.referenceId,
                    {
                        status: "Paid",
                        paidAt: paymentDate,
                        notes: `Paid via Razorpay Link. Transaction ID: ${payment?.id}`
                    }
                );
            }
        }

        // Update order status based on payment_link.paid or failed
        res.status(200).json({ status: "Webhook verified" });
    } else {
        res.status(400).json({ error: "Invalid signature" });
    }
});


const createPosOrder = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();

    try {
        const {
            userId,
            name, phoneNo, email,
            address, address2, city, state, pincode, country,
            gst,
            method,
            paymentMode,
            subtotal,
            discount = 0,
            discountPercent = 0,
            deliveryCharge = 0,
            orderAmount,
            comments,
            items
        } = req.body;

        if (!userId || !name || !phoneNo || !orderAmount || !items || !method || !paymentMode) {
            throw new ApiError(400, 'Required checkout details not found.');
        }

        // Auto-calculate and sync discount/discountPercent
        const subtotalFixed = parseFloat((subtotal || 0).toFixed(2));
        let flatDiscount = Number(discount || 0);
        let percentDiscount = Number(discountPercent || 0);

        if (percentDiscount > 0 && flatDiscount === 0) {
            flatDiscount = parseFloat(((subtotalFixed * percentDiscount) / 100).toFixed(2));
        } else if (flatDiscount > 0 && percentDiscount === 0) {
            percentDiscount = subtotalFixed > 0 ? parseFloat(((flatDiscount / subtotalFixed) * 100).toFixed(2)) : 0;
        } else if (flatDiscount > 0 && percentDiscount > 0) {
            percentDiscount = subtotalFixed > 0 ? parseFloat(((flatDiscount / subtotalFixed) * 100).toFixed(2)) : 0;
        }

        const deliveryChargeFixed = parseFloat((deliveryCharge || 0).toFixed(2));
        const finalOrderAmount = parseFloat((Math.max(0, subtotalFixed - flatDiscount) + deliveryChargeFixed).toFixed(2));

        let newQuote = new Quotation({
            userId,
            name: name.trim(),
            email: email?.trim() || "",
            phoneNo: phoneNo.trim(),
            comments: comments || "",
            address,
            address2,
            city,
            state,
            country: country || "India",
            pincode,
            subtotal: subtotalFixed,
            discount: parseFloat(flatDiscount.toFixed(2)),
            discountPercent: parseFloat(percentDiscount.toFixed(2)),
            deliveryCharge: deliveryChargeFixed,
            orderAmount: finalOrderAmount,
            method,
            paymentMode,
            status: "New",
            type: "Pos",
            items
        });

        let updatedUser = null;
        await session.withTransaction(async () => {
            // Save the Quotation (triggers QT_XXXXXX id generation)
            await newQuote.save({ session });

            const stockEntries = [];

            for (const item of newQuote.items) {
                const qty = Math.floor(Number(item.quantity));
                if (qty <= 0) continue;

                // 1. Atomically find and decrement availableStock on the Variant collection
                const variant = await Variant.findOneAndUpdate(
                    {
                        productId: item.productId,
                        name: item.variantName,
                        active: true,
                        availableStock: { $gte: qty }
                    },
                    {
                        $inc: { availableStock: -qty }
                    },
                    { new: true, session }
                );

                if (!variant) {
                    throw new ApiError(400, `Insufficient available stock for variant "${item.variantName}".`);
                }

                // 2. Atomically find and decrement availableStock on parent Product
                const parentProduct = await Product.findOneAndUpdate(
                    { _id: item.productId, availableStock: { $gte: qty } },
                    { $inc: { availableStock: -qty } },
                    { new: true, session }
                );

                if (!parentProduct) {
                    throw new ApiError(400, `Insufficient available stock for parent product.`);
                }

                const currentTotalProductStock = parentProduct.totalProductStock || parentProduct.totalStock || 0;

                // 3. Atomically update/upsert Inventory (Reserved Stock)
                const inventory = await Inventory.findOneAndUpdate(
                    { product: item.productId },
                    { $inc: { reservedStock: qty } },
                    { new: true, upsert: true, setDefaultsOnInsert: true, session }
                );

                // Sync variant ids & avg purchase price on Quotation items
                const quoteItem = newQuote.items.find(i => String(i.productId) === String(item.productId) && i.variantName === item.variantName);
                if (quoteItem) {
                    quoteItem.purchasePrice = item.price; // directly use items price (prefilled from slab)
                    quoteItem.variantId = variant._id;
                    quoteItem.sku = String(variant._id);
                }

                // Queue Stock Log (Virtual Category - reserved)
                stockEntries.push({
                    quotationId: newQuote.quotationId,
                    quotationRef: newQuote._id,
                    type: STOCK_TYPES.RESERVED,
                    category: "virtual",
                    variantId: variant._id,
                    variantName: variant.name,
                    purchasePrice: item.purchasePrice || 0,
                    quantity: qty,
                    previousStock: variant.availableStock + qty,
                    updatedStock: variant.availableStock,
                    previousPhysicalStock: variant.totalStock,
                    updatedPhysicalStock: variant.totalStock,
                    totalProductStock: currentTotalProductStock,
                    productId: item.productId
                });
            }

            // Save Quotation item updates
            await newQuote.save({ session });

            // Write Stock logs
            if (stockEntries.length > 0) {
                await Stock.insertMany(stockEntries, { session });
            }

            // Finding unique product ids and then add quotation ref
            const uniqueProductIds = new Set();
            newQuote.items.forEach(it => {
                if (it.productId) {
                    uniqueProductIds.add(it.productId.toString());
                }
            });

            const productQuotationOps = Array.from(uniqueProductIds).map(productId => ({
                updateOne: {
                    filter: { _id: productId },
                    update: { $push: { quotations: newQuote._id } }
                }
            }));

            if (productQuotationOps.length > 0) {
                await Product.bulkWrite(productQuotationOps, { session });
            }

            // Add quotation to user's quotations list
            updatedUser = await User.findByIdAndUpdate(
                userId,
                { $push: { quotations: newQuote._id } },
                { new: true, session }
            ).select('-password -refreshToken')
                .populate("wishlist")
                .populate("address")
                .populate("orders")
                .populate("quotations")
                .exec();

            if (!updatedUser) throw new ApiError(500, "Failed to update user quotations");
        });

        return res.status(201).json(
            new ApiResponse(201, { quotation: newQuote, user: updatedUser }, "POS Quotation Placed Successfully")
        );

    } catch (err) {
        console.error('Error placing POS Quotation:', err.message);
        return res.status(500).json({ message: err.message || 'Internal server error' });
    } finally {
        session.endSession();
    }
});

const createManualOrder = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();

    try {
        const {
            userId,
            name, email, phoneNo,
            comments,
            orderAmount,
            gst,
            discount = 0,
            discountPercent = 0,
            subtotal,
            method = 'COD',
            items,
            deliveryCharge = 0,
            address,
            address2,
            city,
            state,
            country = "India",
            pincode
        } = req.body;

        if (
            !userId ||
            !name || !phoneNo ||
            !orderAmount ||
            !subtotal ||
            !address || !city || !state ||
            !country || !pincode ||
            !method || !items
        ) {
            throw new ApiError(400, 'Required details not found.');
        }

        // Auto-calculate and sync discount/discountPercent
        const subtotalFixed = parseFloat((subtotal || 0).toFixed(2));
        let flatDiscount = Number(discount || 0);
        let percentDiscount = Number(discountPercent || 0);

        if (percentDiscount > 0 && flatDiscount === 0) {
            flatDiscount = parseFloat(((subtotalFixed * percentDiscount) / 100).toFixed(2));
        } else if (flatDiscount > 0 && percentDiscount === 0) {
            percentDiscount = subtotalFixed > 0 ? parseFloat(((flatDiscount / subtotalFixed) * 100).toFixed(2)) : 0;
        } else if (flatDiscount > 0 && percentDiscount > 0) {
            percentDiscount = subtotalFixed > 0 ? parseFloat(((flatDiscount / subtotalFixed) * 100).toFixed(2)) : 0;
        }

        const deliveryChargeFixed = parseFloat((deliveryCharge || 0).toFixed(2));
        const finalOrderAmount = parseFloat((Math.max(0, subtotalFixed - flatDiscount) + deliveryChargeFixed).toFixed(2));

        const paymentDate = (method == "Cash" || method == "Online") ? new Date() : null;
        const newOrderDoc = new Order({
            userId,
            name: name.trim(),
            phoneNo: phoneNo.trim(),
            email: email?.trim(),
            comments: comments?.trim(),
            method,
            type: 'Regular',
            status: 'New',
            orderState: "Confirmed",
            paymentStatus: 'Pending',
            paymentDate,
            orderId: uuidv4().split('-')[0].toUpperCase(),
            items,
            orderAmount: finalOrderAmount,
            discount: parseFloat(flatDiscount.toFixed(2)),
            discountPercent: parseFloat(percentDiscount.toFixed(2)),
            gst,
            subtotal: subtotalFixed,
            deliveryCharge: deliveryChargeFixed,
            address: `${address}, ${address2}, ${city}, ${state}, ${pincode}`,
            address: address?.trim(),
            address2: address2?.trim() || 0,
            city: city?.trim(),
            state: state?.trim(),
            country: country?.trim(),
            pincode: pincode?.trim()
        });

        let updatedUser = null;
        await session.withTransaction(async () => {
            // Save order
            await newOrderDoc.save({ session });

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

                const variantResult = await Variant.findOneAndUpdate(
                    {
                        productId: item.productId,
                        name: variantKey,
                        active: true,
                        totalStock: { $gte: qty },
                        availableStock: { $gte: qty }
                    },
                    {
                        $inc: {
                            totalStock: -qty,
                            availableStock: -qty
                        }
                    },
                    { new: true, session }
                );

                if (!variantResult) {
                    throw new ApiError(400, `Insufficient stock or variant "${variantKey}" not found`);
                }

                const productResult = await Product.findOneAndUpdate(
                    {
                        _id: item.productId,
                        totalStock: { $gte: qty },
                        availableStock: { $gte: qty }
                    },
                    {
                        $inc: {
                            totalStock: -qty,
                            availableStock: -qty
                        }
                    },
                    { new: true, session }
                );

                if (!productResult) {
                    throw new ApiError(400, `Insufficient stock or parent product "${item.productId}" not found`);
                }

                const updatedStock = variantResult.totalStock;
                const previousStock = updatedStock + qty;

                stockEntries.push({
                    orderId: newOrderDoc.orderId,
                    orderRef: newOrderDoc._id,
                    type: STOCK_TYPES.PURCHASE,
                    variantName: variantKey,
                    purchasePrice: item.purchasePrice || 0,
                    quantity: qty,
                    previousStock,
                    updatedStock,
                    productId: item.productId
                });
            }

            if (stockEntries.length > 0) {
                await Stock.insertMany(stockEntries, { session });
            }

            // for (const item of newOrderDoc.items) {
            //     const qty = Math.floor(Number(item.quantity));
            //     if (!Number.isInteger(qty) || qty <= 0) {
            //         throw new ApiError(400, `Invalid quantity for product ${item.productId}`);
            //     }

            //     const variantKey = String(item.variantName || "").trim();
            //     if (!variantKey) {
            //         throw new ApiError(400, `Missing variantName for product ${item.productId}`);
            //     }

            //     // ✅ Pehle atomic decrement
            //     const result = await Product.updateOne(
            //         {
            //             _id: item.productId,
            //             totalStock: { $gte: qty },
            //             [`variants.${variantKey}`]: { $gte: qty }
            //         },
            //         {
            //             $inc: {
            //                 totalStock: -qty,
            //                 [`variants.${variantKey}`]: -qty
            //             }
            //         },
            //         { session }
            //     );

            //     if (!result || result.modifiedCount === 0) {
            //         throw new ApiError(400, `Insufficient stock or variant "${variantKey}" not found`);
            //     }

            //     // ✅ Decrement ke baad fresh read
            //     const freshProduct = await Product.findById(item.productId)
            //         .session(session)
            //         .select("variants totalStock");

            //     const updatedStock = freshProduct.variants.get(variantKey);
            //     const previousStock = updatedStock + qty;

            //     stockEntries.push({
            //         orderId: newOrderDoc.orderId,
            //         type: STOCK_TYPES.PURCHASE,  // POS wale mein "purchase" string tha — yeh consistent karo
            //         variantName: variantKey,
            //         purchasePrice: item.price,
            //         quantity: qty,
            //         previousStock,
            //         updatedStock,
            //         productId: item.productId
            //     });
            // }

            // // ✅ Saare items ke baad ek saath insert
            // if (stockEntries.length > 0) {
            //     await Stock.insertMany(stockEntries, { session });
            // }

            // ✅ Add order to each product

            //Finding unique product ids and then add them


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
            ).select('-password -refreshToken')
                .populate({
                    path: "cart",
                    populate: {
                        path: "items.productId",
                        model: "Product",
                        populate: {
                            path: "category",  // This is the key part
                            model: "SubCategory"
                        }
                    }
                })
                .populate("wishlist")
                .populate("address")
                .populate("orders")
                .exec();

            if (!updatedUser) throw new ApiError(500, "Failed to update user orders");

        });

        return res.status(201).json(
            new ApiResponse(201, { order: newOrderDoc, user: updatedUser }, "Order Placed Successfully")
        );

    } catch (err) {
        console.error('Error placing order:', err.message);
        return res.status(500).json({ message: err.message || 'Internal server error' });
    } finally {
        session.endSession();
    }
});

const createCodOrder = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();

    try {
        let {
            userId, cartId,
            name, email, phoneNo,
            orderAmount,
            discount,
            coupon,
            comments,
            deliveryCharge = 0,
            gst,
            subtotal,
            address,
            addressId,
            method = 'COD',
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

            console.log("Start UTC:", start.toISOString());
            console.log("End UTC:", end.toISOString());
            console.log("Now UTC:", new Date(now).toISOString());

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
            }
            // console.log("Coupon: ", couponData)
        }

        cartId = req?.user?.cart;
        if (
            !userId || !address || !cartId ||
            !name || !phoneNo ||
            // !orderAmount ||
            // !gst || 
            !subtotal || !method
        ) {
            throw new ApiError(400, 'Required details not found.');
        }
        if (
            deliveryCharge == undefined || deliveryCharge == null || deliveryCharge < 0
        ) {
            throw new ApiError(400, 'Delivery charge cannot be negative.');
        }

        if (+orderAmount > 5000)
            throw new ApiError(400, "COD Order cannot be above Rs.5000");

        const cart = await Cart.findOne({ _id: cartId }).populate('items.productId');
        if (!cart || cart.items.length === 0) {
            throw new ApiError(400, 'Cart is empty or not found.');
        }

        // console.log('Cart Items:', cart.items.map(it => ({
        //     quantity: it.quantity,
        //     variantName: it.variantName,
        //     productId: it.productId,
        //     productIdType: typeof it.productId,
        //     productPopulated: it.productId?._id
        // })));

        const foundAddress = await Address.findById(addressId);

        const addressDetails = {
            address: `${foundAddress?.street || ""}, ${foundAddress?.street2 || ""}, ${foundAddress?.city || ""}, ${foundAddress?.state || ""}, ${foundAddress?.pinCode || ""}`,
            address2: foundAddress?.street2,
            city: foundAddress?.city,
            state: foundAddress?.state,
            country: foundAddress?.country,
            pincode: foundAddress?.pinCode
        }
        let newOrderDoc = new Order({
            ...couponData,
            ...addressDetails,
            userId,
            name: name.trim(),
            email: email.trim(),
            phoneNo: phoneNo.trim(),
            // address,
            comments,
            addressId,
            method,
            type: 'Regular',
            status: 'New',
            paymentStatus: 'Pending',
            isAppOrder,
            orderState: "Confirmed",
            abondonedOrder: false,
            orderId: uuidv4().split('-')[0].toUpperCase(),
            orderAmount,
            // discount,
            deliveryCharge,
            gst,
            subtotal,
            items: cart.items
        });

        // Recalculate subtotal and deliveryCharge
        let subtotal_amount = 0;
        const categoryCharges = new Map();

        for (const item of newOrderDoc.items) {
            const prod = await Product.findOne({ _id: item.productId._id })
                .populate("category")
                .exec();

            if (!prod || !prod.category) {
                throw new ApiError(400, `Product or category missing for ${item.productId}`);
            }

            subtotal_amount += (item.price - (item.discount || 0)) * item.quantity;

            const categoryId = prod.category._id.toString();
            const deliveryCharge = prod.category.deliveryCharge || 0;

            // console.log("charges", deliveryCharge);
            // console.log("category", categoryId);
            if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
                categoryCharges.set(categoryId, deliveryCharge);
            }
        }
        let values = Array.from(categoryCharges.values());
        let totalDeliveryCharge = Math.max(...values);

        if (!isFinite(totalDeliveryCharge) || totalDeliveryCharge === undefined) {
            totalDeliveryCharge = 0;
        }

        // console.log("delivery charge", totalDeliveryCharge);
        // console.log("subtotal", subtotal_amount);

        newOrderDoc.subtotal = subtotal_amount;
        newOrderDoc.deliveryCharge = totalDeliveryCharge;

        let discountedAmount = 0
        if (findCoupon) {
            discountedAmount = subtotal_amount * (parseFloat(findCoupon?.percent) * 0.01);
            discountedAmount = parseFloat(discountedAmount.toFixed(2));
            if (discountedAmount >= findCoupon?.value) {
                discountedAmount = parseFloat(findCoupon?.value);
            }
        }

        newOrderDoc.discount = discountedAmount;
        newOrderDoc.orderAmount = (subtotal_amount - (discountedAmount || 0) + totalDeliveryCharge).toFixed(2);

        if (newOrderDoc?.orderAmount > 5000)
            throw new ApiError(400, "COD Order cannot be above Rs.5000");

        // console.log("order Amount", newOrderDoc.orderAmount);

        // newOrderDoc = await newOrderDoc.save();

        let updatedUser = null;
        await session.withTransaction(async () => {
            // Save order
            await newOrderDoc.save({ session });

            // collect product ids from cart items
            const productIds = [
                ...new Set(cart.items.map(it => (it.productId._id || it.productId).toString()))
            ];

            // fetch relevant products (only variants needed)
            const products = await Product.find({ _id: { $in: productIds } })
                .session(session)
                .select('variants')
                .lean();

            // map id -> product
            const productMap = new Map(products.map(p => [p._id.toString(), p]));

            const stockEntries = [];

            for (const it of cart.items) {
                const productId = (it.productId._id || it.productId).toString();

                const qty = Math.floor(Number(it.quantity));
                if (!Number.isInteger(qty) || qty <= 0) {
                    throw new ApiError(400, `Invalid quantity for product ${productId}: ${it.quantity}`);
                }

                const requestedVariant = String(it.variantName || '').trim();
                if (!requestedVariant) {
                    throw new ApiError(400, `Missing variantName for product ${productId}`);
                }

                const variantResult = await Variant.findOneAndUpdate(
                    {
                        productId: productId,
                        name: requestedVariant,
                        active: true,
                        totalStock: { $gte: qty },
                        availableStock: { $gte: qty }
                    },
                    {
                        $inc: {
                            totalStock: -qty,
                            availableStock: -qty
                        }
                    },
                    { new: true, session }
                );

                if (!variantResult) {
                    throw new ApiError(400, `Insufficient stock or variant "${requestedVariant}" not found`);
                }

                const productResult = await Product.findOneAndUpdate(
                    {
                        _id: productId,
                        totalStock: { $gte: qty },
                        availableStock: { $gte: qty }
                    },
                    {
                        $inc: {
                            totalStock: -qty,
                            availableStock: -qty
                        }
                    },
                    { new: true, session }
                );

                if (!productResult) {
                    throw new ApiError(400, `Insufficient stock or parent product "${productId}" not found`);
                }

                const updatedStock = variantResult.totalStock;
                const previousStock = updatedStock + qty;

                stockEntries.push({
                    orderId: newOrderDoc.orderId,
                    orderRef: newOrderDoc._id,
                    type: STOCK_TYPES.PURCHASE,
                    variantName: requestedVariant,
                    purchasePrice: it.purchasePrice || 0,
                    quantity: qty,
                    previousStock,
                    updatedStock,
                    productId
                });
            }

            if (stockEntries.length > 0) {
                await Stock.insertMany(stockEntries, { session });
            }

            // for (const it of cart.items) {
            //     const productId = (it.productId._id || it.productId).toString();

            //     // parse & validate quantity
            //     const qty = Math.floor(Number(it.quantity));
            //     if (!Number.isInteger(qty) || qty <= 0) {
            //         throw new ApiError(400, `Invalid quantity for product ${productId}: ${it.quantity}`);
            //     }

            //     const requestedVariant = String(it.variantName || '').trim();
            //     if (!requestedVariant) {
            //         throw new ApiError(400, `Missing variantName for product ${productId}`);
            //     }

            //     // Atomic decrement
            //     const result = await Product.updateOne(
            //         {
            //             _id: productId,
            //             totalStock: { $gte: qty },
            //             [`variants.${requestedVariant}`]: { $gte: qty }
            //         },
            //         {
            //             $inc: {
            //                 totalStock: -qty,
            //                 [`variants.${requestedVariant}`]: -qty
            //             }
            //         },
            //         { session }
            //     );

            //     if (!result || result.modifiedCount === 0) {
            //         throw new ApiError(400, `Insufficient stock or variant "${requestedVariant}" not found`);
            //     }

            //     // ✅ Decrement ke baad fresh read
            //     // const freshProduct = await Product.findById(productId)
            //     //     .session(session)
            //     //     .select("variants totalStock");

            //     const updatedStock = result.variants.get(requestedVariant);
            //     const previousStock = updatedStock + qty;

            //     stockEntries.push({
            //         orderId: newOrderDoc.orderId,
            //         type: STOCK_TYPES.PURCHASE,
            //         variantName: requestedVariant,
            //         purchasePrice: it.price,
            //         quantity: qty,
            //         previousStock,
            //         updatedStock,
            //         productId
            //     });
            // }

            // // ✅ Saare items process hone ke baad ek saath insert
            // if (stockEntries.length > 0) {
            //     await Stock.insertMany(stockEntries, { session });
            // }


            // ✅ Add order to each product

            //Finding unique product ids and then add them

            const uniqueProductIds = new Set();
            cart.items.forEach(it => {
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

            // Clear cart
            cart.items = [];
            cart.totalCartValue = 0;
            await cart.save({ session });

            if (coupon) {
                let foundCoupon = await Coupon.findById(coupon);
                if (!foundCoupon) {
                    throw new Error(404, "Coupon not found");
                }
                if (foundCoupon?.type == "oneTime" || foundCoupon?.type == "oneTimeUser") {
                    foundCoupon.appliedBy = [
                        ...foundCoupon?.appliedBy,
                        {
                            user: req?.user?._id,
                            order: newOrderDoc._id
                        }
                    ]
                    await foundCoupon.save({ session })
                }
            }

            // Add order to user
            updatedUser = await User.findByIdAndUpdate(
                req?.user?._id,
                { $push: { orders: newOrderDoc._id } },
                { new: true, session }
            ).select('-password -refreshToken')
                .populate({
                    path: "cart",
                    populate: {
                        path: "items.productId",
                        model: "Product",
                        populate: {
                            path: "category",  // This is the key part
                            model: "SubCategory"
                        }
                    }
                })
                .populate("wishlist")
                .populate("address")
                .populate("orders")
                .exec();

            if (!updatedUser) throw new ApiError(500, "Failed to update user orders");

        });

        return res.status(201).json(
            new ApiResponse(201, { order: newOrderDoc, user: updatedUser }, "Order Placed Successfully")
        );

    } catch (err) {
        console.error('Error placing order:', err);
        return res.status(500).json({ message: err.message || 'Internal server error' });
    } finally {
        session.endSession();
    }
});

// Logic to restore stock for a given orderId
export const restoreOrderStockLogic = async (orderId, session) => {
    const order = await Order.findById(orderId)
        .session(session)
        .populate("items.productId");

    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order._restockDone) {
        throw new ApiError(409, "Stock already restored");
    }

    const stockEntries = [];

    for (const item of order.items) {
        const qty = Math.floor(Number(item.quantity));
        const variantKey = String(item.variantName || "").trim();

        const afterRestore = await Product.findOneAndUpdate(
            { _id: item.productId._id },
            {
                $inc: {
                    totalStock: qty,
                    [`variants.${variantKey}`]: qty
                }
            },
            { new: true, session }
        ).select("variants totalStock");

        if (!afterRestore) {
            throw new ApiError(404, `Product not found: ${item.productId._id}`);
        }

        const updatedStock = afterRestore.variants.get(variantKey);
        const previousStock = updatedStock - qty;

        stockEntries.push({
            orderId: order.orderId,
            orderRef: order?._id,
            type: STOCK_TYPES.PURCHASE_RESTORE,
            variantName: variantKey,
            quantity: qty,
            previousStock,
            updatedStock,
            productId: item.productId._id
        });
    }

    if (stockEntries.length > 0) {
        await Stock.insertMany(stockEntries, { session });
    }

    order._restockDone = true;
    // For reserved orders that were timed out, we also mark them as Abandoned.
    // However, if called from the manual API, we just keep it as is or update if needed.
    // The cron job will handle the orderState update separately.
    await order.save({ session });

    return order;
};

//In case of online orders when payment fails, or user initiate online order but do not pay
const restoreOrderStock = asyncHandler(async (req, res) => {
    const { orderId } = req.body;
    console.log("Stock Restore called for order: ", orderId);

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await restoreOrderStockLogic(orderId, session);
        });
    } finally {
        session.endSession();
    }

    return res.json({
        success: true,
        message: "Stock restored"
    });
});

// export const restoreOrderStock = async (req, res) => {

//     const session = await mongoose.startSession();

//     try {

//         const { orderId } = req.params;

//         if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
//             throw new ApiError(400, "Valid orderId required");
//         }

//         let restoredEntries = [];

//         await session.withTransaction(async () => {

//             const order = await Order.findById(orderId)
//                 .session(session)
//                 .populate("items.productId");

//             if (!order) {
//                 throw new ApiError(404, "Order not found");
//             }

//             if (!order.items || order.items.length === 0) {
//                 throw new ApiError(400, "Order has no items");
//             }

//             if (order._restockDone) {
//                 throw new ApiError(409, "Stock already restored for this order");
//             }

//             const agg = new Map();

//             // Aggregate product + variant quantities
//             for (const item of order.items) {

//                 const qty = Math.floor(Number(item.quantity));
//                 const variantKey = String(item.variantName || "").trim();

//                 if (!variantKey) {
//                     throw new ApiError(400, "Variant name missing");
//                 }

//                 const productId = item.productId._id.toString();
//                 const key = `${productId}::${variantKey}`;

//                 agg.set(key, (agg.get(key) || 0) + qty);
//             }

//             const stockEntries = [];

//             for (const [key, qty] of agg.entries()) {

//                 const [productId, variantKey] = key.split("::");

//                 const updatedProduct = await Product.findOneAndUpdate(
//                     { _id: productId },
//                     {
//                         $inc: {
//                             totalStock: qty,
//                             [`variants.${variantKey}`]: qty
//                         }
//                     },
//                     { new: true, session }
//                 ).select("variants totalStock");

//                 if (!updatedProduct) {
//                     throw new ApiError(404, "Product not found while restoring stock");
//                 }

//                 const updatedStock = updatedProduct.variants.get(variantKey);
//                 const previousStock = updatedStock - qty;

//                 stockEntries.push({
//                     orderId: order.orderId,
//                     type: STOCK_TYPES.RETURN,
//                     variantName: variantKey,
//                     quantity: qty,
//                     previousStock,
//                     updatedStock,
//                     productId
//                 });
//             }

//             if (stockEntries.length > 0) {
//                 await Stock.insertMany(stockEntries, { session });
//             }

//             // prevent duplicate restore
//             order._restockDone = true;
//             await order.save({ session });

//             restoredEntries = stockEntries;

//         });

//         return res.status(200).json(
//             new ApiResponse(
//                 200,
//                 { restoredEntries },
//                 "Stock restored successfully"
//             )
//         );

//     } catch (err) {

//         console.error("restoreOrderStock error:", err);

//         return res.status(err.statusCode || 500).json({
//             message: err.message || "Internal server error"
//         });

//     } finally {
//         session.endSession();
//     }
// };

const createOnlineOrder = asyncHandler(async (req, res) => {
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

            console.log("Start UTC:", start.toISOString());
            console.log("End UTC:", end.toISOString());
            console.log("Now UTC:", new Date(now).toISOString());

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
            }
            // console.log("Coupon: ", couponData)
        }

        cartId = req?.user?.cart;
        if (
            !userId || !name || !phoneNo || !cartId ||
            // !orderAmount || 
            !subtotal ||
            // !gst || 
            !address
        ) {
            throw new ApiError(400, 'Required order details missing.');
        }

        if (
            deliveryCharge == undefined || deliveryCharge == null || deliveryCharge < 0
        ) {
            throw new ApiError(400, 'Delivery charge cannot be negative.');
        }

        const cart = await Cart.findOne({ _id: cartId }).populate('items.productId');
        if (!cart || cart.items.length === 0) {
            throw new ApiError(400, 'Cart is empty or not found.');
        }

        const foundAddress = await Address.findById(addressId);

        const addressDetails = {
            address: `${foundAddress?.street || ""}, ${foundAddress?.street2 || ""}, ${foundAddress?.city || ""}, ${foundAddress?.state || ""}, ${foundAddress?.pinCode || ""}`,
            // address: foundAddress?.street,
            address2: foundAddress?.street2,
            city: foundAddress?.city,
            state: foundAddress?.state,
            country: foundAddress?.country,
            pincode: foundAddress?.pinCode
        }

        const paymentDate = new Date();
        // 2️⃣ Create Order in DB (status: Created)
        const newOrder = new Order({
            gateway: 'razorpay',
            ...couponData,
            ...addressDetails,
            userId,
            name: name.trim(),
            email: email.trim(),
            phoneNo: phoneNo.trim(),
            // address,
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
            // razorpayOrderId: razorpayOrder.id,
            orderAmount,
            // coupon,
            // discount,
            deliveryCharge,
            gst,
            subtotal,
            items: cart.items
        });

        console.log("Initial New Order: ", newOrder);
        // Recalculate subtotal and deliveryCharge
        let subtotal_amount = 0;
        const categoryCharges = new Map();
        // console.log("New Order 1:", newOrder);

        for (const item of newOrder.items) {

            const qty = Math.floor(Number(item.quantity));
            if (!Number.isInteger(qty) || qty <= 0) {
                throw new Error(`Invalid quantity for product ${item.productId?._id || item.productId}: ${item.quantity}`);
            }

            const variantKey = String(item.variantName || '').trim();
            if (!variantKey) {
                throw new Error(`Missing variantName for product ${item.productId._id}`);
            }

            // console.log("New Order 1:", item.productId);
            const prod = await Product.findOne({ _id: item.productId._id })
                .session(session)
                .populate("category")
                .exec();

            if (!prod || !prod.category) {
                throw new ApiError(400, `Product or category missing for ${item.productId._id}`);
            }

            console.log("product variant", prod?.variants, variantKey, !Object.prototype.hasOwnProperty.call(prod.variants, variantKey));

            if (
                !prod?.variants) {
                throw new ApiError(404, `Variants not found for product ${item?.productId?._id}`);
            }

            // Strict case-sensitive match: variant must exist exactly as provided

            //Adding stock entries document
            if (!prod.variants?.has(variantKey)) {
                throw new ApiError(404, `Variant "${variantKey}" not found for product ${item?.productId?._id}`);
            }

            const previousStock = prod.variants.get(variantKey);;
            const updatedStock = previousStock - qty;

            console.log("previous Stock", previousStock);
            console.log("updated Stock", updatedStock);

            if (previousStock < qty) {
                throw new ApiError(400, `Insufficient stock for ${variantKey}`);
            }

            // const varianQty = prod.variants[variantKey];
            // if (typeof varianQty !== "number") {
            //     throw new ApiError(400, `Variant "${variantKey}" has invalid inventory data`);
            // }

            // if (!varianQty || varianQty < qty) {
            //     throw new ApiError(
            //         400,
            //         `Only ${varianQty} units available for variant "${variantKey}", but ${qty} requested`
            //     );
            // }

            subtotal_amount += (item.price - (item.discount || 0)) * item.quantity;

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
        // newOrder.orderAmount = subtotal_amount - (newOrder.discount || 0) + totalDeliveryCharge;

        let discountedAmount = 0
        if (findCoupon) {
            discountedAmount = subtotal_amount * (parseFloat(findCoupon?.percent) * 0.01);
            discountedAmount = parseFloat(discountedAmount.toFixed(2));
            if (discountedAmount >= findCoupon?.value) {
                discountedAmount = parseFloat(findCoupon?.value);
            }
        }

        newOrder.discount = discountedAmount;
        newOrder.orderAmount = (subtotal_amount - (discountedAmount || 0) + totalDeliveryCharge).toFixed(2);

        console.log("discount", subtotal_amount - (discountedAmount || 0));
        console.log("orderAmount", newOrder.orderAmount, deliveryCharge);

        // 1️⃣ Create Razorpay Order
        const razorpay = await razorpayConfig();

        const razorpayOrder = await razorpay.orders.create({
            amount: newOrder?.orderAmount * 100, // in paise
            currency: 'INR',
            receipt: `rcpt_${uuidv4().split('-')[0]}`,
            payment_capture: 1
        });


        await session.withTransaction(async () => {

            newOrder.razorpayOrderId = razorpayOrder.id;
            await newOrder.save({ session });

            //deduct stock and create logs
            const stockEntries = [];

            for (const item of newOrder.items) {

                const qty = Math.floor(Number(item.quantity));

                const variantKey = String(item.variantName || "").trim();

                const variantResult = await Variant.findOneAndUpdate(
                    {
                        productId: item.productId._id,
                        name: variantKey,
                        active: true,
                        totalStock: { $gte: qty },
                        availableStock: { $gte: qty }
                    },
                    {
                        $inc: {
                            totalStock: -qty,
                            availableStock: -qty
                        }
                    },
                    { new: true, session }
                );

                if (!variantResult) {
                    throw new ApiError(
                        409,
                        `Insufficient stock for variant ${variantKey}`
                    );
                }

                const productResult = await Product.findOneAndUpdate(
                    {
                        _id: item.productId._id,
                        totalStock: { $gte: qty },
                        availableStock: { $gte: qty }
                    },
                    {
                        $inc: {
                            totalStock: -qty,
                            availableStock: -qty
                        }
                    },
                    { new: true, session }
                );

                if (!productResult) {
                    throw new ApiError(
                        409,
                        `Insufficient stock for parent product of variant ${variantKey}`
                    );
                }

                const updatedStock = variantResult.totalStock;
                const previousStock = updatedStock + qty;

                stockEntries.push({
                    type: STOCK_TYPES.PURCHASE,
                    orderId: newOrder.orderId,
                    orderRef: newOrder?._id,
                    variantName: variantKey,
                    purchasePrice: item.purchasePrice || 0,
                    quantity: qty,
                    previousStock,
                    updatedStock,
                    productId: item.productId._id
                });
            }

            //save stock ids in order for verify payment
            const createdStocks = await Stock.insertMany(stockEntries, { session });
            newOrder.stockIds = createdStocks.map(s => s._id);

            await newOrder.save({ session });

            // Create new cart, update user with new cart and delete old cart
            const newCart = new Cart({
                userId: cart.userId,
                items: cart.items,
                totalCartValue: cart.totalCartValue
            });
            // console.log("New Cart:", newCart);

            await newCart.save({ session, timestamps: false });

            await User.findByIdAndUpdate(
                cart.userId,
                { cart: newCart._id },
                { new: true, session }
            );

            // Deleting Old Cart
            await Cart.findByIdAndDelete(cart._id, { session });
        })

        const updatedUser = await User.findById(cart.userId).select('-password -refreshToken')
            .populate({
                path: "cart",
                populate: {
                    path: "items.productId",
                    model: "Product",
                    populate: {
                        path: "category",  // This is the key part
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
                razorpayOrderId: razorpayOrder.id,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                key: process.env.RAZORPAY_KEY_ID,
                newOrderId: newOrder._id,
                user: updatedUser
            }, 'Razorpay Order Created')
        );

    } catch (err) {
        console.error('createOnlineOrder error:', err);
        return res.status(500).json({ message: err.message || 'Internal server error' });
    } finally {
        session.endSession();
    }
});

const verifyPayment = async (req, res) => {
    const session = await mongoose.startSession();
    console.log("Verify order called");
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            orderId: dbOrderId
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            throw new ApiError(400, 'Payment verification details missing.');
        }

        // 1️⃣ Verify Signature
        const generatedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        const isValid = generatedSignature === razorpay_signature;

        if (!isValid) {
            return res.status(400).json(new ApiResponse(400, null, 'Invalid signature'));
        }

        let updatedUser = null;
        let finalOrder = null;

        // Use a transaction to make the whole operation atomic
        await session.withTransaction(async () => {
            // Try to find the order by razorpayOrderId first (safer)
            let order = await Order.findOne({ razorpayOrderId: razorpay_order_id })
                .session(session)
                .populate('items.productId');

            // Fallback: if not found, try by DB id (legacy / client-sent id)
            if (!order && dbOrderId) {
                order = await Order.findById(dbOrderId)
                    .session(session)
                    .populate('items.productId');
            }

            if (!order) {
                throw new ApiError(404, 'Order not found for this payment.');
            }

            // Atomic Lock / Idempotency Check: Mark order as Paid using findOneAndUpdate to prevent concurrent duplicate runs
            const lockedOrder = await Order.findOneAndUpdate(
                { _id: order._id, paymentStatus: { $ne: 'Paid' } },
                { $set: { paymentStatus: 'Paid' } },
                { session, new: true }
            );

            if (!lockedOrder) {
                console.log(`Order ${order._id} already marked Paid. Skipping duplicate execution in verifyPayment.`);

                finalOrder = await Order.findById(order._id).session(session).populate('items.productId');
                updatedUser = await User.findById(order.userId)
                    .session(session)
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
                return;
            }

            order = lockedOrder;

            if (order?.coupon) {
                let foundCoupon = await Coupon.findById(order?.coupon);
                // if (!foundCoupon) {
                //     throw new Error(404, "Coupon not found");
                // }
                if (foundCoupon?.type == "oneTime" || foundCoupon?.type == "oneTimeUser") {
                    foundCoupon.appliedBy = [
                        ...foundCoupon?.appliedBy,
                        {
                            user: req?.user?._id,
                            order: order?._id
                        }
                    ]
                    await foundCoupon.save({ session })
                }

            }

            // Update order metadata
            order.abondonedOrder = false;
            order.razorpayOrderId = razorpay_order_id;
            order.razorpayPaymentId = razorpay_payment_id;
            order.orderState = "Confirmed";

            // Next orderId generation (if you use sequential readable order ids)
            const nextOrderId = await Order.generateNextOrderId();
            order.orderId = nextOrderId;

            // Replace the new orderid in all associated stock entries
            const stockIds = order.stockIds || [];
            if (stockIds?.length > 0) {

                await Stock.updateMany(
                    { _id: { $in: stockIds } },
                    { $set: { orderId: order.orderId } },
                    { session }
                );
            }

            // Validate quantities and decrement stock atomically
            const uniqueProductIds = [
                ...new Set(order.items.map(it => it.productId._id.toString()))
            ];

            // Link products -> orders
            await Product.updateMany(
                { _id: { $in: uniqueProductIds } },
                { $push: { orders: order._id } },
                { session }
            );

            // Clear the user's cart atomically (if cart exists)
            const cart = await Cart.findById(req?.user?.cart).session(session);
            if (cart) {
                cart.items = [];
                cart.totalCartValue = 0;
                await cart.save({ session });
            }

            // Save order
            await order.save({ session });

            // push order into user's orders array and populate updatedUser
            updatedUser = await User.findByIdAndUpdate(
                order.userId,
                { $push: { orders: order._id } },
                { new: true, session }
            )
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

            finalOrder = order;
        });

        // If we get here, transaction committed
        return res.status(200).json(
            new ApiResponse(200, { order: finalOrder, user: updatedUser }, "Payment Verified. Order Completed")
        );

    } catch (err) {
        console.error('verifyPayment error:', err);
        // If it's an ApiError it probably already has useful status, but fallback to 500
        const status = err.statusCode || 500;
        return res.status(status).json({ message: err.message || 'Internal server error' });
    } finally {
        session.endSession();
    }
};

// const createOnlineOrder = asyncHandler(async (req, res) => {
//     const session = await mongoose.startSession();

//     try {
//         let {
//             userId, cartId,
//             name, email, phoneNo,
//             orderAmount,
//             coupon,
//             comments,
//             discount,
//             deliveryCharge = 0,
//             gst,
//             subtotal,
//             address,
//             addressId,
//             isAppOrder
//         } = req.body;

//         let couponData = {};
//         let findCoupon = null;

//         if (coupon) {
//             findCoupon = await Coupon.findById(coupon);
//             if (!findCoupon) {
//                 throw new ApiError(404, "Coupon not found");
//             }

//             const start = new Date(findCoupon?.startDate);
//             const end = new Date(findCoupon?.endDate);
//             const now = Date.now();

//             console.log("Start UTC:", start.toISOString());
//             console.log("End UTC:", end.toISOString());
//             console.log("Now UTC:", new Date(now).toISOString());

//             if (start.getTime() > now) {
//                 throw new ApiError(400, "Offer not started yet");
//             }

//             if (end.getTime() < now) {
//                 throw new ApiError(400, "Coupon expired");
//             }

//             couponData = {
//                 coupon: findCoupon._id,
//                 couponType: findCoupon.type,
//                 couponCode: findCoupon.code
//             }
//             // console.log("Coupon: ", couponData)
//         }

//         cartId = req?.user?.cart;
//         if (
//             !userId || !name || !phoneNo || !cartId ||
//             // !orderAmount || 
//             !subtotal ||
//             // !gst || 
//             !address
//         ) {
//             throw new ApiError(400, 'Required order details missing.');
//         }

//         if (
//             deliveryCharge == undefined || deliveryCharge == null || deliveryCharge < 0
//         ) {
//             throw new ApiError(400, 'Delivery charge cannot be negative.');
//         }

//         const cart = await Cart.findOne({ _id: cartId }).populate('items.productId');
//         if (!cart || cart.items.length === 0) {
//             throw new ApiError(400, 'Cart is empty or not found.');
//         }

//         const foundAddress = await Address.findById(addressId);

//         const addressDetails = {
//             address: `${foundAddress?.street || ""}, ${foundAddress?.street2 || ""}, ${foundAddress?.city || ""}, ${foundAddress?.state || ""}, ${foundAddress?.pinCode || ""}`,
//             // address: foundAddress?.street,
//             address2: foundAddress?.street2,
//             city: foundAddress?.city,
//             state: foundAddress?.state,
//             country: foundAddress?.country,
//             pincode: foundAddress?.pinCode
//         }

//         const paymentDate = new Date();
//         // 2️⃣ Create Order in DB (status: Created)
//         const newOrder = new Order({
//             ...couponData,
//             ...addressDetails,
//             userId,
//             name: name.trim(),
//             email: email.trim(),
//             phoneNo: phoneNo.trim(),
//             // address,
//             comments,
//             addressId,
//             method: 'Online',
//             type: 'Regular',
//             status: 'New',
//             paymentStatus: 'Pending',
//             paymentDate,
//             isAppOrder,
//             orderState: "Reserved",
//             abondonedOrder: true,
//             orderId: uuidv4().split('-')[0].toUpperCase(),
//             // razorpayOrderId: razorpayOrder.id,
//             orderAmount,
//             // coupon,
//             // discount,
//             deliveryCharge,
//             gst,
//             subtotal,
//             items: cart.items
//         });

//         console.log("Initial New Order: ", newOrder);
//         // Recalculate subtotal and deliveryCharge
//         let subtotal_amount = 0;
//         const categoryCharges = new Map();
//         // console.log("New Order 1:", newOrder);

//         for (const item of newOrder.items) {

//             const qty = Math.floor(Number(item.quantity));
//             if (!Number.isInteger(qty) || qty <= 0) {
//                 throw new Error(`Invalid quantity for product ${item.productId?._id || item.productId}: ${item.quantity}`);
//             }

//             const variantKey = String(item.variantName || '').trim();
//             if (!variantKey) {
//                 throw new Error(`Missing variantName for product ${item.productId._id}`);
//             }

//             // console.log("New Order 1:", item.productId);
//             const prod = await Product.findOne({ _id: item.productId._id })
//                 .session(session)
//                 .populate("category")
//                 .exec();

//             if (!prod || !prod.category) {
//                 throw new ApiError(400, `Product or category missing for ${item.productId._id}`);
//             }

//             console.log("product variant", prod?.variants, variantKey, !Object.prototype.hasOwnProperty.call(prod.variants, variantKey));

//             if (
//                 !prod?.variants) {
//                 throw new ApiError(404, `Variants not found for product ${item?.productId?._id}`);
//             }

//             // Strict case-sensitive match: variant must exist exactly as provided

//             //Adding stock entries document
//             if (!prod.variants?.has(variantKey)) {
//                 throw new ApiError(404, `Variant "${variantKey}" not found for product ${item?.productId?._id}`);
//             }

//             const previousStock = prod.variants.get(variantKey);;
//             const updatedStock = previousStock - qty;

//             console.log("previous Stock", previousStock);
//             console.log("updated Stock", updatedStock);

//             if (previousStock < qty) {
//                 throw new ApiError(400, `Insufficient stock for ${variantKey}`);
//             }

//             // const varianQty = prod.variants[variantKey];
//             // if (typeof varianQty !== "number") {
//             //     throw new ApiError(400, `Variant "${variantKey}" has invalid inventory data`);
//             // }

//             // if (!varianQty || varianQty < qty) {
//             //     throw new ApiError(
//             //         400,
//             //         `Only ${varianQty} units available for variant "${variantKey}", but ${qty} requested`
//             //     );
//             // }

//             subtotal_amount += item.price * item.quantity;

//             const categoryId = prod.category._id.toString();
//             const deliveryCharge = prod.category.deliveryCharge || 0;

//             if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
//                 categoryCharges.set(categoryId, deliveryCharge);
//             }
//         }

//         let values = Array.from(categoryCharges.values());
//         let totalDeliveryCharge = Math.max(...values);

//         if (!isFinite(totalDeliveryCharge) || totalDeliveryCharge === undefined) {
//             totalDeliveryCharge = 0;
//         }

//         newOrder.subtotal = subtotal_amount;
//         newOrder.deliveryCharge = totalDeliveryCharge;
//         // newOrder.orderAmount = subtotal_amount - (newOrder.discount || 0) + totalDeliveryCharge;

//         let discountedAmount = 0
//         if (findCoupon) {
//             discountedAmount = subtotal_amount * (parseFloat(findCoupon?.percent) * 0.01);
//             discountedAmount = parseFloat(discountedAmount.toFixed(2));
//             if (discountedAmount >= findCoupon?.value) {
//                 discountedAmount = parseFloat(findCoupon?.value);
//             }
//         }

//         newOrder.discount = discountedAmount;
//         newOrder.orderAmount = (subtotal_amount - (discountedAmount || 0) + totalDeliveryCharge).toFixed(2);

//         // 1️⃣ Create Razorpay Order
//         const razorpay = await razorpayConfig();

//         const razorpayOrder = await razorpay.orders.create({
//             amount: newOrder?.orderAmount * 100, // in paise
//             currency: 'INR',
//             receipt: `rcpt_${uuidv4().split('-')[0]}`,
//             payment_capture: 1
//         });

//         newOrder.razorpayOrderId = razorpayOrder.id
//         await session.withTransaction(async () => {
//             await newOrder.save({ session });

//             // console.log("New Order 2:", newOrder);

//             // console.log("Old Cart:", cart);

//             // Create new cart, update user with new cart and delete old cart
//             const newCart = new Cart({
//                 userId: cart.userId,
//                 items: cart.items,
//                 totalCartValue: cart.totalCartValue
//             });
//             // console.log("New Cart:", newCart);

//             await newCart.save({ session, timestamps: false });

//             await User.findByIdAndUpdate(
//                 cart.userId,
//                 { cart: newCart._id },
//                 { new: true, session }
//             );

//             // Deleting Old Cart
//             await Cart.findByIdAndDelete(cart._id, { session });
//         })

//         const updatedUser = await User.findById(cart.userId).select('-password -refreshToken')
//             .populate({
//                 path: "cart",
//                 populate: {
//                     path: "items.productId",
//                     model: "Product",
//                     populate: {
//                         path: "category",  // This is the key part
//                         model: "SubCategory"
//                     }
//                 }
//             })
//             .populate("wishlist")
//             .populate("address")
//             .populate("orders")
//             .exec();

//         return res.status(201).json(
//             new ApiResponse(201, {
//                 razorpayOrderId: razorpayOrder.id,
//                 amount: razorpayOrder.amount,
//                 currency: razorpayOrder.currency,
//                 key: process.env.RAZORPAY_KEY_ID,
//                 newOrderId: newOrder._id,
//                 user: updatedUser
//             }, 'Razorpay Order Created')
//         );

//     } catch (err) {
//         console.error('createOnlineOrder error:', err);
//         return res.status(500).json({ message: err.message || 'Internal server error' });
//     } finally {
//         session.endSession();
//     }
// });

// const verifyPayment = async (req, res) => {
//     const session = await mongoose.startSession();

//     try {
//         const {
//             razorpay_order_id,
//             razorpay_payment_id,
//             razorpay_signature,
//             orderId: dbOrderId
//         } = req.body;

//         if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
//             throw new ApiError(400, 'Payment verification details missing.');
//         }

//         // 1️⃣ Verify Signature
//         const generatedSignature = crypto
//             .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
//             .update(`${razorpay_order_id}|${razorpay_payment_id}`)
//             .digest('hex');

//         const isValid = generatedSignature === razorpay_signature;

//         if (!isValid) {
//             return res.status(400).json(new ApiResponse(400, null, 'Invalid signature'));
//         }

//         let updatedUser = null;
//         let finalOrder = null;

//         // Use a transaction to make the whole operation atomic
//         await session.withTransaction(async () => {
//             // Try to find the order by razorpayOrderId first (safer)
//             let order = await Order.findOne({ razorpayOrderId: razorpay_order_id })
//                 .session(session)
//                 .populate('items.productId');

//             // Fallback: if not found, try by DB id (legacy / client-sent id)
//             if (!order && dbOrderId) {
//                 order = await Order.findById(dbOrderId)
//                     .session(session)
//                     .populate('items.productId');
//             }

//             if (!order) {
//                 throw new ApiError(404, 'Order not found for this payment.');
//             }

//             if (order?.coupon) {
//                 let foundCoupon = await Coupon.findById(order?.coupon);
//                 // if (!foundCoupon) {
//                 //     throw new Error(404, "Coupon not found");
//                 // }
//                 if (foundCoupon?.type == "oneTime") {
//                     foundCoupon.appliedBy = [
//                         ...foundCoupon?.appliedBy,
//                         {
//                             user: req?.user?._id,
//                             order: order?._id
//                         }
//                     ]
//                     await foundCoupon.save({ session })
//                 }

//             }

//             // If already paid, return the existing state (idempotent)
//             if (order.paymentStatus === 'Paid') {
//                 finalOrder = order;
//                 return;
//             }

//             // Update order metadata
//             order.abondonedOrder = false;
//             order.paymentStatus = 'Paid';
//             order.razorpayOrderId = razorpay_order_id;
//             order.razorpayPaymentId = razorpay_payment_id;
//             order.orderState = "Confirmed";

//             // Next orderId generation (if you use sequential readable order ids)
//             const nextOrderId = await Order.generateNextOrderId();
//             order.orderId = nextOrderId;

//             // Validate quantities and decrement stock atomically
//             const uniqueProductIds = [
//                 ...new Set(order.items.map(it => it.productId._id.toString()))
//             ];

//             //Product Stock handling
//             const stockEntries = [];

//             for (const item of order.items) {
//                 const qty = Math.floor(Number(item.quantity));
//                 if (!Number.isInteger(qty) || qty <= 0) {
//                     throw new Error(`Invalid quantity for product ${item.productId?._id}: ${item.quantity}`);
//                 }

//                 const variantKey = String(item.variantName || "").trim();
//                 if (!variantKey) {
//                     throw new ApiError(400, `Missing variantName for product ${item.productId._id}`);
//                 }

//                 // $inc first, get POST-update document back via findOneAndUpdate
//                 // This eliminates the stale pre-read entirely
//                 const afterDecrement = await Product.findOneAndUpdate(
//                     {
//                         _id: item.productId._id,
//                         totalStock: { $gte: qty },
//                         [`variants.${variantKey}`]: { $gte: qty }
//                     },
//                     {
//                         $inc: {
//                             totalStock: -qty,
//                             [`variants.${variantKey}`]: -qty
//                         }
//                     },
//                     { new: true, session }  // new: true → POST-decrement values
//                 ).select("variants totalStock");

//                 if (!afterDecrement) {
//                     throw new ApiError(
//                         409,
//                         `Insufficient stock or race condition for variant "${variantKey}"`
//                     );
//                 }

//                 // Derive previousStock from actual DB result — always accurate
//                 const updatedStock = afterDecrement.variants.get(variantKey);
//                 const previousStock = updatedStock + qty;

//                 stockEntries.push({
//                     orderId: order.orderId,
//                     type: STOCK_TYPES.PURCHASE,
//                     variantName: variantKey,
//                     purchasePrice: item.price,
//                     quantity: qty,
//                     previousStock,   // accurate
//                     updatedStock,    // accurate
//                     productId: item.productId._id
//                 });
//             }

//             if (stockEntries.length > 0) {
//                 await Stock.insertMany(stockEntries, { session });
//             }

//             // for (const item of order.items) {
//             //     const qty = Math.floor(Number(item.quantity));
//             //     if (!Number.isInteger(qty) || qty <= 0) {
//             //         throw new Error(`Invalid quantity for product ${item.productId?._id || item.productId}: ${item.quantity}`);
//             //     }

//             //     const variantKey = String(item.variantName || "").trim();
//             //     if (!variantKey) {
//             //         throw new ApiError(400, `Missing variantName for product ${item.productId._id}`);
//             //     }

//             //     const product = await Product.findById(item.productId._id)
//             //         .session(session)
//             //         .select("variants totalStock");

//             //     if (!product || !product.variants || !product.variants.has(variantKey)) {
//             //         throw new ApiError(404, `Variant "${variantKey}" not found`);
//             //     }

//             //     const previousStock = product.variants.get(variantKey);
//             //     const updatedStock = previousStock - qty;

//             //     if (previousStock < qty) {
//             //         throw new ApiError(
//             //             400,
//             //             `Insufficient stock for product ${item.productId._id}, variant "${variantKey}"`
//             //         );
//             //     }

//             //     // Atomic decrement
//             //     const result = await Product.updateOne(
//             //         {
//             //             _id: item.productId._id,
//             //             totalStock: { $gte: qty },
//             //             [`variants.${variantKey}`]: { $gte: qty }
//             //         },
//             //         {
//             //             $inc: {
//             //                 totalStock: -qty,
//             //                 [`variants.${variantKey}`]: -qty
//             //             }
//             //         },
//             //         { session }
//             //     );

//             //     if (!result || result.modifiedCount === 0) {
//             //         throw new ApiError(409, "Stock update failed due to race condition");
//             //     }

//             //     //                 if (result.modifiedCount === 0) {
//             //     //     // Stock nahi mila — refund karo
//             //     //     await razorpay.payments.refund(razorpay_payment_id, {
//             //     //         amount: order.orderAmount * 100
//             //     //     });
//             //     //     throw new ApiError(409, "Stock unavailable. Refund initiated.");
//             //     // }

//             //     // Prepare stock history entry (NOT SAVING YET)
//             //     stockEntries.push({
//             //         orderId: order.orderId,
//             //         type: STOCK_TYPES.PURCHASE,
//             //         variantName: variantKey,
//             //         purchasePrice: item.price,
//             //         quantity: qty,
//             //         previousStock,
//             //         updatedStock,
//             //         productId: item.productId._id
//             //     });
//             // }

//             // if (stockEntries.length > 0) {
//             //     await Stock.insertMany(stockEntries, { session });
//             // }

//             // Link products -> orders
//             await Product.updateMany(
//                 { _id: { $in: uniqueProductIds } },
//                 { $push: { orders: order._id } },
//                 { session }
//             );

//             // Clear the user's cart atomically (if cart exists)
//             const cart = await Cart.findById(req?.user?.cart).session(session);
//             if (cart) {
//                 cart.items = [];
//                 cart.totalCartValue = 0;
//                 await cart.save({ session });
//             }

//             // Save order
//             await order.save({ session });

//             // push order into user's orders array and populate updatedUser
//             updatedUser = await User.findByIdAndUpdate(
//                 order.userId,
//                 { $push: { orders: order._id } },
//                 { new: true, session }
//             )
//                 .select('-password -refreshToken')
//                 .populate({
//                     path: "cart",
//                     populate: {
//                         path: "items.productId",
//                         model: "Product",
//                         populate: {
//                             path: "category",
//                             model: "SubCategory"
//                         }
//                     }
//                 })
//                 .populate("wishlist")
//                 .populate("address")
//                 .populate("orders")
//                 .exec();

//             finalOrder = order;
//         });

//         // If we get here, transaction committed
//         return res.status(200).json(
//             new ApiResponse(200, { order: finalOrder, user: updatedUser }, "Payment Verified. Order Completed")
//         );

//     } catch (err) {
//         console.error('verifyPayment error:', err);
//         // If it's an ApiError it probably already has useful status, but fallback to 500
//         const status = err.statusCode || 500;
//         return res.status(status).json({ message: err.message || 'Internal server error' });
//     } finally {
//         session.endSession();
//     }
// };

const reviewOrder = asyncHandler(async (req, res) => {
    try {
        const { orderId } = req?.body;

        if (
            !orderId
        ) {
            throw new ApiError(400, 'Order Id not found.');
        }

        const foundOrder = await Order.findById(orderId);
        if (!foundOrder) {
            throw new ApiError(400, 'Order not found.');
        }

        if (foundOrder?.isReviewed) {
            throw new ApiError(409, 'Order is already reviewed');
        }

        if (foundOrder?.status != 'Delivered') {
            throw new ApiError(409, 'Order is not delivered yet');
        }

        const updatedOrder = await Order.findByIdAndUpdate(
            orderId,
            {
                isReviewed: true,
            },
            { new: true }
        )
            .populate({ path: "userId", select: "-password -refreshToken" })
            .populate({
                path: "items.productId",
                model: "Product",
                // populate: { path: "category", model: "SubCategory" },
            })
            .populate("addressId")
            .exec();;

        return res.status(201).json(
            new ApiResponse(201, { updatedOrder }, "Review added successfully")
        );

    } catch (err) {
        console.error('Error adding review:', err?.message);
        return res.status(500).json({ message: err?.message || 'Internal server error' });
    }
});

const calculateB2BItemPrice = (product, quantity) => {
    if (!product.sellingPrice) return 0;
    if (product.sellingPrice.type === "fixed") {
        if (product.sellingPrice.slabs && product.sellingPrice.slabs.length > 0) {
            return product.sellingPrice.slabs[0].price;
        }
        return product.basePrice || 0;
    }

    const slabs = product.sellingPrice.slabs || [];
    if (slabs.length === 0) return product.basePrice || 0;

    const sortedSlabs = [...slabs].sort((a, b) => a.quantity - b.quantity);

    let matchedPrice = sortedSlabs[0].price;
    for (const slab of sortedSlabs) {
        if (quantity >= slab.quantity) {
            matchedPrice = slab.price;
        } else {
            break;
        }
    }
    return matchedPrice;
};



const updateOrder = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    try {
        const orderId = req?.params?._id;
        const updates = req?.body;

        if (!orderId) {
            throw new ApiError(400, 'Order Id not found.');
        }

        const order = await Order.findById(orderId);
        if (!order) {
            throw new ApiError(404, 'Order not found.');
        }

        // If trying to update items/discounts/charges, validate editing timeframe constraints
        const isEditingItems = updates && (updates.items !== undefined || updates.discount !== undefined || updates.discountPercent !== undefined || updates.discountType !== undefined || updates.deliveryCharge !== undefined);

        if (isEditingItems) {
            const canEdit = () => {
                if (order.shippingType === 'Manual') {
                    return !['Shipped', 'Delivered', 'Cancelled', 'Rejected', 'Returned'].includes(order.status);
                } else {
                    return !order.awbCode && !order.shipmentId && !order.pickupScheduled && !order.courierName && !['Shipped', 'Delivered', 'Cancelled', 'Rejected', 'Returned'].includes(order.status);
                }
            };
            if (!canEdit()) {
                throw new ApiError(400, "Order cannot be edited at this stage.");
            }
        }

        await session.withTransaction(async () => {
            if (isEditingItems && updates.items) {
                // Map existing items
                const oldItemsMap = new Map();
                for (const item of order.items) {
                    const key = `${item.productId.toString()}_${item.variantName}`;
                    oldItemsMap.set(key, item.quantity);
                }

                const newItems = [];
                const stockEntries = [];

                for (const reqItem of updates.items) {
                    const productId = reqItem.productId;
                    const variantName = reqItem.variantName;
                    const qty = Math.floor(Number(reqItem.quantity || 0));
                    const itemDiscount = Number(reqItem.discount || 0);
                    const itemDiscountPercent = Number(reqItem.discountPercent || 0);

                    if (qty <= 0) continue;

                    const key = `${productId.toString()}_${variantName}`;
                    const oldQty = oldItemsMap.get(key) || 0;
                    const diff = qty - oldQty;

                    const product = await Product.findById(productId).session(session);
                    if (!product) throw new ApiError(404, `Product not found for ID: ${productId}`);

                    // Adjust stock if quantity changed
                    if (diff > 0) {
                        const variantResult = await Variant.findOneAndUpdate(
                            {
                                productId: productId,
                                name: variantName,
                                active: true,
                                totalStock: { $gte: diff },
                                availableStock: { $gte: diff }
                            },
                            {
                                $inc: {
                                    totalStock: -diff,
                                    availableStock: -diff
                                }
                            },
                            { new: true, session }
                        );

                        if (!variantResult) {
                            throw new ApiError(400, `Insufficient stock for product ${product.fullName} variant ${variantName}`);
                        }

                        const productResult = await Product.findOneAndUpdate(
                            {
                                _id: productId,
                                totalStock: { $gte: diff },
                                availableStock: { $gte: diff }
                            },
                            {
                                $inc: {
                                    totalStock: -diff,
                                    availableStock: -diff
                                }
                            },
                            { new: true, session }
                        );

                        if (!productResult) {
                            throw new ApiError(400, `Failed to update parent stock for product ${product.fullName}`);
                        }

                        const updatedStock = variantResult.totalStock;
                        const previousStock = updatedStock + diff;

                        stockEntries.push({
                            orderId: order.orderId,
                            orderRef: order._id,
                            type: STOCK_TYPES.PURCHASE,
                            variantName,
                            quantity: diff,
                            previousStock,
                            updatedStock,
                            productId
                        });
                    } else if (diff < 0) {
                        const restoreQty = -diff;
                        const variantResult = await Variant.findOneAndUpdate(
                            {
                                productId: productId,
                                name: variantName
                            },
                            {
                                $inc: {
                                    totalStock: restoreQty,
                                    availableStock: restoreQty
                                }
                            },
                            { new: true, session }
                        );

                        if (!variantResult) {
                            throw new ApiError(400, `Failed to restore variant stock for product ${product.fullName}`);
                        }

                        const productResult = await Product.findOneAndUpdate(
                            { _id: productId },
                            {
                                $inc: {
                                    totalStock: restoreQty,
                                    availableStock: restoreQty
                                }
                            },
                            { new: true, session }
                        );

                        if (!productResult) {
                            throw new ApiError(400, `Failed to restore parent product stock for ${product.fullName}`);
                        }

                        const updatedStock = variantResult.totalStock;
                        const previousStock = updatedStock - restoreQty;

                        stockEntries.push({
                            orderId: order.orderId,
                            orderRef: order._id,
                            type: STOCK_TYPES.ADD,
                            variantName,
                            quantity: restoreQty,
                            previousStock,
                            updatedStock,
                            productId
                        });
                    }

                    // Price logic:
                    // If it already existed in the order, keep the old item.price.
                    // Otherwise, fetch slab price.
                    const existingItem = order.items.find(
                        it => it.productId.toString() === productId.toString() && it.variantName === variantName
                    );

                    let finalPrice = existingItem ? existingItem.price : calculateB2BItemPrice(product, qty);

                    // If they passed a custom price from frontend, we can apply it.
                    if (reqItem.price !== undefined && reqItem.price !== null) {
                        finalPrice = Number(reqItem.price);
                    }

                    newItems.push({
                        productId,
                        variantName,
                        quantity: qty,
                        price: finalPrice,
                        discount: itemDiscount,
                        discountPercent: itemDiscountPercent
                    });

                    // Remove processed item from map so we know what was completely deleted
                    oldItemsMap.delete(key);
                }

                // Any remaining items in oldItemsMap were completely removed
                for (const [key, oldQty] of oldItemsMap.entries()) {
                    const [productId, variantName] = key.split("_");
                    const product = await Product.findById(productId).session(session);

                    const variantResult = await Variant.findOneAndUpdate(
                        {
                            productId: productId,
                            name: variantName
                        },
                        {
                            $inc: {
                                totalStock: oldQty,
                                availableStock: oldQty
                            }
                        },
                        { new: true, session }
                    );

                    const productResult = await Product.findOneAndUpdate(
                        { _id: productId },
                        {
                            $inc: {
                                totalStock: oldQty,
                                availableStock: oldQty
                            }
                        },
                        { new: true, session }
                    );

                    if (variantResult) {
                        const updatedStock = variantResult.totalStock;
                        const previousStock = updatedStock - oldQty;

                        stockEntries.push({
                            orderId: order.orderId,
                            orderRef: order._id,
                            type: STOCK_TYPES.ADD,
                            variantName,
                            quantity: oldQty,
                            previousStock,
                            updatedStock,
                            productId
                        });
                    }
                }

                if (stockEntries.length > 0) {
                    await Stock.insertMany(stockEntries, { session });
                }

                order.items = newItems;
            }

            // Apply other fields
            if (updates.discount !== undefined) order.discount = Number(updates.discount);
            if (updates.discountPercent !== undefined) order.discountPercent = Number(updates.discountPercent);
            if (updates.discountType !== undefined) order.discountType = updates.discountType;
            if (updates.deliveryCharge !== undefined) order.deliveryCharge = Number(updates.deliveryCharge);
            if (updates.comments !== undefined) order.comments = updates.comments;
            if (updates.reason !== undefined) order.reason = updates.reason;
            if (updates.status !== undefined && updates.status !== order.status) {
                order.status = updates.status;
                if (updates.status === 'Accepted' && !order.acceptedAt) {
                    order.acceptedAt = new Date();
                    order.acceptedReason = updates.reason || "";
                }
            }

            // Recalculate totals
            if (updates.items !== undefined) {
                await recalculateOrderTotals(order, session, updates.deliveryCharge !== undefined);
            } else {
                if (updates.orderAmount !== undefined) {
                    order.orderAmount = Number(updates.orderAmount);
                    order.remainingAmount = Math.max(0, order.orderAmount - (order.amountPaid || 0));
                    if (order.remainingAmount <= 0) {
                        order.paymentStatus = "Paid";
                        order.paymentDate = new Date();
                    } else {
                        order.paymentStatus = "Pending";
                    }
                }
            }
            await order.save({ session });

            if (isEditingItems) {
                await logActivity({
                    orderId: order._id,
                    action: "Items Edited",
                    remarks: "Order items, quantities, or discounts updated by admin.",
                    req,
                    session
                });
            }
        });

        const updatedOrder = await Order.findById(orderId).populate("items.productId");
        return res.status(201).json(new ApiResponse(201, { updatedOrder }, "Order updated successfully"));

    } catch (err) {
        console.error('Error updating order:', err.message);
        throw err;
    } finally {
        session.endSession();
    }
});

const addItemQuantityInOrder = async (req, res) => {
    const session = await mongoose.startSession();

    try {
        const { orderId, productId, variantName, quantity = 1 } = req.body;

        if (!orderId || !productId || !variantName || quantity <= 0) {
            throw new ApiError(400, "Invalid input");
        }

        let updatedOrder;

        await session.withTransaction(async () => {

            const order = await Order.findById(orderId).session(session);
            if (!order) throw new ApiError(404, "Order not found");

            const product = await Product.findById(productId)
                .session(session)
                .select("variants totalStock fullName sellingPrice basePrice");

            if (!product) throw new ApiError(404, "Product not found");

            // 🔥 ATOMIC STOCK DECREMENT
            const result = await Product.updateOne(
                {
                    _id: productId,
                    totalStock: { $gte: quantity },
                    [`variants.${variantName}`]: { $gte: quantity }
                },
                {
                    $inc: {
                        totalStock: -quantity,
                        [`variants.${variantName}`]: -quantity
                    }
                },
                { session }
            );

            if (!result || result.modifiedCount === 0) {
                throw new ApiError(409, "Stock update failed (race condition)");
            }

            // 🔹 Get previous stock for log
            const freshProduct = await Product.findById(productId)
                .session(session)
                .select("variants totalStock");

            const updatedStock = freshProduct.variants.get(variantName);
            const previousStock = updatedStock + quantity;

            // 🔹 Insert Stock Log
            await Stock.create([{
                orderId: order.orderId,
                orderRef: order?._id,
                type: STOCK_TYPES.ADD,
                variantName,
                quantity,
                previousStock,
                updatedStock,
                productId
            }], { session });

            // 🔹 Update order items
            const existingItem = order.items.find(
                item =>
                    item.productId.toString() === productId &&
                    item.variantName === variantName
            );

            if (existingItem) {
                existingItem.quantity += quantity;
            } else {
                const matchedSlab = determineSlabForQuantity(product, quantity);
                const itemPrice = matchedSlab ? matchedSlab.price : (product.basePrice || 0);

                order.items.push({
                    productId,
                    name: product.fullName,
                    price: itemPrice,
                    variantName,
                    quantity
                });
            }

            // 🔁 Recalculate totals
            await recalculateOrderTotals(order, session);

            updatedOrder = await order.save({ session });
        });

        return res.status(200).json(
            new ApiResponse(200, updatedOrder, "Item quantity added successfully")
        );

    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    } finally {
        session.endSession();
    }
};

const removeItemQuantityInOrder = async (req, res) => {
    const session = await mongoose.startSession();

    try {
        const { orderId, productId, variantName, quantity = 1 } = req.body;

        if (!orderId || !productId || !variantName || quantity <= 0) {
            throw new ApiError(400, "Invalid input");
        }

        let updatedOrder;

        await session.withTransaction(async () => {

            const order = await Order.findById(orderId).session(session);
            if (!order) throw new ApiError(404, "Order not found");

            const product = await Product.findById(productId)
                .session(session)
                .select("variants totalStock");

            if (!product) throw new ApiError(404, "Product not found");

            const existingItemIndex = order.items.findIndex(
                item =>
                    item.productId.toString() === productId &&
                    item.variantName === variantName
            );

            if (existingItemIndex === -1) {
                throw new ApiError(400, "Item not found in order");
            }

            const existingItem = order.items[existingItemIndex];

            if (existingItem.quantity < quantity) {
                throw new ApiError(400, "Cannot remove more than existing quantity");
            }

            // 🔥 ATOMIC STOCK RESTORE
            await Product.updateOne(
                { _id: productId },
                {
                    $inc: {
                        totalStock: quantity,
                        [`variants.${variantName}`]: quantity
                    }
                },
                { session }
            );

            const freshProduct = await Product.findById(productId)
                .session(session)
                .select("variants");

            const updatedStock = freshProduct.variants.get(variantName);
            const previousStock = updatedStock - quantity;

            // 🔹 Insert Stock Log
            await Stock.create([{
                orderId: order.orderId,
                orderRef: order?._id,
                type: STOCK_TYPES.REMOVE,
                variantName,
                quantity,
                previousStock,
                updatedStock,
                productId
            }], { session });

            // 🔹 Update order items
            existingItem.quantity -= quantity;
            if (existingItem.quantity <= 0) {
                order.items.splice(existingItemIndex, 1);
            }

            await recalculateOrderTotals(order, session);

            updatedOrder = await order.save({ session });
        });

        return res.status(200).json(
            new ApiResponse(200, updatedOrder, "Item quantity removed successfully")
        );

    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message
        });
    } finally {
        session.endSession();
    }
};

// const addItemQuantityInOrder = async (req, res) => {
//     const session = await mongoose.startSession();

//     try {
//         const {
//             orderId,
//             productId,
//             variantName,
//             quantity = 1
//         } = req.body;

//         if (!orderId || !productId || !variantName || !quantity || quantity <= 0) {
//             throw new ApiError(400, "All fields are required and quantity must be > 0");
//         }

//         let updatedOrder;

//         await session.withTransaction(async () => {
//             const [order, product] = await Promise.all([
//                 Order.findById(orderId).session(session),
//                 Product.findById(productId).populate("category").session(session)
//             ]);

//             if (!order) throw new ApiError(404, "Order not found");
//             if (!product) throw new ApiError(404, "Product not found");

//             const availableVariantStock = product.variants.get(variantName);
//             if (!availableVariantStock || availableVariantStock < quantity || product.totalStock < quantity) {
//                 throw new ApiError(400, `Item ${product.fullName} in variant ${variantName} is out of stock`);
//             }

//             // Decrease stock
//             product.totalStock -= quantity;
//             product.variants.set(variantName, availableVariantStock - quantity);
//             await product.save({ session });

//             // Update or add item to order
//             const existingItem = order.items.find(
//                 item =>
//                     item.productId.toString() === productId &&
//                     item.variantName === variantName
//             );

//             if (existingItem) {
//                 existingItem.quantity += quantity;
//             } else {
//                 order.items.push({
//                     productId,
//                     name: product.fullName,
//                     price: product.sellingPrice[product.sellingPrice.length - 1]?.price || 0,
//                     variantName,
//                     quantity
//                 });
//             }

//             // Recalculate subtotal and deliveryCharge
//             let subtotal = 0;
//             const categoryCharges = new Map();

//             for (const item of order.items) {
//                 const prod = await Product.findOne({ _id: item.productId })
//                     .session(session)
//                     .populate("category")
//                     .exec();

//                 if (!prod || !prod.category) {
//                     throw new ApiError(400, `Product or category missing for ${item.productId}`);
//                 }

//                 subtotal += item.price * item.quantity;

//                 const categoryId = prod.category._id.toString();
//                 const deliveryCharge = prod.category.deliveryCharge || 0;

//                 if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
//                     categoryCharges.set(categoryId, deliveryCharge);
//                 }
//             }

//             let values = Array.from(categoryCharges.values());
//             let totalDeliveryCharge = Math.max(...values);

//             if (!isFinite(totalDeliveryCharge) || totalDeliveryCharge === undefined) {
//                 totalDeliveryCharge = 0;
//             }

//             order.subtotal = subtotal;
//             order.deliveryCharge = totalDeliveryCharge;
//             order.orderAmount = subtotal - (order.discount || 0) + totalDeliveryCharge;

//             updatedOrder = await order.save({ session });
//         });

//         return res
//             .status(200)
//             .json(new ApiResponse(200, updatedOrder, "Item quantity added successfully"));

//     } catch (err) {
//         console.error("Add Item Quantity Error:", err.message);
//         return res.status(500).json({
//             success: false,
//             message: err.message || "Internal server error"
//         });
//     } finally {
//         session.endSession();
//     }
// };

// const removeItemQuantityInOrder = async (req, res) => {
//     const session = await mongoose.startSession();

//     try {
//         const {
//             orderId,
//             productId,
//             variantName,
//             quantity = 1
//         } = req.body;

//         if (!orderId || !productId || !variantName || !quantity || quantity <= 0) {
//             throw new ApiError(400, "All fields are required and quantity must be > 0");
//         }

//         let updatedOrder;

//         await session.withTransaction(async () => {
//             const [order, product] = await Promise.all([
//                 Order.findById(orderId).session(session),
//                 Product.findById(productId).populate("category").session(session)
//             ]);

//             if (!order) throw new ApiError(404, "Order not found");
//             if (!product) throw new ApiError(404, "Product not found");

//             // Find item in order
//             const existingItemIndex = order.items.findIndex(
//                 item =>
//                     item.productId.toString() === productId &&
//                     item.variantName === variantName
//             );

//             if (existingItemIndex === -1) {
//                 throw new ApiError(400, "Item not found in order");
//             }

//             const existingItem = order.items[existingItemIndex];

//             if (existingItem.quantity < quantity) {
//                 throw new ApiError(400, "Cannot remove more quantity than exists in order");
//             }

//             // Restore stock
//             const currentVariantStock = product.variants.get(variantName) || 0;
//             product.totalStock += quantity;
//             product.variants.set(variantName, currentVariantStock + quantity);
//             await product.save({ session });

//             // Decrease quantity or remove item
//             existingItem.quantity -= quantity;
//             if (existingItem.quantity <= 0) {
//                 order.items.splice(existingItemIndex, 1);
//             }

//             // 🔁 Recalculate subtotal, deliveryCharge, and orderAmount
//             let subtotal = 0;
//             const categoryCharges = new Map();

//             for (const item of order.items) {
//                 console.log("inside items: ", item);
//                 const p = await Product.findOne({ _id: item.productId })
//                     .session(session)
//                     .populate("category")
//                     .exec();

//                 if (!p || !p.category) {
//                     throw new ApiError(400, `Product or category missing for ${item.productId}`);
//                 }

//                 subtotal += item.price * item.quantity;

//                 const categoryId = p.category._id.toString();
//                 const deliveryCharge = p.category.deliveryCharge || 0;

//                 if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
//                     categoryCharges.set(categoryId, deliveryCharge);
//                 }
//             }

//             let values = Array.from(categoryCharges.values());
//             let totalDeliveryCharge = Math.max(...values);

//             if (!isFinite(totalDeliveryCharge) || totalDeliveryCharge === undefined) {
//                 totalDeliveryCharge = 0;
//             }

//             order.subtotal = subtotal;
//             order.deliveryCharge = totalDeliveryCharge;
//             order.orderAmount = subtotal - (order.discount || 0) + totalDeliveryCharge;

//             updatedOrder = await order.save({ session });
//         });

//         return res.status(200).json(
//             new ApiResponse(200, updatedOrder, "Item quantity removed successfully")
//         );

//     } catch (err) {
//         console.error("Remove Item Quantity Error:", err.message);
//         return res.status(500).json({
//             success: false,
//             message: err.message || "Internal server error"
//         });
//     } finally {
//         session.endSession();
//     }
// };



// const verifyPayment = async (req, res) => {
//     const session = await mongoose.startSession();

//     try {
//         const {
//             razorpay_order_id,
//             razorpay_payment_id,
//             razorpay_signature,
//             orderId: dbOrderId
//         } = req.body;

//         if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !dbOrderId) {
//             throw new ApiError(400, 'Payment verification details missing.');
//         }

//         // 1️⃣ Verify Signature
//         const generatedSignature = crypto
//             .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
//             .update(`${razorpay_order_id}|${razorpay_payment_id}`)
//             .digest('hex');

//         const isValid = generatedSignature === razorpay_signature;

//         const order = await Order.findById(dbOrderId).populate('items.productId');
//         if (!order) throw new ApiError(404, 'Order not found.');

//         // const cart = await Cart.findOne({ userId: order.userId });
//         const cart = await Cart.findById(req?.user?.cart);
//         // console.log("Cart Before:", cart);

//         let updatedUser = null;

//         if (isValid) {

//             const nextOrderId = await Order.generateNextOrderId()
//             // ✅ Payment Verified
//             await session.withTransaction(async () => {
//                 order.abondonedOrder = false;
//                 order.paymentStatus = 'Paid';
//                 order.razorpayOrderId = razorpay_order_id;
//                 order.razorpayPaymentId = razorpay_payment_id;
//                 order.orderId = nextOrderId
//                 await order.save({ session });

//                 const uniqueProductIds = [
//                     ...new Set(order.items.map(it => it.productId._id.toString()))
//                 ];

//                 // Update Stock
//                 for (const item of order.items) {
//                     // ✅ Ensure quantity is a positive integer
//                     const qty = Math.floor(Number(item.quantity));
//                     if (!Number.isInteger(qty) || qty <= 0) {
//                         throw new Error(`Invalid quantity for product ${item.productId?._id || item.productId}: ${item.quantity}`);
//                     }

//                     // ✅ Fetch product (just variants)
//                     const product = await Product.findById(item.productId._id)
//                         .session(session)
//                         .select('variants')
//                         .lean();

//                     if (!product) {
//                         throw new Error(`Product not found: ${item.productId._id}`);
//                     }

//                     // ✅ Strictly case-sensitive variant name
//                     const variantKey = String(item.variantName || '').trim();
//                     if (!variantKey) {
//                         throw new Error(`Missing variantName for product ${item.productId._id}`);
//                     }

//                     // Ensure the variant exists exactly as typed (case-sensitive)
//                     if (!product.variants || !Object.prototype.hasOwnProperty.call(product.variants, variantKey)) {
//                         throw new Error(`Variant "${variantKey}" not found for product ${item.productId._id}`);
//                     }

//                     // ✅ Atomic decrement only if enough stock exists
//                     const result = await Product.updateOne(
//                         {
//                             _id: item.productId._id,
//                             totalStock: { $gte: qty },
//                             [`variants.${variantKey}`]: { $gte: qty }
//                         },
//                         {
//                             $inc: {
//                                 totalStock: -qty,
//                                 [`variants.${variantKey}`]: -qty
//                             }
//                         },
//                         { session }
//                     );

//                     // ✅ Throw if insufficient stock or race condition
//                     if (result.modifiedCount === 0) {
//                         throw new Error(
//                             `Insufficient stock for product ${item.productId._id}, variant "${variantKey}" (requested ${qty})`
//                         );
//                     }
//                 }

//                 // for (const item of order.items) {
//                 //     await Product.updateOne(
//                 //         {
//                 //             _id: item.productId._id,
//                 //             totalStock: { $gte: item.quantity },
//                 //             [`variants.${item.variantName}`]: { $gte: item.quantity }
//                 //         },
//                 //         {
//                 //             $inc: {
//                 //                 totalStock: -item.quantity,
//                 //                 [`variants.${item.variantName}`]: -item.quantity
//                 //             }
//                 //         },
//                 //         { session }
//                 //     );
//                 // }

//                 await Product.updateMany(
//                     { _id: { $in: uniqueProductIds } },
//                     { $push: { orders: order._id } },
//                     { session }
//                 );

//                 // If stock update successfull then clear cart
//                 cart.items = [];
//                 cart.totalCartValue = 0;
//                 await cart.save({ session });
//                 // console.log("Cart After:", cart);

//                 // update the user and return the user details
//                 updatedUser = await User.findByIdAndUpdate(
//                     order.userId,
//                     { $push: { orders: order._id } },
//                     { new: true, session }
//                 ).select('-password -refreshToken')
//                     .populate({
//                         path: "cart",
//                         populate: {
//                             path: "items.productId",
//                             model: "Product",
//                             populate: {
//                                 path: "category",  // This is the key part
//                                 model: "SubCategory"
//                             }
//                         }
//                     })
//                     .populate("wishlist")
//                     .populate("address")
//                     .populate("orders")
//                     .exec();
//             });

//             return res.status(200).json(
//                 new ApiResponse(200, { order, user: updatedUser }, "Payment Verified. Order Completed")
//             );
//         }

//         // ❌ Payment Verification Failed
//         // await session.withTransaction(async () => {
//         //     order.abondonedOrder = true;
//         //     await order.save({ session });

//         //     const newCart = new Cart({
//         //         userId: cart.userId,
//         //         items: cart.items,
//         //         totalCartValue: cart.totalCartValue
//         //     });

//         //     await newCart.save({ session });

//         //     updatedUser = await User.findByIdAndUpdate(
//         //         cart.userId,
//         //         { cart: newCart._id },
//         //         { new: true, session }
//         //     ).select('-password -refreshToken')
//         //         .populate({
//         //             path: "cart",
//         //             populate: {
//         //                 path: "items.productId",
//         //                 model: "Product",
//         //                 populate: {
//         //                     path: "category",  // This is the key part
//         //                     model: "SubCategory"
//         //                 }
//         //             }
//         //         })
//         //         .populate("wishlist")
//         //         .populate("address")
//         //         .populate("orders")
//         //         .exec();

//         //     await Cart.findByIdAndDelete(cart._id, { session });
//         // });

//         return res.status(400).json(
//             new ApiResponse(400, { user: updatedUser }, 'Payment Failed. Cart Restored')
//         );

//     } catch (err) {
//         console.error('verifyPayment error:', err);
//         return res.status(500).json({ message: err.message || 'Internal server error' });
//     } finally {
//         session.endSession();
//     }
// };

//When order is accepted this will be called to create order in shiprocket, assign courier and mark it shipped

const acceptOrder = asyncHandler(async (req, res, next) => {
    try {
        const { shiprocketToken } = req;
        const { orderId, reason } = req.body;

        //Validate Order Id
        if (!orderId) {
            throw new ApiError(400, 'Order Id not Found');
        }

        //check if order exist
        const foundOrder = await Order.findById(orderId)
            .populate({
                path: 'userId',
                select: "-password -refreshToken"
            })
            .populate({
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            })
            .populate('addressId')
            .exec();
        // console.log("Found Order", foundOrder);
        if (!foundOrder) {
            throw new ApiError(400, 'Order does not exist');
        }

        if (foundOrder && foundOrder?.abondonedOrder)
            return res.status(404).json({ message: `Order is Abandoned` });

        // if (foundOrder && foundOrder?.status != "New")
        //     return res.status(404).json({ message: `Order is ${foundOrder?.status}` });

        if (foundOrder && foundOrder?.status != "New" && foundOrder?.status != "Accepted" && foundOrder?.status != "Hold")
            return res.status(404).json({ message: `Order is ${foundOrder?.status}` });

        //Format the items name
        const order_items = foundOrder.items.map((item) => {
            const variant = item.variantName || ""; // e.g. "Red / XL"
            const itemName = item.productId.fullName + (variant ? `\n , ${variant}` : "")

            return {
                name: `${itemName.slice(0, 200)}`, // Two-line name
                sku: item?._id || uuidv4().split('-')[0].toUpperCase() || item?.productId?._id,
                // hsn: item?.productId?.hsn || uuidv4().split('-')[0].toUpperCase().slice(0, 8),
                // sku: `${item.productId._id}-${variant.replace(/\s+/g, "_").toUpperCase()}`,
                units: item.quantity,
                selling_price: item.price,
                tax: item?.productId?.gst
            };
        });

        console.log(process.env.WARHOUSE);
        //Create the shiprocket payload for order creation
        const payload = {
            order_id: foundOrder.orderId || foundOrder._id,
            order_date: foundOrder.createdAt || new Date().toISOString().split("T")[0],
            pickup_location: process.env.WARHOUSE || "Default Address",
            billing_customer_name: foundOrder.name,
            billing_last_name: "",
            billing_address: foundOrder?.address || "Rohini Delhi",
            billing_address_2: foundOrder?.address2 || "",
            billing_city: foundOrder?.city || foundOrder.addressId?.city,
            billing_pincode: foundOrder?.pincode?.trim() || foundOrder.addressId?.pinCode?.trim(),
            billing_state: foundOrder?.state || foundOrder.addressId?.state,
            billing_country: foundOrder?.country || "India",
            // billing_email: foundOrder?.email ? foundOrder.email : "",
            billing_phone: foundOrder?.phoneNo,
            shipping_is_billing: true,
            order_items,                                   // ← variant‑aware items
            payment_method: foundOrder?.method === "Online" ? "Prepaid" : "COD",
            shipping_charges: foundOrder?.deliveryCharge || 0,
            total_discount: foundOrder?.discount || 0,
            sub_total: foundOrder?.subtotal,
            length: foundOrder?.length || 10,
            breadth: foundOrder?.breadth || 10,
            height: foundOrder?.height || 10,
            weight: foundOrder?.weight || 0.5
        };

        // create order on shiprocket and get the shipmnet Id
        const { data } = await axios.post('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', payload, {
            headers: {
                Authorization: `Bearer ${shiprocketToken}`
            }
        });
        console.log("shiprocket order creation response", data);
        // console.log("New Order: ", data, "Payload sent: ", payload);

        if (!data?.shipment_id) {
            throw new ApiError(409, data?.message || 'Could create order at Shiprocket');
        }

        let updatedOrder = await Order.findByIdAndUpdate(
            foundOrder?._id,
            {
                shipmentId: data?.shipment_id,
                shiprocketOrderId: data?.order_id,
                shiprocketChannelId: data?.channel_order_id,
                shiprocketOrderCreatedAt: new Date(),
            },
            { new: true }
        ).populate({
            path: 'userId',
            select: "-password -refreshToken"
        })
            .populate({
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            })
            .populate('addressId')
            .exec();

        await logActivity({
            orderId: updatedOrder._id,
            action: "Accepted",
            remarks: `Order accepted by admin. Reason/remarks: ${reason || "N/A"}`,
            req
        });

        req.order = updatedOrder;
        next();
        // return res.status(200).json(
        //     new ApiResponse(200, { shipmentId: data?.shipment_id }, "Order created with Shiprocket")
        //     // { message: 'Order created with Shiprocket', shipmentId: data?.shipment_id }
        // );

    } catch (err) {
        console.error("Shiprocket Order Error:", err?.response?.data || err);
        res.status(500).json({ error: err?.response?.data || err?.message || 'Shiprocket order creation failed' });
    }
});

// ******************************************************
//                 HOLD ABANDONED ORDER CONTROLLERS
// ******************************************************

const holdAbandonedOrder = asyncHandler(async (req, res, next) => {
    const { orderId, reason } = req.body;
    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, 'Order not found');
    if (order && order?.status === "Hold") throw new ApiError(404, 'Order already on hold');
    // if (order && !order?.abondonedOrder) throw new ApiError(404, 'Not an abandoned order');

    order.status = 'Hold';
    order.reason = reason;
    const savedOrder = await order.save();
    if (!savedOrder) {
        throw new ApiError(500, "Could not hold order");
    }

    await logActivity({
        orderId: order._id,
        action: "Hold",
        remarks: reason || "Order placed on hold by admin.",
        req
    });

    return res.json({ message: 'Order put on Hold' });
});

// ******************************************************
//                 REJECT ORDER CONTROLLERS
// ******************************************************

const getOrdersByRequestType = asyncHandler(async (req, res) => {
    const requestType = req?.query?.requestType;
    const startDate = req?.query?.startDate;
    const endDate = req?.query?.endDate;
    const status = req?.query?.status;
    const searchQuery = req?.query?.searchQuery?.trim();

    const page = Math.max(1, parseInt(req?.query?.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req?.query?.limit) || 10));
    const skip = (page - 1) * limit;

    if (!requestType || !["Cancel", "Return", "Warranty"].includes(requestType)) {
        throw new ApiError(400, "Invalid or missing requestType");
    }

    let requestFilter = {
        type: requestType,
    };

    if (status && status !== "all") {
        requestFilter.status = status;
    }

    if (startDate && endDate && !searchQuery) {
        const start = new Date(`${startDate}T00:00:00+05:30`);
        const end = new Date(`${endDate}T23:59:59.999+05:30`);
        requestFilter.createdAt = { $gte: start, $lte: end };
    }

    let query = {
        requests: {
            $elemMatch: requestFilter
        }
    };

    if (searchQuery) {
        const words = searchQuery.split(/\s+/).filter(Boolean);
        const regexArray = words.map(w => new RegExp(w, "i"));

        // User lookup to search by user profile
        const User = mongoose.model("User");
        const matchingUsers = await User.find({
            $or: [
                { name: { $in: regexArray } },
                { email: { $in: regexArray } },
                { phone: { $in: regexArray } }
            ]
        }).select("_id").lean();
        const matchingUserIds = matchingUsers.map(u => u._id);

        query.$or = [
            { orderId: { $in: regexArray } },
            { phoneNo: { $in: regexArray } },
            { name: { $in: regexArray } },
            { "requests.reason": { $in: regexArray } },
            { userId: { $in: matchingUserIds } }
        ];
    }

    // Build base filter for status counts (matching selected date range if not searching)
    let baseCountFilter = {
        type: requestType
    };
    if (startDate && endDate && !searchQuery) {
        const start = new Date(`${startDate}T00:00:00+05:30`);
        const end = new Date(`${endDate}T23:59:59.999+05:30`);
        baseCountFilter.createdAt = { $gte: start, $lte: end };
    }

    const [orders, totalCount, pendingCount, acceptedCount, rejectedCount] = await Promise.all([
        Order.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate({
                path: 'userId',
                model: "User",
                select: "name email phoneNo",
                populate: { path: "orders", model: "Order", select: "status" }
            })
            .populate({
                path: "items.productId",
                model: "Product",
                select: "fullName"
            })
            .lean()
            .cursor() // this avoids loading full dataset
            .toArray(), // safely materializes only this page
        Order.countDocuments(query),
        Order.countDocuments({
            requests: {
                $elemMatch: { ...baseCountFilter, status: "Pending" }
            }
        }),
        Order.countDocuments({
            requests: {
                $elemMatch: { ...baseCountFilter, status: "Accepted" }
            }
        }),
        Order.countDocuments({
            requests: {
                $elemMatch: { ...baseCountFilter, status: "Rejected" }
            }
        })
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    return res.status(200).json(
        new ApiResponse(200, {
            orders,
            totalCount,
            pendingCount,
            acceptedCount,
            rejectedCount,
            pagination: {
                page,
                limit,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1
            }
        }, "Orders filtered by request type")
    );
});


// ******************************************************
//                  FETCH ORDERS CONTROLLERS
// ******************************************************

const getFilteredOrdersByDate = asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    /* ------------------------- 1. Validate Inputs ------------------------- */
    if (!startDate || !endDate) {
        throw new ApiError(400, "Start date and end date are required");
    }

    const from = new Date(`${startDate}T00:00:00+05:30`);
    const to = new Date(`${endDate}T23:59:59.999+05:30`);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        throw new ApiError(400, "Invalid date format provided");
    }

    /* ------------------------- 2. Define Filters -------------------------- */
    const filters = {
        createdAt: { $gte: from, $lte: to },
        abondonedOrder: false,
        status: { $nin: ["Rejected", "Cancelled", "Returned", "Replaced", "Hold"] }
    };

    /* ---------------------- 3. Fetch Orders in Range ---------------------- */
    const orders = await Order.find(filters)
        .populate({
            path: "userId",
            model: "User",
            select: "-password -refreshToken",
            populate: {
                path: "orders",
                model: "Order"
            }
        })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: {
                path: "category",
                model: "SubCategory"
            }
        })
        .sort({ createdAt: -1 });

    /* --------------------------- 4. Respond ------------------------------- */
    return res
        .status(200)
        .json(new ApiResponse(200, orders, "Orders fetched successfully"));
});

// const getOrdersByDate = asyncHandler(async (req, res) => {
//     const { startDate, endDate } = req.query;

//     /* ------------------------- 1. Validate Inputs ------------------------- */
//     if (!startDate || !endDate) {
//         throw new ApiError(400, "Start date and end date are required");
//     }

//     const from = new Date(startDate);
//     const to = new Date(new Date(endDate).setHours(23, 59, 59, 999)); // End of the day

//     if (isNaN(from.getTime()) || isNaN(to.getTime())) {
//         throw new ApiError(400, "Invalid date format provided");
//     }

//     /* ---------------------- 2. Fetch Orders in Range ---------------------- */
//     const orders = await Order.find({
//         createdAt: {
//             $gte: from,
//             $lte: to,
//         },
//     })
//         .sort({ createdAt: 1 })
//         .populate({
//             path: 'userId',
//             model: "User",
//             select: "_id",
//             // select: "-password -refreshToken",
//             // populate: {
//             //     path: "orders",  // This is the key part
//             //     model: "Order"
//             // }
//         })
//         .populate({
//             path: "items.productId",
//             model: "Product",
//             select: "_id name",
//             // populate: {
//             //     path: "category",  // This is the key part
//             //     model: "SubCategory"
//             // }
//         })
//         .lean()
//         .cursor() // this avoids loading full dataset
//         .toArray();
//     // .exec()

//     /* --------------------------- 3. Respond ------------------------------- */
//     return res
//         .status(200)
//         .json(new ApiResponse(200, orders, "Orders fetched successfully"));
// });
// import asyncHandler from "../utils/asyncHandler.js";
// import ApiError from "../utils/ApiError.js";


// const getOrdersByDate = asyncHandler(async (req, res) => {
//     const { startDate, endDate } = req.query;

//     /* ------------------------- 1. Validate Inputs ------------------------- */
//     if (!startDate || !endDate) {
//         throw new ApiError(400, "Start date and end date are required");
//     }

//     const from = new Date(startDate);
//     const to = new Date(new Date(endDate).setHours(23, 59, 59, 999));

//     if (isNaN(from.getTime()) || isNaN(to.getTime())) {
//         throw new ApiError(400, "Invalid date format provided");
//     }

//     /* ------------------------- 2. Setup Excel ------------------------- */
//     res.setHeader(
//         "Content-Type",
//         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
//     );
//     res.setHeader(
//         "Content-Disposition",
//         `attachment; filename=orders_${startDate}_to_${endDate}.xlsx`
//     );

//     const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
//     const worksheet = workbook.addWorksheet("Orders");

//     const headers = [
//         "_id", "orderId", "createdAt", "type", "method", "status", "shippingStatus", "paymentStatus", "paymentDate",
//         "name", "phoneNo", "userId", "itemNo", "productId", "name_item", "fullName", "variant", "quantity", "price",
//         "subtotal", "deliveryCharge", "discount", "orderAmount", "gst", "isAppOrder", "abondonedOrder", "pickupScheduled",
//         "length", "breadth", "height", "weight", "updatedAt"
//     ];

//     worksheet.addRow(headers).commit();

//     /* --------------------- 3. Stream Orders in Range --------------------- */
//     const cursor = Order.find({
//         createdAt: { $gte: from, $lte: to }
//     })
//         .sort({ createdAt: 1 })
//         .populate("userId", "_id name phoneNo")
//         .populate("items.productId", "_id name")
//         .lean()
//         .cursor();

//     for await (const order of cursor) {
//         const rows = flattenOrder([order]); // convert each order into rows
//         rows.forEach((row) => {
//             const rowData = headers.map((h) => row[h] ?? "");
//             worksheet.addRow(rowData).commit();
//         });
//     }

//     await workbook.commit(); // finalize and flush to response
// });

const getOrdersByDate = asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    console.log("📥 Incoming export request:", { startDate, endDate });

    if (!startDate || !endDate) {
        console.error("❌ Missing date parameters");
        throw new ApiError(400, "Start date and end date are required");
    }

    const from = new Date(`${startDate}T00:00:00+05:30`);
    const to = new Date(`${endDate}T23:59:59.999+05:30`);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        console.error("❌ Invalid date format", { from, to });
        throw new ApiError(400, "Invalid date format provided");
    }

    console.log("✅ Validated date range:", { from, to });

    // Excel Headers
    res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
        "Content-Disposition",
        `attachment; filename=orders_${startDate}_to_${endDate}.xlsx`
    );

    console.log("📤 Response headers set for Excel export");

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const worksheet = workbook.addWorksheet("Orders");

    const headers = [
        "_id", "orderId", "createdAt", "type", "method", "status", "shippingStatus", "paymentStatus", "paymentDate",
        "name", "phoneNo", "userId", "itemNo", "productId", "fullName", "variant", "quantity", "price",
        "subtotal", "deliveryCharge", "discount", "orderAmount", "gst", "isAppOrder", "abondonedOrder", "pickupScheduled",
        "length", "breadth", "height", "weight", "updatedAt"
    ];

    worksheet.addRow(headers).commit();
    console.log("📑 Headers written:", headers);

    const cursor = Order.find({
        createdAt: { $gte: from, $lte: to }
    })
        .sort({ createdAt: 1 })
        .populate("userId", "_id name phoneNo")
        .populate("items.productId", "_id name fullName")
        .lean()
        .cursor();

    let count = 0;
    for await (const order of cursor) {
        const rows = flattenOrder([order]);
        rows.forEach((row) => {
            const rowData = headers.map((h) => row[h] ?? "");
            worksheet.addRow(rowData).commit();
        });
        count++;
        if (count % 100 === 0) console.log(`📦 Processed ${count} orders...`);
    }

    console.log(`✅ Finished processing ${count} orders`);
    await workbook.commit();
    console.log("📤 Workbook committed and response sent");
});

// const getAllOrdersByUser = asyncHandler(async (req, res) => {

//     // console.log("User", req?.user?._id);
//     const userOrders = await Order.find(
//         { userId: req?.user?._id, abondonedOrder: false },
//         // {  }
//     )
//         .populate({
//             path: 'userId',
//             model: "User",
//             select: "-password -refreshToken",
//             populate: {
//                 path: "orders",  // This is the key part
//                 model: "Order"
//             }
//         })
//         .populate({
//             path: "items.productId",
//             model: "Product",
//             // populate: {
//             //     path: "category",  // This is the key part
//             //     model: "SubCategory"
//             // }
//         })
//         .populate({
//             path: "query",
//             populate: {
//                 path: "replies.messagedBy",
//                 model: "User",
//                 select: "name email phone role"
//             }
//         })
//         .sort({ createdAt: -1 })
//     // .exec();

//     if (!userOrders) {
//         throw new ApiError(500, "Something went wrong while fetching the orders")
//     }

//     return res.status(200).json(
//         new ApiResponse(200, userOrders, "Orders fetched successfully")
//     )

// })

const getAllOrdersByUser = asyncHandler(async (req, res) => {

    // console.log("User", req?.user?._id);

    const userDetails = await User.findById(req?.user?._id)
        .select("orders")
        .populate({
            path: "orders",  // This is the key part
            model: "Order"
        })
        .populate({
            path: "orders",  // This is the key part
            model: "Order",
            populate: {
                path: "coupon",
                model: "Coupon",
                select: "code type value percent"
            }
        })
        .populate({
            path: "orders",  // This is the key part
            model: "Order",
            populate: {
                path: "items.productId",
                model: "Product",
                select: "name images fullName "
            }
        })
        .populate({
            path: "orders",  // This is the key part
            model: "Order",
            populate: {
                path: "query",
                model: "Query",
                populate: {
                    path: "replies.messagedBy",
                    model: "User",
                    select: "name email phone role"
                }
            }
        })

    console.log("Orders:", userDetails?.orders?.length)

    const userOrders = userDetails?.orders;
    if (!userOrders) {
        throw new ApiError(500, "Something went wrong while fetching the orders")
    }

    return res.status(200).json(
        new ApiResponse(200, userOrders, "Orders fetched successfully")
    )

})

const getOrderById = asyncHandler(async (req, res) => {

    if (!req?.params?._id) {
        throw new ApiError(400, "Order Id not found");
    }

    const order = await Order.findById(req?.params?._id)
        .populate({
            path: 'userId',
            model: "User",
            select: "-password -refreshToken",
            populate: {
                path: "orders",  // This is the key part
                model: "Order"
            }
        })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: {
                path: "category",  // This is the key part
                model: "SubCategory"
            }
        })
        .populate("addressId")
        .populate({
            path: "callAttempts.history.employeeId",
            model: "User",
            select: "name email role"
        })
        .populate({
            path: "refundedBy",
            model: "User",
            select: "name email role"
        })
        .populate({
            path: "partialReturnRequests",
            model: "PartialRequest"
        })
        .exec();

    if (!order) {
        throw new ApiError(409, "Could not find order");
    }

    const activityLogs = await ActivityLog.find({ orderId: order._id })
        .populate("performedBy", "name email role")
        .sort({ createdAt: -1 });

    const orderJson = order.toJSON();
    orderJson.activityLogs = activityLogs || [];

    return res.status(200).json(
        new ApiResponse(200, orderJson, "Order fetched Successfully")
    );
});

const getAllOrders = asyncHandler(async (req, res) => {
    const allOrder = await Order.find({})
        .populate({
            path: 'userId',
            model: "User",
            select: "-password -refreshToken",
            populate: {
                path: "orders",  // This is the key part
                model: "Order"
            }
        })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: {
                path: "category",  // This is the key part
                model: "SubCategory"
            }
        })
        .sort({ createdAt: -1 })
    // .exec();

    if (!allOrder) {
        throw new ApiError(409, "Could not find orders");
    }

    return res.status(200).json(
        new ApiResponse(200, allOrder, "Orders fetched Successfully")
    )
});

const createAbandonedOrderFromCart = async (cartId, userId, address) => {
    if (!cartId || !userId
        // || !address
    ) {
        throw new Error("Cart ID, User ID, and address are required.");
    }

    const cart = await Cart.findById(cartId).populate("items.productId").populate("userId");
    if (!cart || cart.items.length === 0) {
        throw new Error("Cart not found or empty.");
    }

    let subtotal = 0;
    cart.items.forEach(item => {
        subtotal += item.quantity * item.price;
    });

    // const deliveryCharge = subtotal >= 500 ? 0 : 40;
    // const discount = 0;
    // const gst = parseFloat((subtotal * 0.18).toFixed(2));
    const orderAmount = subtotal;

    const newOrder = new Order({
        orderId: `ORD-${uuidv4()}`,
        userId,
        orderAmount,
        address,
        name: cart?.userId?.name,
        phoneNo: cart?.userId?.phoneNo,
        email: cart?.userId?.email,
        // deliveryCharge,
        // discount,
        // gst,
        subtotal,
        orderState: "Abandoned",
        abondonedOrder: true,
        isAppOrder: false,
        method: "COD",
        items: cart.items.map(item => ({
            productId: item.productId._id,
            variantName: item.variantName,
            quantity: item.quantity,
            price: item.price,
        })),
    });

    await newOrder.save();
    return newOrder;
};


// ******************************************************
//                  ORDER CANCELLATION CONTROLLERS
// ******************************************************

// Utility: adjust stock back to inventory
/* ─────────────────────────────────────────────────────────────────────
   adjustStock — Cancel / Reject / Manual Return pe stock wapas karta hai
   Caller apna session pass kar sakta hai — order.save() ke saath atomic
   Fix: _restockDone: { $ne: true } — purane orders bhi correctly handle
───────────────────────────────────────────────────────────────────── */
async function performAdjustStock(
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
                `[adjustStock] Skipped — _restockDone already true ` +
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
                    category: "physical",
                    isScratchy: true
                });
            } else {
                const variant = await Variant.findOneAndUpdate(
                    { _id: item.variantId },
                    { $inc: { availableStock: qty, totalStock: qty } },
                    { new: true, session }
                );

                if (variant) {
                    const previousAvailable = variant.availableStock - qty;
                    const previousPhysical = variant.totalStock - qty;

                    if (!item.purchaseSets || item.purchaseSets.length === 0) {
                        const fallbackSetId = item.purchaseSetId || (variant.purchaseSets[0] ? String(variant.purchaseSets[0]._id) : "");
                        item.purchaseSets = [{
                            purchaseSetId: fallbackSetId,
                            quantity: qty,
                            price: item.purchasePrice || (variant.purchaseSets[0]?.price || 0)
                        }];
                        item.purchaseSetId = fallbackSetId;
                    }

                    for (const alloc of item.purchaseSets) {
                        if (alloc.purchaseSetId) {
                            const set = variant.purchaseSets.id(alloc.purchaseSetId);
                            if (set) {
                                set.remainingStock += alloc.quantity;
                                set.availableStock += alloc.quantity;
                            }
                        } else if (variant.purchaseSets.length > 0) {
                            variant.purchaseSets[0].remainingStock += alloc.quantity;
                            variant.purchaseSets[0].availableStock += alloc.quantity;
                        }
                    }

                    await variant.save({ session });

                    // Sync parent product and inventory stock levels
                    await syncProductStock(productId, session);

                    // Fetch parent product to get updated totalProductStock for logging
                    const parentProduct = await Product.findById(productId).session(session);
                    const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                    stockEntries.push({
                        orderId: lockedOrder.orderId,
                        orderRef: lockedOrder._id,
                        type,
                        category: "physical",
                        variantId: variant._id,
                        variantName: variant.name,
                        quantity: qty,
                        previousStock: previousAvailable,
                        updatedStock: variant.availableStock,
                        previousPhysicalStock: previousPhysical,
                        updatedPhysicalStock: variant.totalStock,
                        totalProductStock: currentTotalProductStock,
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
        console.error("[adjustStock] failed:", err);
        throw err;
    } finally {
        if (ownSession) session.endSession();
    }
}

async function adjustStock(order, options = {}) {
    return performAdjustStock(order, options);
}

async function adjustStockV2(order, options = {}) {
    return performAdjustStock(order, options);
}


const updateRequestStatus = (requests, reason) => {
    const updatedRequests = requests?.map((r) => {
        if (r?.type === "Cancel" && !r?.isResolved) {
            r.isResolved = true;
            r.status = "Accepted";
            r.resolvedAt = new Date().toISOString();
            r.reason = r?.reason ? r.reason : reason;
        }
        return r;
    });
    return updatedRequests;
}

const rejectAllRequest = (requests, reason) => {
    const updatedRequests = requests?.map((r) => {
        r.isResolved = true;
        r.status = "Rejected";
        r.resolvedAt = new Date().toISOString();
        r.reason = r?.reason ? r.reason : reason;
        return r;
    });
    return updatedRequests;
}

// preShiprocketReject — order_controller.js
const preShiprocketReject = async (req, res, next) => {
    const { orderId, reason } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order?.status === "Rejected") return res.status(400).json({ message: 'Order already rejected' });

    if (!order.shipmentId) {
        // ✅ Single transaction: order.save() + adjustStock() are now atomic
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                order.status = 'Rejected';
                order.reason = reason;
                order.requests = rejectAllRequest(order.requests, "Order Rejected");
                await order.save({ session });

                await adjustStock(order, { type: STOCK_TYPES.REJECT, session });

                await logActivity({
                    orderId: order._id,
                    action: "Rejected",
                    remarks: reason || "Order rejected by admin.",
                    req,
                    session
                });
            });
        } finally {
            session.endSession();
        }
        return res.json({ message: 'Order rejected, stock restored' });
    } else {
        req.order = order;
        next();
    }
};


// createdReject — order_controller.js
const createdReject = async (req, res, next) => {
    const order = req.order;
    const { reason } = req.body;

    if (order?.shipmentId && !order?.awbCode) {
        // Shiprocket cancel is external HTTP — must happen BEFORE our transaction
        await axios.post(
            'https://apiv2.shiprocket.in/v1/external/orders/cancel',
            { ids: [order.shiprocketOrderId] },
            { headers: { Authorization: `Bearer ${req.shiprocketToken}` } }
        );

        // ✅ Single transaction: order save + stock restore atomic
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                order.status = 'Rejected';
                order.reason = reason;
                order.requests = rejectAllRequest(order.requests, reason);
                await order.save({ session });

                await adjustStock(order, { type: STOCK_TYPES.REJECT, session });

                await logActivity({
                    orderId: order._id,
                    action: "Rejected",
                    remarks: reason || "Order rejected by admin.",
                    req,
                    session
                });
            });
        } finally {
            session.endSession();
        }
        return res.json({ message: 'Order cancelled on Shiprocket, marked Rejected, stock restored' });
    } else {
        next();
    }
};


//  awbReject — order_controller.js
const awbReject = async (req, res) => {
    const order = req.order;
    const { reason } = req.body;

    if (order?.awbCode && !order?.pickupDate) {
        // Shiprocket calls are external — do these first, outside transaction
        await axios.post(
            'https://apiv2.shiprocket.in/v1/external/orders/cancel/shipment/awbs',
            { awbs: [order.awbCode] },
            { headers: { Authorization: `Bearer ${req.shiprocketToken}` } }
        );
        await axios.post(
            'https://apiv2.shiprocket.in/v1/external/orders/cancel',
            { ids: [order.shiprocketOrderId] },
            { headers: { Authorization: `Bearer ${req.shiprocketToken}` } }
        );

        // ✅ Single transaction: order save + stock restore atomic
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                order.status = 'Rejected';
                order.reason = reason;
                order.requests = rejectAllRequest(order.requests, reason);
                await order.save({ session });

                await adjustStock(order, { type: STOCK_TYPES.REJECT, session });

                await logActivity({
                    orderId: order._id,
                    action: "Rejected",
                    remarks: reason || "Order rejected by admin.",
                    req,
                    session
                });
            });
        } finally {
            session.endSession();
        }
        return res.json({ message: 'Courier and order cancelled on Shiprocket, marked rejected, stock restored' });
    } else {
        return res.status(400).json({ message: 'Could not reject order' });
    }
};


// preShiprocketCancel — order_controller.js
const preShiprocketCancel = async (req, res, next) => {
    const { orderId, reason } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order?.status === "Cancelled") return res.status(400).json({ message: 'Order already cancelled' });

    if (!order.shipmentId || order.status === "Delivered") {
        // ✅ Atomic: order status change + stock restore in one transaction
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                order.status = 'Cancelled';
                order.reason = reason;
                order.requests = updateRequestStatus(order.requests, reason);
                await order.save({ session });

                if (order?.type === ORDER_TYPES.POS) {
                    await adjustStockV2(order, { type: STOCK_TYPES.CANCEL, session });
                } else {
                    await adjustStock(order, { type: STOCK_TYPES.CANCEL, session });
                }
            });
        } finally {
            session.endSession();
        }
        return res.json({ message: 'Order cancelled, stock restored' });
    }

    req.order = order;
    next();
};


// createdCancel — order_controller.js
const createdCancel = async (req, res, next) => {
    const order = req.order;

    if (order?.shipmentId && !order?.awbCode) {
        // External Shiprocket call — outside transaction (HTTP calls can't be rolled back)
        await axios.post(
            'https://apiv2.shiprocket.in/v1/external/orders/cancel',
            { ids: [order.shiprocketOrderId] },
            { headers: { Authorization: `Bearer ${req.shiprocketToken}` } }
        );

        // ✅ Atomic: order save + stock restore
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                order.status = 'Cancelled';
                order.reason = req.body.reason;
                order.requests = updateRequestStatus(order.requests, req.body.reason);
                await order.save({ session });

                await adjustStock(order, { type: STOCK_TYPES.CANCEL, session });
            });
        } finally {
            session.endSession();
        }
        return res.json({ message: 'Order cancelled on Shiprocket, stock restored' });
    }

    next();
};


// awbCancel — order_controller.js
const awbCancel = async (req, res, next) => {
    const order = req.order;

    if (order?.awbCode && !order?.pickupDate) {
        // External Shiprocket calls first — outside transaction
        await axios.post(
            'https://apiv2.shiprocket.in/v1/external/orders/cancel/shipment/awbs',
            { awbs: [order.awbCode] },
            { headers: { Authorization: `Bearer ${req.shiprocketToken}` } }
        );
        await axios.post(
            'https://apiv2.shiprocket.in/v1/external/orders/cancel',
            { ids: [order.shiprocketOrderId] },
            { headers: { Authorization: `Bearer ${req.shiprocketToken}` } }
        );

        // ✅ Atomic: order save + stock restore
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                order.status = 'Cancelled';
                order.reason = req.body.reason;
                order.requests = updateRequestStatus(order.requests, req.body.reason);
                await order.save({ session });

                await adjustStock(order, { type: STOCK_TYPES.CANCEL, session });
            });
        } finally {
            session.endSession();
        }
        return res.json({ message: 'Courier and order cancelled, stock restored' });
    }

    next();
};


// postPickupCancel — order_controller.js
const postPickupCancel = async (req, res, next) => {
    const order = req.order;

    const pickupCheck = await checkPickupStatus(order?.shipmentId, req?.shiprocketToken);
    if (pickupCheck?.completed) {
        return res.status(400).json({ message: 'Order cannot be cancelled as it is already picked up' });
    }

    if (order?.pickupDate && order?.shippingStatus === 'Pickup Scheduled') {
        // External Shiprocket calls first — outside transaction
        await axios.post(
            'https://apiv2.shiprocket.in/v1/external/orders/cancel/shipment/awbs',
            { awbs: [order.awbCode] },
            { headers: { Authorization: `Bearer ${req.shiprocketToken}` } }
        );
        await axios.post(
            'https://apiv2.shiprocket.in/v1/external/orders/cancel',
            { ids: [order.shiprocketOrderId] },
            { headers: { Authorization: `Bearer ${req.shiprocketToken}` } }
        );

        // ✅ Atomic: order save + stock restore
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                order.status = 'Cancelled';
                order.reason = req.body.reason;
                order.requests = updateRequestStatus(order.requests, req.body.reason);
                await order.save({ session });

                await adjustStock(order, { type: STOCK_TYPES.CANCEL, session });
            });
        } finally {
            session.endSession();
        }
        return res.json({ message: 'Pickup and Order cancelled, stock restored' });
    }

    return res.status(400).json({ message: 'Order cannot be cancelled as it is already picked up' });
};


// ******************************************************
//                  ORDER RTO CONTROLLERS
// ******************************************************

// 5️⃣ RTO when shipment picked up or in transit
const inTransitCancel = async (req, res, next) => {
    const order = req.order;
    const inTransitStates = ['Shipped', 'In Transit', 'Picked Up'];
    if (inTransitStates.includes(order.shippingStatus)) {
        order.status = 'Cancelled';
        order.reason = req?.body?.reason;
        await order.save();
        // stock to be adjusted on return processing
        return res.json({ message: 'Order marked cancelled; stock will restore upon return' });
    }
    next();
};

// 6️⃣ RTO when delivered
const deliveredCancel = async (req, res) => {
    const order = req.order;
    if (order.shippingStatus === 'Delivered') {
        return res.status(400).json({ message: 'Cannot cancel after delivery' });
    }
    // fallback
    return res.status(400).json({ message: 'Invalid cancellation stage' });
};

const returnOrder = asyncHandler(async (req, res) => {
    try {
        const { orderId, phoneNo } = req?.body;

        const order = await Order.findById(orderId).populate({
            path: 'userId',
            select: "-password -refreshToken"
        })
            .populate({
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            })
            .populate('addressId')
            .exec();

        if (!order) {
            throw new ApiError(404, 'Order not found');
        }

        if ((order?.status == 'Delivered' ? false : order?.status == 'New' ? false : true)) {
            throw new ApiError(403, 'Only delivered or new orders can be returned');
        }

        if (!order?.shiprocketOrderId) {
            order.status = "Returned";
            await order.save();
            await adjustStock(order, {
                type: STOCK_TYPES.RETURN
            });
            const updatedRequests = order?.requests?.map((r) => {
                if (r?.type === "Return" && !r?.isResolved) {
                    r.isResolved = true;
                    r.status = "Accepted";
                    r.resolvedAt = new Date().toISOString();
                    r.reason = r?.reason;
                }
                return r;
            });
            order.requests = updatedRequests
            await order.save();
            return res.status(200).json(
                new ApiResponse(200, { order }, "Order returned successfully")
            );
        }

        const response = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/orders/show/${order?.shiprocketOrderId}`,
            { headers: { Authorization: `Bearer ${req?.shiprocketToken}` } }
        );

        const orderData = response?.data?.data;
        if (!orderData) {
            throw new ApiError(404, "Order not found");
        }

        // console.log(orderData);

        const order_items = orderData?.products?.map(it => (
            {
                name: it?.name,
                sku: it?.sku,
                selling_price: it?.selling_price,
                units: it?.quantity,
                qc_enable: false
            }
        ))

        console.log("Order Items", order_items);

        // return res.status(200).json({
        //     success: true,
        //     message: "Success Response"
        // })

        // pickup_customer_name: orderData?.others?.billing_name,
        //     pickup_email: orderData?.others?.billing_email,
        //     pickup_phone: orderData?.others?.billing_phone,
        //     pickup_address: orderData?.others?.billing_address,
        //     pickup_address_2: orderData?.others?.billing_address_2,
        //     pickup_city: orderData?.others?.billing_city,
        //     pickup_state: orderData?.others?.billing_state,
        //     pickup_country: orderData?.others?.billing_country,
        //     pickup_pincode: orderData?.others?.billing_pincode,

        const payload = {
            order_id: order?.shiprocketOrderId,
            order_date: orderData?.order_date,
            channel_id: orderData?.channel_id, //clear
            pickup_customer_name: orderData?.customer_name,
            pickup_email: orderData?.customer_email,
            pickup_phone: order?.phoneNo || phoneNo,
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
            sub_total: orderData?.net_total,
            weight: orderData?.shipments?.weight,
            length: orderData?.shipments?.length,
            breadth: orderData?.shipments?.breadth,
            height: orderData?.shipments?.height,
            request_pickup: true
        }

        const { data } = await axios.post('https://apiv2.shiprocket.in/v1/external/shipments/create/return-shipment', payload, {
            headers: {
                Authorization: `Bearer ${req?.shiprocketToken}`
            }
        });

        if (!data?.status) {
            throw new ApiError(500, "Could not initiate return order");
        }

        console.log("Return Order Response", data);
        order.returnData = { ...data?.payload, isReturnInitiated: true };

        const updatedRequests = order?.requests?.map((r) => {
            if (r?.type === "Return" && !r?.isResolved) {
                r.isResolved = true;
                r.status = "Accepted";
                r.resolvedAt = new Date().toISOString();
                r.reason = r?.reason;
            }
            return r;
        });
        order.requests = updatedRequests
        await order.save();

        return res.status(200).json(
            new ApiResponse(200, { order }, "Return Order initiated with Shiprocket")
        );
    } catch (err) {
        console.error("Shiprocket Return Order Error:", err?.response?.data || err);
        res.status(500).json({ error: err?.response?.data || err?.message || 'Shiprocket order return failed' });
    }
})

const returnOrderV2 = asyncHandler(async (req, res, next) => {
    try {
        const { orderId, phoneNo } = req?.body;

        let order = await Order.findById(orderId).populate({
            path: 'userId',
            select: "-password -refreshToken"
        })
            .populate({
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            })
            .populate('addressId')
            .exec();

        if (!order) {
            throw new ApiError(404, 'Order not found');
        }

        if ((order?.status == 'Delivered' ? false : order?.status == 'New' ? false : true)) {
            throw new ApiError(403, 'Only delivered or new orders can be returned');
        }

        // if (!order?.shiprocketOrderId && !order?.returnData?.order_id) {
        //     order.status = "Returned";
        //     await order.save();
        //     await adjustStock(order, {
        //         type: STOCK_TYPES.RETURN
        //     });
        //     const updatedRequests = order?.requests?.map((r) => {
        //         if (r?.type === "Return" && !r?.isResolved) {
        //             r.isResolved = true;
        //             r.status = "Accepted";
        //             r.resolvedAt = new Date().toISOString();
        //             r.reason = r?.reason;
        //         }
        //         return r;
        //     });
        //     order.requests = updatedRequests
        //     await order.save();
        //     return res.status(200).json(
        //         new ApiResponse(200, { order }, "Order returned successfully")
        //     );
        // }
        if (!order?.shiprocketOrderId && !order?.returnData?.order_id) {

            const session = await mongoose.startSession();

            try {
                await session.withTransaction(async () => {

                    const updatedRequests = order?.requests?.map((r) => {
                        if (r?.type === "Return" && !r?.isResolved) {
                            r.isResolved = true;
                            r.status = "Accepted";
                            r.resolvedAt = new Date().toISOString();
                            r.reason = r?.reason;
                        }
                        return r;
                    });

                    order.status = "Returned";
                    order.requests = updatedRequests;

                    // ✅ Yeh line add karo — Mongoose ko force karo ki requests changed hai
                    order.markModified('requests');

                    await order.save({ session });

                    if (order?.type === ORDER_TYPES.POS) {
                        await adjustStockV2(order, {
                            type: STOCK_TYPES.RETURN,
                            session
                        });
                    } else {
                        await adjustStock(order, {
                            type: STOCK_TYPES.RETURN,
                            session
                        });
                    }
                });

            } finally {
                session.endSession();
            }

            return res.status(200).json(
                new ApiResponse(200, { order }, "Order returned successfully")
            );
        }

        //Check if return order already created
        if (order?.returnData?.order_id) {
            const response = await axios.get(
                `https://apiv2.shiprocket.in/v1/external/orders/show/${order?.returnData?.order_id}`,
                { headers: { Authorization: `Bearer ${req?.shiprocketToken}` } }
            );

            const returnOrderData = response?.data?.data;
            console.log("Return Order Shiprocket Check: ", returnOrderData);
            if (returnOrderData.status_code == 422) {
                // req.order = order;
                // next();
                return res.status(200).json(
                    new ApiResponse(200, { order }, "Return Order already created on Shiprocket")
                );
            }
        }

        const response = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/orders/show/${order?.shiprocketOrderId}`,
            { headers: { Authorization: `Bearer ${req?.shiprocketToken}` } }
        );

        const orderData = response?.data?.data;
        if (!orderData) {
            throw new ApiError(404, "Order not found");
        }

        // console.log(orderData);

        const order_items = orderData?.products?.map(it => (
            {
                name: it?.name,
                sku: it?.sku,
                selling_price: it?.selling_price,
                units: it?.quantity,
                qc_enable: false
            }
        ))

        // console.log("Order Items", order_items);


        const payload = {
            order_id: `R_${order?.orderId}`,
            order_date: orderData?.order_date,
            channel_id: orderData?.channel_id, //clear
            pickup_customer_name: orderData?.customer_name,
            pickup_email: orderData?.customer_email,
            pickup_phone: order?.phoneNo || phoneNo,
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
            sub_total: orderData?.net_total,
            weight: orderData?.shipments?.weight,
            length: orderData?.shipments?.length,
            breadth: orderData?.shipments?.breadth,
            height: orderData?.shipments?.height,
            request_pickup: true
        }

        const { data } = await axios.post('https://apiv2.shiprocket.in/v1/external/orders/create/return', payload, {
            headers: {
                Authorization: `Bearer ${req?.shiprocketToken}`
            }
        });

        // console.log("Return Order Response", data);
        if (data?.status_code != 21) {
            throw new ApiError(500, `Could not create return order on shiprocket as order ${data?.status}`);
        }

        order.returnData = {
            ...data,
            isReturnInitiated: true,
            orderId: `R_${order?.orderId}`,
            shippingStatus: "Return Order Created",
        };
        order.shippingStatus = data?.status;

        const updatedRequests = order?.requests?.map((r) => {
            if (r?.type === "Return" && !r?.isResolved) {
                r.isResolved = true;
                r.status = "Accepted";
                r.resolvedAt = new Date().toISOString();
                r.reason = r?.reason;
            }
            return r;
        });
        order.requests = updatedRequests
        await order.save();

        // req.order = order;
        // next();
        return res.status(200).json(
            new ApiResponse(200, { order }, "Return Order created with Shiprocket")
        );

    } catch (err) {
        console.error("Shiprocket Return Order Error:", err?.response?.data || err);
        res.status(500).json({ error: err?.response?.data || err?.message || 'Shiprocket order return failed' });
    }
})

const markAsDeliveredManually = asyncHandler(async (req, res) => {
    const { orderId } = req.body;
    if (!orderId) throw new ApiError(400, "Order Id is required");

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");

    if (order.status !== 'New' && order.status !== 'Accepted') {
        throw new ApiError(400, `Cannot mark order as delivered from status: ${order.status}`);
    }

    order.status = 'Delivered';
    order.deliveredAt = new Date();
    await order.save();

    await logActivity({
        orderId: order._id,
        action: "Delivered",
        remarks: "Order marked as Delivered manually.",
        req
    });

    return res.status(200).json(new ApiResponse(200, { order }, "Order marked as delivered manually"));
});

const recordCallAttempt = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const { remarks } = req.body;

    if (!_id) {
        throw new ApiError(400, "Order Id is required");
    }

    const order = await Order.findById(_id);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    const currentAttempts = order.callAttempts?.noOfAttempts || 0;
    if (currentAttempts >= 3) {
        throw new ApiError(400, "Maximum 3 call attempts allowed for an order");
    }

    const nextAttemptNo = currentAttempts + 1;

    if (!order.callAttempts) {
        order.callAttempts = { noOfAttempts: 0, history: [] };
    }

    order.callAttempts.noOfAttempts = nextAttemptNo;
    order.callAttempts.history.push({
        attemptNo: nextAttemptNo,
        date: new Date(),
        employeeId: req?.user?._id,
        remarks: remarks?.trim() || ""
    });

    await order.save();

    await logActivity({
        orderId: order._id,
        action: "Call Attempt",
        remarks: `Call attempt #${nextAttemptNo} recorded. Remarks: "${remarks?.trim() || "N/A"}"`,
        req
    });

    const updatedOrder = await Order.findById(_id)
        .populate({
            path: 'userId',
            model: "User",
            select: "-password -refreshToken"
        })
        .populate({
            path: "callAttempts.history.employeeId",
            model: "User",
            select: "name email role"
        });

    return res
        .status(200)
        .json(new ApiResponse(200, updatedOrder, "Call attempt recorded successfully"));
});

const addOrderPayment = asyncHandler(async (req, res) => {
    const { orderId, amount, method, status = "Paid", notes, paidAt } = req.body;

    if (!orderId || amount === undefined || !method) {
        throw new ApiError(400, "orderId, amount, and method are required.");
    }

    if (method === "COD") {
        throw new ApiError(400, "COD is not a valid manual payment transaction method.");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found.");
    }

    let finalStatus = status;
    if (req.user?.role?.toLowerCase() !== "admin") {
        finalStatus = "Pending";
    }

    const session = await mongoose.startSession();
    try {
        let paymentDoc;
        await session.withTransaction(async () => {
            paymentDoc = await Payment.create([{
                orderId: order.orderId,
                orderRef: order._id,
                amount: Number(amount),
                method,
                status: finalStatus,
                notes: notes || "",
                paidAt: finalStatus === "Paid" ? (paidAt ? new Date(paidAt) : new Date()) : undefined
            }], { session });

            // Fetch all paid payments for this order to recalculate
            const allPayments = await Payment.find({ orderRef: order._id, status: "Paid" }).session(session);
            const totalPaid = allPayments.reduce((sum, p) => sum + p.amount, 0);

            order.amountPaid = totalPaid;
            order.remainingAmount = Math.max(0, order.orderAmount - totalPaid);

            if (order.remainingAmount <= 0) {
                order.paymentStatus = "Paid";
                order.paymentDate = new Date();
            } else {
                order.paymentStatus = "Pending";
            }

            await order.save({ session });

            await logActivity({
                orderId: order._id,
                action: "Payment Received",
                remarks: `Payment transaction of ₹${amount} via ${method} recorded as ${finalStatus}. Notes: ${notes || "N/A"}`,
                req,
                session
            });
        });

        return res.status(200).json(new ApiResponse(200, { payment: paymentDoc[0], order }, "Payment added and order totals updated successfully."));
    } catch (error) {
        console.error("Error in addOrderPayment:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

const editOrderPayment = asyncHandler(async (req, res) => {
    const { paymentId } = req.params;
    const { amount, method, status, notes, paidAt } = req.body;

    if (!paymentId) {
        throw new ApiError(400, "Payment ID is required.");
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) {
        throw new ApiError(404, "Payment transaction not found.");
    }

    if (payment.status === "Paid") {
        throw new ApiError(400, "This payment record is Paid and locked. It cannot be edited.");
    }

    if (method === "COD") {
        throw new ApiError(400, "COD is not a valid manual payment transaction method.");
    }

    const order = await Order.findById(payment.orderRef);
    if (!order) {
        throw new ApiError(404, "Order associated with payment not found.");
    }

    let finalStatus = status || payment.status;
    if (req.user?.role?.toLowerCase() !== "admin") {
        finalStatus = "Pending";
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            payment.amount = amount !== undefined ? Number(amount) : payment.amount;
            payment.method = method || payment.method;
            payment.status = finalStatus;
            payment.notes = notes !== undefined ? notes : payment.notes;

            if (finalStatus === "Paid") {
                payment.paidAt = paidAt ? new Date(paidAt) : (payment.paidAt || new Date());
            } else if (finalStatus === "Pending") {
                payment.paidAt = undefined;
            }

            await payment.save({ session });

            // Recalculate order payment totals
            const allPayments = await Payment.find({ orderRef: order._id, status: "Paid" }).session(session);
            const totalPaid = allPayments.reduce((sum, p) => sum + p.amount, 0);

            order.amountPaid = totalPaid;
            order.remainingAmount = Math.max(0, order.orderAmount - totalPaid);

            if (order.remainingAmount <= 0) {
                order.paymentStatus = "Paid";
                order.paymentDate = new Date();
            } else {
                order.paymentStatus = "Pending";
            }

            await order.save({ session });

            await logActivity({
                orderId: order._id,
                action: "Payment Updated",
                remarks: `Payment transaction #${payment._id} updated. Method: ${payment.method}, Status: ${payment.status}, Amount: ₹${payment.amount}`,
                req,
                session
            });
        });

        return res.status(200).json(new ApiResponse(200, { payment, order }, "Payment updated and order totals updated successfully."));
    } catch (error) {
        console.error("Error in editOrderPayment:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

const getOrderPayments = asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    if (!orderId) {
        throw new ApiError(400, "Order ID is required.");
    }

    const payments = await Payment.find({ orderRef: orderId }).sort({ createdAt: -1 });

    return res.status(200).json(new ApiResponse(200, payments, "Order payments retrieved successfully."));
});

const generatePaymentRecordLink = asyncHandler(async (req, res) => {
    const { paymentId, gateway } = req.body;

    if (!paymentId) {
        throw new ApiError(400, "Payment ID is required.");
    }

    if (!gateway || !["razorpay", "phonepe"].includes(gateway)) {
        throw new ApiError(400, "Invalid or missing gateway. Must be 'razorpay' or 'phonepe'.");
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

    const payment = await Payment.findById(paymentId);
    if (!payment) {
        throw new ApiError(404, "Payment transaction not found.");
    }

    if (payment.status === "Paid") {
        throw new ApiError(400, "Cannot generate payment link for a paid record.");
    }

    if (payment.method !== "Online") {
        throw new ApiError(400, "Payment link can only be generated for Online payment methods.");
    }

    if (payment.paymentLinkUrl) {
        return res.status(200).json(new ApiResponse(200, { payment }, "Payment link already exists."));
    }

    const order = await Order.findById(payment.orderRef);
    if (!order) {
        throw new ApiError(404, "Order associated with payment not found.");
    }

    try {
        let linkResponse = {};
        const reqOrigin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
        const backendOrigin = `${req.protocol}://${req.get('host')}`;

        if (gateway === "phonepe") {
            const tempLink = await initiatePhonepePaymentLink(
                order.orderId, payment.amount, order.phoneNo, reqOrigin, backendOrigin
            );
            linkResponse = { id: tempLink.id, short_url: tempLink.short_url };
        } else {
            const tempLink = await initiateRazorpayPaymentLink(
                order.orderId, payment.amount, order.name, order.phoneNo
            );
            linkResponse = { id: tempLink.id, short_url: tempLink.short_url };
        }

        payment.paymentLinkId = linkResponse.id;
        payment.paymentLinkUrl = linkResponse.short_url;
        await payment.save();

        const newPaymentLink = new PaymentLink({
            gateway,
            orderId: order._id,
            amount: payment.amount,
            name: order.name,
            email: order.email,
            phoneNo: order.phoneNo,
            paymentLink_id: linkResponse.id,
            link: linkResponse.short_url,
            referenceId: payment._id
        });
        await newPaymentLink.save();

        return res.status(200).json(
            new ApiResponse(200, { payment, payment_link: linkResponse.short_url }, "Payment link generated successfully.")
        );
    } catch (error) {
        console.error("Error in generatePaymentRecordLink:", error);
        const errMsg = error?.error?.description || error.message || "Failed to generate payment link.";
        throw new ApiError(500, errMsg);
    }
});

const manualShipOrder = asyncHandler(async (req, res) => {
    const {
        orderId,
        awbCode,
        courierName,
        shippingPartner,
        address,
        address2,
        city,
        state,
        pincode,
        country,
        schedulePickup,
        pickupScheduledAt,
        pickupTokenNumber,
        expectedDeliveryDate,
        trackingUrl
    } = req.body;

    if (!orderId) {
        throw new ApiError(400, "Order ID is required.");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found.");
    }

    const pendingPayments = await Payment.find({ orderRef: order._id, status: "Pending" });
    if (pendingPayments.length > 0) {
        throw new ApiError(400, "Cannot ship order. Payments not verified yet.");
    }

    order.shippingType = "Manual";
    order.awbCode = awbCode || "";
    order.courierName = courierName || "";
    order.shippingPartner = shippingPartner || "";
    order.courierAssignedAt = new Date();
    order.trackingUrl = trackingUrl || "";

    if (address) order.address = address;
    if (address2 !== undefined) order.address2 = address2;
    if (city) order.city = city;
    if (state) order.state = state;
    if (pincode) order.pincode = pincode;
    if (country) order.country = country;

    if (schedulePickup) {
        order.pickupScheduled = true;
        order.pickupDate = pickupScheduledAt ? new Date(pickupScheduledAt).toISOString() : new Date().toISOString();
        order.expectedDeliveryDate = expectedDeliveryDate ? new Date(expectedDeliveryDate).toISOString() : "";
        order.status = "Shipped";
        order.shippedAt = new Date();
        order.scans.push({
            date: new Date(),
            location: order.city || "",
            status: "Courier assigned",
            activity: "Courier assigned - Yet to pickup"
        });
    } else {
        order.scans.push({
            date: new Date(),
            location: order.city || "",
            status: "Shipping details added",
            activity: "Shipping details added"
        });
    }

    order.markModified("scans");
    await order.save();

    await logActivity({
        orderId: order._id,
        action: "Shipped",
        remarks: `Order manually shipped with courier ${courierName || "N/A"}. AWB: ${awbCode || "N/A"}.`,
        req
    });

    return res.status(200).json(new ApiResponse(200, order, "Manual shipping details saved successfully."));
});

const updateManualShippingStatus = asyncHandler(async (req, res) => {
    const { orderId, shippingStatus, date, description } = req.body;

    if (!orderId || !shippingStatus) {
        throw new ApiError(400, "Order ID and shippingStatus are required.");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found.");
    }

    const statusDate = date ? new Date(date) : new Date();
    order.shippingStatus = shippingStatus;

    if (shippingStatus === "delivered") {
        order.status = "Delivered";
        order.deliveredAt = statusDate.toISOString();
    } else if (shippingStatus === "rto initiated") {
        order.status = "RTO Initiated";
        order.rtoInitiatedAt = statusDate.toISOString();
    } else if (shippingStatus === "rto delivered") {
        order.status = "RTO Delivered";
        order.rtoDeliveredAt = statusDate.toISOString();
    } else if (shippingStatus === "rto accepted") {
        order.status = "RTO Acknowledged";
    } else if (shippingStatus === "picked up") {
        order.status = "Shipped";
        order.shippedAt = statusDate;
    }

    order.scans.push({
        date: statusDate,
        location: order.city || "",
        status: shippingStatus,
        activity: description || ""
    });

    order.markModified("scans");
    await order.save();

    await logActivity({
        orderId: order._id,
        action: "Status Update",
        remarks: `Manual shipping status updated to "${shippingStatus}". Activity: "${description || "N/A"}"`,
        req
    });

    return res.status(200).json(new ApiResponse(200, order, "Manual shipping status updated successfully."));
});

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

    await Inventory.findOneAndUpdate(
        { product: productId },
        {
            $set: {
                physicalStock: totalStockSum
            }
        },
        { new: true, session }
    );
};

async function adjustStockV3(order, options = {}) {
    return performAdjustStock(order, options);
}

const systemCreatedCancel = asyncHandler(async (req, res) => {
    const { orderId, reason } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.status === "Cancelled") {
        throw new ApiError(400, "Order already cancelled");
    }

    // Atomic session: order save + stock restore
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            order.status = "Cancelled";
            order.reason = reason;
            order.requests = updateRequestStatus(order.requests, reason);
            await order.save({ session });

            await adjustStockV3(order, { type: STOCK_TYPES.CANCEL, session });

            await logActivity({
                orderId: order._id,
                action: "Cancelled",
                remarks: reason || "Order cancelled by admin.",
                req,
                session
            });
        });
    } finally {
        session.endSession();
    }

    return res.json(
        new ApiResponse(200, { order }, "Order cancelled and stock restored successfully.")
    );
});

export {
    paymentLinkWebhook,
    createPosOrder,
    createManualOrder,
    createCodOrder,
    restoreOrderStock,
    createOnlineOrder,
    reviewOrder,
    updateOrder,
    addItemQuantityInOrder,
    removeItemQuantityInOrder,
    verifyPayment,
    getAllOrdersByUser,
    getOrderById,
    getAllOrders,
    getFilteredOrdersByDate,
    getOrdersByDate,
    createAbandonedOrderFromCart,
    holdAbandonedOrder,
    acceptOrder,
    getOrdersByRequestType,
    preShiprocketReject,
    createdReject,
    awbReject,
    preShiprocketCancel,
    createdCancel,
    awbCancel,
    postPickupCancel,
    inTransitCancel,
    deliveredCancel,
    returnOrder,
    returnOrderV2,
    markAsDeliveredManually,
    recordCallAttempt,

    // New manual shipping and payments controllers
    addOrderPayment,
    editOrderPayment,
    getOrderPayments,
    generatePaymentRecordLink,
    manualShipOrder,
    updateManualShippingStatus,
    systemCreatedCancel
}

// =========================================================================
// LEGACY CONTROLLERS (DO NOT REMOVE)
// =========================================================================

const legacy_updateOrder = asyncHandler(async (req, res) => {
    try {
        const orderId = req?.params?._id;
        const updates = req?.body;

        if (
            !orderId
        ) {
            throw new ApiError(400, 'Order Id not found.');
        }

        const foundOrder = await Order.findById(orderId);
        if (!foundOrder) {
            throw new ApiError(400, 'Order not found.');
        }

        if (foundOrder?.shipmentId) {
            throw new ApiError(409, 'Order is created at shiprocket');
        }

        const updateData = { ...updates };
        if (updates?.status === 'Accepted' && !foundOrder?.acceptedAt) {
            updateData.acceptedAt = new Date();
            updateData.acceptedReason = updates?.reason || "";
        }

        const updatedOrder = await Order.findByIdAndUpdate(
            orderId,
            updateData,
            { new: true }
        );

        return res.status(201).json(
            new ApiResponse(201, { updatedOrder }, "Order updated Successfully")
        );

    } catch (err) {
        console.error('Error updating order:', err.message);
        return res.status(500).json({ message: err.message || 'Internal server error' });
    }
});

export const updateOrderItems = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    try {
        const { id } = req.params;
        const { items, discount, discountPercent, deliveryCharge } = req.body;

        if (!id) {
            throw new ApiError(400, "Order ID is required.");
        }

        const order = await Order.findById(id);
        if (!order) {
            throw new ApiError(404, "Order not found.");
        }

        // Validate editing timeframe constraints
        const canEdit = () => {
            if (order.shippingType === 'Manual') {
                return !['Shipped', 'Delivered', 'Cancelled', 'Rejected', 'Returned'].includes(order.status);
            } else {
                return !order.awbCode && !order.shipmentId && !order.pickupScheduled && !order.courierName && !['Shipped', 'Delivered', 'Cancelled', 'Rejected', 'Returned'].includes(order.status);
            }
        };
        if (!canEdit()) {
            throw new ApiError(400, "Order cannot be edited at this stage.");
        }

        await session.withTransaction(async () => {
            const clonePurchaseSets = (sets = []) => sets.map(s => ({
                purchaseSetId: String(s.purchaseSetId),
                quantity: Number(s.quantity || 0),
                price: Number(s.price || 0)
            }));

            const oldItemsMap = new Map();
            for (const item of order.items) {
                const key = item.variantId ? item.variantId.toString() : `${item.productId.toString()}_${item.variantName}`;
                oldItemsMap.set(key, {
                    quantity: item.quantity,
                    stockIds: item.stockIds || [],
                    price: item.price,
                    discount: item.discount,
                    variantId: item.variantId,
                    purchasePrice: item.purchasePrice || 0,
                    purchaseSetId: item.purchaseSetId || "",
                    purchaseSets: item.purchaseSets || []
                });
            }

            const newItems = [];
            const itemChanges = [];

            if (items && Array.isArray(items)) {
                for (const reqItem of items) {
                    const productId = reqItem.productId;
                    const variantId = reqItem.variantId;
                    const variantName = reqItem.variantName;
                    const qty = Math.floor(Number(reqItem.quantity || 0));
                    const itemDiscount = Number(reqItem.discount || 0);
                    const itemDiscountPercent = Number(reqItem.discountPercent || 0);

                    if (qty <= 0) continue;

                    const key = variantId ? variantId.toString() : `${productId.toString()}_${variantName}`;
                    const oldInfo = oldItemsMap.get(key) || {
                        quantity: 0,
                        stockIds: [],
                        price: 0,
                        discount: 0,
                        variantId: null,
                        purchasePrice: 0,
                        purchaseSetId: "",
                        purchaseSets: []
                    };
                    const oldQty = oldInfo.quantity;
                    const diff = qty - oldQty;

                    const finalPrice = reqItem.price !== undefined && reqItem.price !== null ? Number(reqItem.price) : oldInfo.price;
                    const itemDiscountType = reqItem.discountType !== undefined ? reqItem.discountType : (oldInfo.discountType || "flat");
                    const syncedDiscount = syncItemDiscount(itemDiscount, itemDiscountPercent, finalPrice, itemDiscountType);
                    const finalDiscount = syncedDiscount.discount;
                    const finalDiscountPercent = syncedDiscount.discountPercent;
                    const finalUnitSellingPrice = finalPrice - finalDiscount;

                    const product = await Product.findById(productId).session(session);
                    if (!product) throw new ApiError(404, `Product not found for ID: ${productId}`);

                    let itemStockIds = [...oldInfo.stockIds];
                    let allocatedSets = clonePurchaseSets(oldInfo.purchaseSets);
                    let selectedSetId = oldInfo.purchaseSetId || "";
                    let avgPurchasePrice = Number(oldInfo.purchasePrice || 0);
                    let incrementalPurchasePrice = 0;
                    let restoredPurchasePrice = 0;

                    // Adjust stock if quantity changed
                    if (diff > 0) {
                        const query = reqItem.variantId
                            ? { _id: reqItem.variantId, active: true, totalStock: { $gte: diff }, availableStock: { $gte: diff } }
                            : { productId: productId, name: variantName, active: true, totalStock: { $gte: diff }, availableStock: { $gte: diff } };
                        const variantResult = await Variant.findOneAndUpdate(
                            query,
                            { $inc: { totalStock: -diff, availableStock: -diff } },
                            { new: true, session }
                        );

                        if (!variantResult) {
                            throw new ApiError(400, `Insufficient stock for product ${product.fullName} variant ${variantName}`);
                        }

                        // FIFO allocation on purchaseSets
                        let remaining = diff;
                        const sortedSets = variantResult.purchaseSets
                            .map((set, idx) => ({ set, idx }))
                            .filter(itemObj => itemObj.set.availableStock > 0)
                            .sort((a, b) => a.set.price - b.set.price);

                        let totalCost = 0;
                        const newlyAllocated = [];

                        for (const itemObj of sortedSets) {
                            const set = variantResult.purchaseSets[itemObj.idx];
                            const take = Math.min(remaining, set.availableStock);
                            if (take <= 0) continue;
                            set.availableStock -= take;
                            set.remainingStock = Math.max(0, set.remainingStock - take);
                            totalCost += take * set.price;
                            newlyAllocated.push({
                                purchaseSetId: String(set._id),
                                quantity: take,
                                price: set.price
                            });
                            remaining -= take;

                            if (!selectedSetId) {
                                selectedSetId = String(set._id);
                            }

                            if (remaining === 0) break;
                        }

                        if (remaining > 0 && variantResult.purchaseSets.length > 0) {
                            const firstSet = variantResult.purchaseSets[0];
                            firstSet.availableStock = Math.max(0, firstSet.availableStock - remaining);
                            firstSet.remainingStock = Math.max(0, firstSet.remainingStock - remaining);
                            newlyAllocated.push({
                                purchaseSetId: String(firstSet._id),
                                quantity: remaining,
                                price: firstSet.price
                            });
                            if (!selectedSetId) {
                                selectedSetId = String(firstSet._id);
                            }
                            totalCost += remaining * firstSet.price;
                        }

                        incrementalPurchasePrice = diff > 0 ? (totalCost / diff) : 0;

                        // Fallback populating allocatedSets if it was empty from bad/old data
                        if (allocatedSets.length === 0 && oldQty > 0) {
                            const fallbackSetId = oldInfo.purchaseSetId || (variantResult.purchaseSets[0] ? String(variantResult.purchaseSets[0]._id) : "");
                            if (fallbackSetId) {
                                allocatedSets = [{
                                    purchaseSetId: fallbackSetId,
                                    quantity: oldQty,
                                    price: Number(oldInfo.purchasePrice || 0)
                                }];
                            }
                        }

                        // Merge into the item's purchaseSets
                        for (const alloc of newlyAllocated) {
                            const matched = allocatedSets.find(s => s.purchaseSetId === alloc.purchaseSetId);
                            if (matched) {
                                matched.quantity += alloc.quantity;
                            } else {
                                allocatedSets.push(alloc);
                            }
                        }

                        // Calculate weighted average purchase price
                        if (avgPurchasePrice > 0 || incrementalPurchasePrice > 0) {
                            avgPurchasePrice = parseFloat((((oldInfo.purchasePrice * oldQty) + (incrementalPurchasePrice * diff)) / qty).toFixed(3)) || 0;
                        } else {
                            avgPurchasePrice = incrementalPurchasePrice;
                        }

                        await variantResult.save({ session });
                        await syncProductStock(productId, session);

                        const parentProduct = await Product.findById(productId).session(session);
                        const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                        // Create Stock entry
                        const newStockLog = await Stock.create([{
                            orderId: order.orderId,
                            orderRef: order._id,
                            type: "add-item", // sign: -
                            category: "physical",
                            variantId: variantResult._id,
                            variantName: variantResult.name,
                            purchasePrice: incrementalPurchasePrice,
                            sellingPrice: finalUnitSellingPrice,
                            quantity: diff,
                            previousStock: variantResult.availableStock + diff,
                            updatedStock: variantResult.availableStock,
                            previousPhysicalStock: variantResult.totalStock + diff,
                            updatedPhysicalStock: variantResult.totalStock,
                            totalProductStock: currentTotalProductStock,
                            productId: productId
                        }], { session });

                        itemStockIds.push(newStockLog[0]._id);

                    } else if (diff < 0) {
                        const restoreQty = -diff;
                        const query = reqItem.variantId
                            ? { _id: reqItem.variantId }
                            : { productId: productId, name: variantName };
                        const variantResult = await Variant.findOneAndUpdate(
                            query,
                            { $inc: { totalStock: restoreQty, availableStock: restoreQty } },
                            { new: true, session }
                        );

                        if (!variantResult) {
                            throw new ApiError(400, `Failed to restore variant stock for product ${product.fullName}`);
                        }

                        // Fallback populating allocatedSets if it was empty from bad/old data
                        if (allocatedSets.length === 0 && oldQty > 0) {
                            const fallbackSetId = oldInfo.purchaseSetId || (variantResult.purchaseSets[0] ? String(variantResult.purchaseSets[0]._id) : "");
                            if (fallbackSetId) {
                                allocatedSets = [{
                                    purchaseSetId: fallbackSetId,
                                    quantity: oldQty,
                                    price: Number(oldInfo.purchasePrice || 0)
                                }];
                            }
                        }

                        let remainingToRestore = restoreQty;
                        let restoredCost = 0;
                        let restoredQty = 0;

                        for (const alloc of allocatedSets) {
                            const take = Math.min(remainingToRestore, alloc.quantity);
                            if (take <= 0) continue;

                            const set = variantResult.purchaseSets.find(s => String(s._id) === String(alloc.purchaseSetId));
                            if (set) {
                                set.availableStock += take;
                                set.remainingStock += take;
                            }
                            alloc.quantity -= take;
                            remainingToRestore -= take;
                            restoredCost += take * alloc.price;
                            restoredQty += take;

                            if (remainingToRestore === 0) break;
                        }

                        // Fallback if we couldn't restore everything (desynced)
                        if (remainingToRestore > 0 && variantResult.purchaseSets.length > 0) {
                            const firstSet = variantResult.purchaseSets[0];
                            firstSet.availableStock += remainingToRestore;
                            firstSet.remainingStock += remainingToRestore;
                            restoredCost += remainingToRestore * firstSet.price;
                            restoredQty += remainingToRestore;
                        }

                        const remainingAllocations = allocatedSets.filter(alloc => alloc.quantity > 0);
                        const remainingQty = remainingAllocations.reduce((sum, a) => sum + a.quantity, 0);
                        const remainingCost = remainingAllocations.reduce((sum, a) => sum + (a.quantity * a.price), 0);

                        avgPurchasePrice = remainingQty > 0 ? parseFloat((remainingCost / remainingQty).toFixed(3)) : 0;
                        selectedSetId = remainingAllocations.length > 0 ? remainingAllocations[0].purchaseSetId : "";
                        allocatedSets = remainingAllocations;

                        restoredPurchasePrice = restoredQty > 0 ? parseFloat((restoredCost / restoredQty).toFixed(3)) : 0;

                        await variantResult.save({ session });
                        await syncProductStock(productId, session);

                        const parentProduct = await Product.findById(productId).session(session);
                        const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                        const newStockLog = await Stock.create([{
                            orderId: order.orderId,
                            orderRef: order._id,
                            type: "remove-item", // sign: +
                            category: "physical",
                            variantId: variantResult._id,
                            variantName: variantResult.name,
                            purchasePrice: restoredPurchasePrice,
                            sellingPrice: finalUnitSellingPrice,
                            quantity: restoreQty,
                            previousStock: variantResult.availableStock - restoreQty,
                            updatedStock: variantResult.availableStock,
                            previousPhysicalStock: variantResult.totalStock - restoreQty,
                            updatedPhysicalStock: variantResult.totalStock,
                            totalProductStock: currentTotalProductStock,
                            productId: productId
                        }], { session });

                        itemStockIds.push(newStockLog[0]._id);
                    }


                    if (itemStockIds.length > 0) {
                        await Stock.updateMany(
                            { _id: { $in: itemStockIds } },
                            {
                                $set: {
                                    sellingPrice: finalUnitSellingPrice,
                                    purchasePrice: avgPurchasePrice
                                }
                            },
                            { session }
                        );
                    }

                    const changes = [];
                    if (qty !== oldQty) {
                        changes.push(`Qty: ${oldQty} -> ${qty}`);
                    }
                    if (finalPrice !== oldInfo.price) {
                        changes.push(`Price: ₹${oldInfo.price} -> ₹${finalPrice}`);
                    }
                    if (finalDiscount !== oldInfo.discount) {
                        changes.push(`Discount: ₹${oldInfo.discount} -> ₹${finalDiscount}`);
                    }
                    if (changes.length > 0) {
                        itemChanges.push(`${variantName} (${changes.join(", ")})`);
                    }

                    newItems.push({
                        productId,
                        variantName,
                        quantity: qty,
                        price: finalPrice,
                        discount: finalDiscount,
                        discountPercent: finalDiscountPercent,
                        discountType: itemDiscountType,
                        stockIds: itemStockIds,
                        variantId: oldInfo.variantId || (await Variant.findOne({ productId, name: variantName }).session(session))?._id,
                        purchasePrice: avgPurchasePrice,
                        purchaseSetId: selectedSetId,
                        purchaseSets: allocatedSets
                    });

                    oldItemsMap.delete(key);
                }

                // Restore any completely deleted items
                for (const [key, oldInfo] of oldItemsMap.entries()) {
                    const oldQty = oldInfo.quantity;

                    // Resolve the query: prefer variantId, fall back to productId+name from composite key
                    const variantQuery = oldInfo.variantId
                        ? { _id: oldInfo.variantId }
                        : (() => { const [pid, vname] = key.split("_"); return { productId: pid, name: vname }; })();

                    const variantResult = await Variant.findOneAndUpdate(
                        variantQuery,
                        { $inc: { totalStock: oldQty, availableStock: oldQty } },
                        { new: true, session }
                    );

                    if (!variantResult) {
                        console.warn(`[updateOrderItems] Could not find variant to restore stock for key: ${key}`);
                        continue;
                    }

                    let allocatedSets = clonePurchaseSets(oldInfo.purchaseSets);
                    // Fallback populating allocatedSets if it was empty from bad/old data
                    if (allocatedSets.length === 0 && oldQty > 0) {
                        const fallbackSetId = oldInfo.purchaseSetId || (variantResult.purchaseSets[0] ? String(variantResult.purchaseSets[0]._id) : "");
                        if (fallbackSetId) {
                            allocatedSets = [{
                                purchaseSetId: fallbackSetId,
                                quantity: oldQty,
                                price: Number(oldInfo.purchasePrice || 0)
                            }];
                        }
                    }

                    let remainingToRestore = oldQty;
                    let restoredCost = 0;
                    let restoredQty = 0;

                    for (const alloc of allocatedSets) {
                        const take = Math.min(remainingToRestore, alloc.quantity);
                        if (take <= 0) continue;

                        const set = variantResult.purchaseSets.find(s => String(s._id) === String(alloc.purchaseSetId));
                        if (set) {
                            set.availableStock += take;
                            set.remainingStock += take;
                        }
                        remainingToRestore -= take;
                        restoredCost += take * alloc.price;
                        restoredQty += take;

                        if (remainingToRestore === 0) break;
                    }

                    if (remainingToRestore > 0 && variantResult.purchaseSets.length > 0) {
                        const firstSet = variantResult.purchaseSets[0];
                        firstSet.availableStock += remainingToRestore;
                        firstSet.remainingStock += remainingToRestore;
                        restoredCost += remainingToRestore * firstSet.price;
                        restoredQty += remainingToRestore;
                    }

                    const restoredPurchasePrice = restoredQty > 0 ? parseFloat((restoredCost / restoredQty).toFixed(3)) : 0;

                    await variantResult.save({ session });
                    await syncProductStock(variantResult.productId, session);

                    const parentProduct = await Product.findById(variantResult.productId).session(session);
                    const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                    await Stock.create([{
                        orderId: order.orderId,
                        orderRef: order._id,
                        type: "remove-item", // sign: +
                        category: "physical",
                        variantId: variantResult._id,
                        variantName: variantResult.name,
                        purchasePrice: restoredPurchasePrice,
                        sellingPrice: oldInfo.price - (oldInfo.discount / oldQty),
                        quantity: oldQty,
                        previousStock: variantResult.availableStock - oldQty,
                        updatedStock: variantResult.availableStock,
                        previousPhysicalStock: variantResult.totalStock - oldQty,
                        updatedPhysicalStock: variantResult.totalStock,
                        totalProductStock: currentTotalProductStock,
                        productId: variantResult.productId
                    }], { session });

                    itemChanges.push(`Removed item ${variantResult.name || key} (Qty: ${oldQty})`);
                }

                order.items = newItems;
            }

            // Recalculate totals
            let subtotal = 0;
            for (const item of order.items) {
                const qty = item.quantity;
                const price = item.price;
                subtotal += qty * (price - (item.discount || 0));
            }
            order.subtotal = subtotal;

            let flatDiscount = Number(discount !== undefined ? discount : order.discount);
            let percentDiscount = Number(discountPercent !== undefined ? discountPercent : order.discountPercent);
            // Use the saved discountType to decide which value is the anchor
            const globalDiscountType = req.body.discountType || order.discountType || 'flat';
            if (subtotal > 0) {
                if (globalDiscountType === 'percentage') {
                    // Percentage is the anchor — recompute flat from new subtotal
                    flatDiscount = parseFloat(((subtotal * percentDiscount) / 100).toFixed(2));
                } else {
                    // Flat is the anchor — keep flat constant, recompute percent for display
                    percentDiscount = parseFloat(((flatDiscount / subtotal) * 100).toFixed(2));
                }
            }
            order.discount = flatDiscount;
            order.discountPercent = percentDiscount;

            const delCharge = deliveryCharge !== undefined ? Number(deliveryCharge) : order.deliveryCharge;
            order.deliveryCharge = delCharge;

            order.orderAmount = Math.max(0, subtotal - flatDiscount + delCharge);
            order.remainingAmount = Math.max(0, order.orderAmount - order.amountPaid);

            if (order.remainingAmount <= 0) {
                order.paymentStatus = "Paid";
            } else {
                order.paymentStatus = "Pending";
            }

            await order.save({ session });

            const remarks = itemChanges.length > 0 ? `Updated items: ${itemChanges.join("; ")}` : "Order items, pricing, or quantities updated.";

            await logActivity({
                orderId: order._id,
                action: "Items Edited",
                remarks,
                req,
                session
            });
        });

        const updatedOrder = await Order.findById(id).populate("items.productId");
        return res.status(200).json(new ApiResponse(200, { order: updatedOrder }, "Order items updated successfully."));
    } catch (error) {
        console.error("Error in updateOrderItems:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

export const getOrderActivity = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const activityLogs = await ActivityLog.find({ orderId: id })
        .sort({ createdAt: -1 });
    return res.status(200).json(new ApiResponse(200, activityLogs, "Order activity logs fetched successfully."));
});

