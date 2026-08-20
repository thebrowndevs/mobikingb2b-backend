import mongoose from "mongoose";
import { Quotation } from "../models/quotation.model.js";
import { Order } from "../models/order.model.js";
import { Cart } from "../models/cart.model.js";
import { User } from "../models/user.model.js";
import { Variant } from "../models/variant.model.js";
import { Inventory } from "../models/inventory.model.js";
import { Stock } from "../models/stock.model.js";
import { Product } from "../models/product.model.js";
import { Payment } from "../models/payment.model.js";
import { ActivityLog } from "../models/activity_log.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { STOCK_TYPES } from "../constants.js";
import { Address } from "../models/address.model.js";
import { logActivity } from "../utils/activityLogger.js";
import {
    buildOldItemsMap,
    validateAndGetItemKey,
    calculateItemDelta
} from "../utils/quotation/quotationUpdate.utils.js";



import {
    clonePurchaseSets,
    allocatePurchaseSets,
    restorePurchaseSets,
    calculateWeightedPurchasePrice,
    savePurchaseSets
} from "../utils/quotation/quotationPurchaseSet.utils.js";

import {
    reserveVariantStock,
    releaseVariantStock,
    reserveInventoryStock,
    releaseInventoryStock,
    syncProductStock2
} from "../utils/quotation/quotationStock.utils.js";

import {
    buildPendingStockLog,
    insertPendingStockLogs,
    syncStockLogSellingPrices
} from "../utils/quotation/quotationStockLog.utils.js";

import {
    determineSlabForQuantity,
    syncItemDiscount,
    recalculateQuotationTotalsWebsite,
    recalculateQuotationTotalsAdmin
} from "../utils/pricing.js";

/**
 * Creates a new B2B Quotation from the user's cart.
 * Reserves stock virtually and logs virtual 'reserved' stock logs.
 */
export const createQuotation = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    try {
        let {
            name,
            email,
            phoneNo,
            comments,
            addressId,
            coupon,
            subtotal,
            discount = 0,
            discountPercent = 0,
            deliveryCharge = 0,
            orderAmount,
            gst
        } = req.body;

        const userId = req?.user?._id;
        const cartId = req?.user?.cart;

        if (!userId || !addressId || !cartId || !name || !phoneNo) {
            throw new ApiError(400, "Required checkout details are missing.");
        }

        const cart = await Cart.findById(cartId).populate("items.productId");
        if (!cart || cart.items.length === 0) {
            throw new ApiError(400, "Your cart is empty.");
        }

        const foundAddress = await Address.findById(addressId);
        if (!foundAddress) {
            throw new ApiError(404, "Warehouse address not found.");
        }

        const addressDetails = {
            address: `${foundAddress.street || ""}, ${foundAddress.street2 || ""}, ${foundAddress.city || ""}, ${foundAddress.state || ""}, ${foundAddress.pinCode || ""}`,
            address2: foundAddress.street2 || "",
            city: foundAddress.city || "",
            state: foundAddress.state || "",
            country: foundAddress.country || "India",
            pincode: foundAddress.pinCode || "",
            latitude: foundAddress.latitude || null,
            longitude: foundAddress.longitude || null
        };

        // Initialize new Quotation document
        let newQuote = new Quotation({
            userId,
            name: name.trim(),
            email: email?.trim() || "",
            phoneNo: phoneNo.trim(),
            comments: comments || "",
            addressId,
            ...addressDetails,
            coupon,
            subtotal,
            discount,
            discountPercent,
            deliveryCharge,
            orderAmount,
            status: "New",
            isAppOrder: req.body.isAppOrder || false,
            type: req.body.type || "Regular",
            items: cart.items,
            gst: gst || ""
        });

        // We run inside a transaction to ensure all stock is reserved atomically
        await session.withTransaction(async () => {
            // Save the Quotation (triggers QT_XXXXXX id generation)
            await newQuote.save({ session });

            const stockEntries = [];

            for (const item of cart.items) {
                const qty = Math.floor(Number(item.quantity));
                if (qty <= 0) continue;

                // 1. Atomically decrement availableStock on the Variant collection
                const variant = await Variant.findOneAndUpdate(
                    {
                        _id: item.variantId,
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

                const previousAvailableStock = variant.availableStock + qty;

                // FIFO allocation on purchaseSets availableStock
                let remaining = qty;
                const sortedSets = variant.purchaseSets
                    .map((set, idx) => ({ set, idx }))
                    .filter(item => item.set.availableStock > 0)
                    .sort((a, b) => a.set.price - b.set.price);

                let selectedSetId = "";
                let totalCost = 0;
                const allocatedSets = [];

                for (const itemObj of sortedSets) {
                    const set = variant.purchaseSets[itemObj.idx];
                    const take = Math.min(remaining, set.availableStock);
                    set.availableStock -= take;
                    totalCost += take * set.price;
                    allocatedSets.push({
                        purchaseSetId: String(set._id),
                        quantity: take,
                        price: set.price
                    });
                    remaining -= take;

                    if (!selectedSetId && take > 0) {
                        selectedSetId = String(set._id);
                    }

                    if (remaining === 0) break;
                }

                if (remaining > 0 && variant.purchaseSets.length > 0) {
                    variant.purchaseSets[0].availableStock = Math.max(0, variant.purchaseSets[0].availableStock - remaining);
                    allocatedSets.push({
                        purchaseSetId: String(variant.purchaseSets[0]._id),
                        quantity: remaining,
                        price: variant.purchaseSets[0].price
                    });
                    selectedSetId = String(variant.purchaseSets[0]._id);
                    totalCost += remaining * variant.purchaseSets[0].price;
                }

                const avgPurchasePrice = qty > 0 ? (totalCost / qty) : 0;

                // Sync the finalized purchase price and set ID on the Quotation items
                const quoteItem = newQuote.items.find(i => String(i.productId) === String(item.productId._id) && i.variantName === item.variantName);
                if (quoteItem) {
                    quoteItem.purchasePrice = avgPurchasePrice;
                    quoteItem.purchaseSetId = selectedSetId;
                    quoteItem.purchaseSets = allocatedSets;
                    quoteItem.variantId = variant._id;
                    quoteItem.sku = String(variant._id);
                }

                await variant.save({ session });

                // Update parent product availableStock
                const parentProduct = await Product.findByIdAndUpdate(
                    item.productId._id,
                    { $inc: { availableStock: -qty } },
                    { new: true, session }
                );
                const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;
                const productId = item.productId._id;

                // 2. Update Inventory (Reserved Stock)
                const inventory = await Inventory.findOne({ product: productId }).session(session);
                if (inventory) {
                    if (inventory.reservedStock + qty > inventory.physicalStock) {
                        throw new ApiError(400, `Cannot reserve ${qty} units; it exceeds available physical stock for product ${productId}.`);
                    }
                    inventory.reservedStock += qty;
                    await inventory.save({ session });
                } else {
                    await Inventory.create([
                        {
                            product: productId,
                            physicalStock: currentTotalProductStock,
                            reservedStock: qty,
                            version: 0
                        }
                    ], { session });
                }

                // 3. Queue Stock Log (Virtual Category - reserved)
                stockEntries.push({
                    quotationId: newQuote.quotationId,
                    quotationRef: newQuote._id,
                    type: STOCK_TYPES.RESERVED,
                    category: "virtual",
                    variantId: variant._id,
                    variantName: variant.name,
                    purchasePrice: avgPurchasePrice,
                    sellingPrice: Number(item.price || 0) - Number(item.discount || 0),
                    quantity: qty,
                    previousStock: previousAvailableStock,
                    updatedStock: variant.availableStock,
                    previousPhysicalStock: variant.totalStock,
                    updatedPhysicalStock: variant.totalStock,
                    totalProductStock: currentTotalProductStock,
                    productId: item.productId._id
                });
            }

            await logActivity({
                quotationId: newQuote._id,
                action: "Created",
                remarks: "Quotation created successfully.",
                req,
                session
            });

            // Write Stock logs and link IDs
            if (stockEntries.length > 0) {
                const insertedLogs = await Stock.insertMany(stockEntries, { session });
                for (const item of newQuote.items) {
                    const matchedLogs = insertedLogs.filter(
                        log => log.variantId && item.variantId && String(log.variantId) === String(item.variantId)
                    );
                    item.stockIds = matchedLogs.map(log => log._id);
                }
            }

            // Save Quotation item updates (including stockIds)
            await newQuote.save({ session });

            // Clear Cart
            cart.items = [];
            cart.totalCartValue = 0;
            await cart.save({ session });

            // Add quotation to user's quotations list
            await User.findByIdAndUpdate(
                req.user._id,
                { $push: { quotations: newQuote._id } },
                { session }
            );
        });

        // Fetch freshly populated user object
        const updatedUser = await User.findById(req.user._id)
            .select("-password -refreshToken")
            .populate({
                path: "cart",
                populate: {
                    path: "items.productId",
                    model: "Product"
                }
            })
            .populate("wishlist")
            .exec();

        return res.status(201).json(
            new ApiResponse(201, {
                quotation: newQuote,
                user: updatedUser
            }, "Quotation raised successfully.")
        );
    } catch (error) {
        console.error("Error in createQuotation:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

/**
 * Updates a Quotation status. Handles Hold, Cancellation/Rejection.
 */
export const updateQuotationStatus = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    try {
        const { quotationId, status, reason } = req.body;

        if (!quotationId || !status) {
            throw new ApiError(400, "Quotation ID and target status are required.");
        }

        const quotation = await Quotation.findById(quotationId);
        if (!quotation) {
            throw new ApiError(444, "Quotation not found.");
        }

        if (quotation.status === "Booked") {
            throw new ApiError(400, "Cannot modify a booked quotation.");
        }

        if (quotation.status === status) {
            return res.json(new ApiResponse(200, { quotation }, `Quotation is already in ${status} status.`));
        }

        const oldStatus = quotation.status;

        await session.withTransaction(async () => {
            quotation.status = status;
            if (reason) quotation.reason = reason;
            await quotation.save({ session });

            const stockEntries = [];

            // If moving to Cancelled / Rejected / Hold -> release reservation and restore variant availableStock
            if ((status === "Cancelled" || status === "Rejected" || status === "Hold") && !quotation.reservedStockRestored) {
                for (const item of quotation.items) {
                    const qty = Math.floor(Number(item.quantity));
                    if (qty <= 0) continue;

                    const variant = await Variant.findById(item.variantId).session(session);

                    if (variant) {
                        const previousAvailable = variant.availableStock;
                        variant.availableStock += qty;

                        // Restore availableStock to the specific purchaseSets
                        if (item.purchaseSets && item.purchaseSets.length > 0) {
                            for (const alloc of item.purchaseSets) {
                                const set = variant.purchaseSets.id(alloc.purchaseSetId);
                                if (set) {
                                    set.availableStock += alloc.quantity;
                                }
                            }
                        } else if (item.purchaseSetId) {
                            const set = variant.purchaseSets.id(item.purchaseSetId);
                            if (set) {
                                set.availableStock += qty;
                            } else if (variant.purchaseSets.length > 0) {
                                variant.purchaseSets[0].availableStock += qty;
                            }
                        } else if (variant.purchaseSets.length > 0) {
                            variant.purchaseSets[0].availableStock += qty;
                        }

                        await variant.save({ session });
                        await syncProductStock(item.productId, session);

                        // Update parent product availableStock
                        const parentProduct = await Product.findByIdAndUpdate(
                            item.productId,
                            { $inc: { availableStock: qty } },
                            { new: true, session }
                        );
                        const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                        // Reduce Inventory reservedStock
                        const inventory = await Inventory.findOne({ product: item.productId }).session(session);
                        if (inventory) {
                            inventory.reservedStock = Math.max(0, inventory.reservedStock - qty);
                            await inventory.save({ session });
                        }

                        // Queue Stock Log (Virtual - cancelled/rejected/hold)
                        let logType = STOCK_TYPES.CANCELLED;
                        if (status === "Rejected") logType = STOCK_TYPES.REJECTED;
                        if (status === "Hold") logType = STOCK_TYPES.HOLD;

                        stockEntries.push({
                            quotationId: quotation.quotationId,
                            quotationRef: quotation._id,
                            type: logType,
                            category: "virtual",
                            variantId: variant._id,
                            variantName: variant.name,
                            purchasePrice: item.purchasePrice || 0,
                            sellingPrice: Math.max(0, Number(item.price || 0) - (qty > 0 ? (Number(item.discount || 0) / qty) : 0)),
                            quantity: qty,
                            previousStock: previousAvailable,
                            updatedStock: variant.availableStock,
                            previousPhysicalStock: variant.totalStock,
                            updatedPhysicalStock: variant.totalStock,
                            totalProductStock: currentTotalProductStock,
                            productId: item.productId
                        });
                    }
                }
                quotation.reservedStockRestored = true;
                await quotation.save({ session });
            }
            // If moving BACK to Accepted / New from a previously restored state -> re-reserve variant availableStock
            else if ((status === "Accepted" || status === "New") && quotation.reservedStockRestored) {
                for (const item of quotation.items) {
                    const qty = Math.floor(Number(item.quantity));
                    if (qty <= 0) continue;

                    const variant = await Variant.findById(item.variantId).session(session);

                    if (!variant || variant.availableStock < qty) {
                        throw new ApiError(400, `Insufficient available stock to re-reserve variant "${item.variantName}".`);
                    }

                    const previousAvailable = variant.availableStock;
                    variant.availableStock -= qty;

                    // Deduct availableStock from specific purchaseSets
                    if (item.purchaseSets && item.purchaseSets.length > 0) {
                        for (const alloc of item.purchaseSets) {
                            const set = variant.purchaseSets.id(alloc.purchaseSetId);
                            if (set) {
                                set.availableStock = Math.max(0, set.availableStock - alloc.quantity);
                            }
                        }
                    } else if (item.purchaseSetId) {
                        const set = variant.purchaseSets.id(item.purchaseSetId);
                        if (set) {
                            set.availableStock = Math.max(0, set.availableStock - qty);
                        } else if (variant.purchaseSets.length > 0) {
                            variant.purchaseSets[0].availableStock = Math.max(0, variant.purchaseSets[0].availableStock - qty);
                        }
                    } else if (variant.purchaseSets.length > 0) {
                        variant.purchaseSets[0].availableStock = Math.max(0, variant.purchaseSets[0].availableStock - qty);
                    }

                    await variant.save({ session });
                    await syncProductStock(item.productId, session);

                    // Deduct parent product availableStock
                    const parentProduct = await Product.findByIdAndUpdate(
                        item.productId,
                        { $inc: { availableStock: -qty } },
                        { new: true, session }
                    );
                    const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                    // Increase Inventory reservedStock
                    const inventory = await Inventory.findOne({ product: item.productId }).session(session);
                    if (inventory) {
                        inventory.reservedStock += qty;
                        await inventory.save({ session });
                    }

                    // Queue Stock Log (Virtual - reserved)
                    stockEntries.push({
                        quotationId: quotation.quotationId,
                        quotationRef: quotation._id,
                        type: STOCK_TYPES.RESERVED,
                        category: "virtual",
                        variantId: variant._id,
                        variantName: variant.name,
                        purchasePrice: item.purchasePrice || 0,
                        sellingPrice: Math.max(0, Number(item.price || 0) - (qty > 0 ? (Number(item.discount || 0) / qty) : 0)),
                        quantity: qty,
                        previousStock: previousAvailable,
                        updatedStock: variant.availableStock,
                        previousPhysicalStock: variant.totalStock,
                        updatedPhysicalStock: variant.totalStock,
                        totalProductStock: currentTotalProductStock,
                        productId: item.productId
                    });
                }
                quotation.reservedStockRestored = false;
                await quotation.save({ session });
            }

            if (stockEntries.length > 0) {
                await Stock.insertMany(stockEntries, { session });
            }

            await logActivity({
                quotationId: quotation._id,
                action: status,
                remarks: reason || `Quotation status updated from ${oldStatus} to ${status}.`,
                req,
                session
            });
        });

        return res.json(new ApiResponse(200, { quotation }, `Quotation status updated to ${status}.`));
    } catch (error) {
        console.error("Error in updateQuotationStatus:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

/**
 * Books a Quotation, converting it to a physical Order.
 * Reduces physicalStock & reservedStock in Inventory, and logs physical 'purchase' stock entry.
 */
export const bookQuotation = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    try {
        const { quotationId } = req.body;

        if (!quotationId) {
            throw new ApiError(400, "Quotation ID is required.");
        }

        const quotation = await Quotation.findById(quotationId);
        if (!quotation) {
            throw new ApiError(404, "Quotation not found.");
        }

        if (quotation.status === "Booked") {
            throw new ApiError(400, "Quotation is already booked.");
        }

        if (quotation.status === "Cancelled" || quotation.status === "Rejected") {
            throw new ApiError(400, "Cannot book a cancelled or rejected quotation.");
        }

        // Get the numeric sequence code from quotationId (e.g. QT_80005 -> 80005)
        const numericPart = quotation.quotationId.replace("QT_", "");

        // Create standard Order
        const newOrder = new Order({
            status: "Accepted",
            paymentStatus: "Pending",
            orderState: "Confirmed",
            abondonedOrder: false,
            orderId: numericPart,
            quotationId: quotation.quotationId,
            quotationRef: quotation._id,

            // Copy charges
            subtotal: quotation.subtotal,
            discount: quotation.discount,
            deliveryCharge: quotation.deliveryCharge,
            orderAmount: quotation.orderAmount,
            gst: quotation.gst,

            // Stage payment values
            amountPaid: 0,
            remainingAmount: quotation.orderAmount,
            shippingType: "Manual",

            // Copy customer billing info
            name: quotation.name,
            email: quotation.email,
            phoneNo: quotation.phoneNo,

            // Copy address
            address: quotation.address,
            address2: quotation.address2,
            city: quotation.city,
            state: quotation.state,
            pincode: quotation.pincode,
            country: quotation.country,
            addressId: quotation.addressId,

            userId: quotation.userId,
            query: quotation.query,
            items: quotation.items,

            // Geolocation
            latitude: quotation.latitude || null,
            longitude: quotation.longitude || null,

            // B2B booking specific details
            paymentMode: req.body.paymentMode,
            method: req.body.method || quotation.method || "COD",
            type: quotation.type || "Regular",
            isAppOrder: quotation.isAppOrder === true,
            length: Number(req.body.length) || quotation.length || 19,
            breadth: Number(req.body.breadth) || quotation.breadth || 16,
            height: Number(req.body.height) || quotation.height || 6,
            weight: Number(req.body.weight) || quotation.weight || 0.5
        });

        await session.withTransaction(async () => {
            // Save the booked order
            await newOrder.save({ session });

            // Create Payment stages if provided
            if (req.body.stages && Array.isArray(req.body.stages)) {
                const isCouponApplied = !!(newOrder.couponCode || newOrder.coupon);
                const couponApplied = isCouponApplied ? (newOrder.discount || 0) : 0;
                const discountApplied = isCouponApplied ? 0 : (newOrder.discount || 0);

                const paymentsToCreate = req.body.stages.map(stg => ({
                    orderId: newOrder.orderId,
                    orderRef: newOrder._id,
                    userId: quotation.userId,
                    amount: Number(stg.amount),
                    subtotal: Number(newOrder.subtotal || 0),
                    discount: Number(discountApplied),
                    coupon: Number(couponApplied),
                    couponId: newOrder.coupon || undefined,
                    method: stg.method,
                    status: stg.status || "Pending",
                    notes: stg.notes || "",
                    paidAt: stg.status === "Paid" ? new Date() : undefined
                }));
                const insertedPayments = await Payment.insertMany(paymentsToCreate, { session });

                // Call notification for any pending payments
                try {
                    const { sendPendingPaymentNotification } = await import("../services/firebase.service.js");
                    for (const p of insertedPayments) {
                        if (p.status === "Pending") {
                            sendPendingPaymentNotification(p.userId, p.orderRef, p._id, p.amount, newOrder.orderId);
                        }
                    }
                } catch (notiErr) {
                    console.error("FCM Notification failed in bookQuotation:", notiErr);
                }

                // Calculate amountPaid and remainingAmount
                const totalPaid = paymentsToCreate
                    .filter(p => p.status === "Paid")
                    .reduce((acc, curr) => acc + curr.amount, 0);

                newOrder.amountPaid = totalPaid;
                newOrder.remainingAmount = Math.max(0, newOrder.orderAmount - totalPaid);
                await newOrder.save({ session });
            }

            // Mark quotation status as Booked and link to order
            quotation.status = "Booked";
            quotation.orderRef = newOrder._id;
            quotation.orderId = newOrder.orderId;
            await quotation.save({ session });

            // Add order to user's orders list and increment customer orderCount
            await User.findByIdAndUpdate(
                quotation.userId,
                {
                    $push: { orders: newOrder._id },
                    $inc: { orderCount: 1 }
                },
                { session }
            );

            const stockEntries = [];

            // Perform inventory physical deductions & log physical 'purchase' logs
            for (const item of quotation.items) {
                const qty = Math.floor(Number(item.quantity));
                if (qty <= 0) continue;

                // 1. Atomically decrement variant stock levels first and increment variant orderCount
                const updateInc = { totalStock: -qty, orderCount: 1 };
                if (quotation.reservedStockRestored) {
                    updateInc.availableStock = -qty;
                }

                const variant = await Variant.findOneAndUpdate(
                    { _id: item.variantId },
                    { $inc: updateInc },
                    { new: true, session }
                );

                // Append order ID to product and increment product level orderCount
                await Product.findByIdAndUpdate(
                    item.productId,
                    {
                        $push: { orders: newOrder._id },
                        $inc: { orderCount: 1 }
                    },
                    { session }
                );

                if (variant) {
                    const previousAvailable = variant.availableStock + (quotation.reservedStockRestored ? qty : 0);
                    const previousPhysical = variant.totalStock + qty;

                    // Normalize and check item.purchaseSets for B2B array-based batches
                    if (!item.purchaseSets || item.purchaseSets.length === 0) {
                        const fallbackSetId = item.purchaseSetId || (variant.purchaseSets[0] ? String(variant.purchaseSets[0]._id) : "");
                        item.purchaseSets = [{
                            purchaseSetId: fallbackSetId,
                            quantity: qty,
                            price: item.purchasePrice || (variant.purchaseSets[0]?.price || 0)
                        }];
                        item.purchaseSetId = fallbackSetId;
                    }

                    // Deduct remainingStock and availableStock from variant purchaseSets
                    for (const alloc of item.purchaseSets) {
                        if (alloc.purchaseSetId) {
                            const set = variant.purchaseSets.id(alloc.purchaseSetId);
                            if (set) {
                                set.remainingStock = Math.max(0, set.remainingStock - alloc.quantity);
                                if (quotation.reservedStockRestored) {
                                    set.availableStock = Math.max(0, set.availableStock - alloc.quantity);
                                }
                            }
                        } else if (variant.purchaseSets.length > 0) {
                            variant.purchaseSets[0].remainingStock = Math.max(0, variant.purchaseSets[0].remainingStock - alloc.quantity);
                            if (quotation.reservedStockRestored) {
                                variant.purchaseSets[0].availableStock = Math.max(0, variant.purchaseSets[0].availableStock - alloc.quantity);
                            }
                        }
                    }

                    await variant.save({ session });

                    // Sync the finalized purchase details on the Order items
                    const orderItem = newOrder.items.find(i => String(i.productId) === String(item.productId) && i.variantName === item.variantName);
                    if (orderItem) {
                        orderItem.purchasePrice = item.purchasePrice;
                        orderItem.purchaseSetId = item.purchaseSetId;
                        orderItem.purchaseSets = item.purchaseSets;
                        orderItem.appliedSlab = item.appliedSlab;
                    }

                    // Sync parent product and inventory stock levels
                    await syncProductStock(item.productId, session);

                    // Fetch parent product to get updated totalProductStock for logging
                    const parentProduct = await Product.findById(item.productId).session(session);
                    const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                    // Deduct reserved stock from Inventory if not restored
                    const inventory = await Inventory.findOne({ product: item.productId }).session(session);
                    if (inventory && !quotation.reservedStockRestored) {
                        inventory.reservedStock = Math.max(0, inventory.reservedStock - qty);
                        await inventory.save({ session });
                    }

                    // 3. Queue Physical 'purchase' Stock Log
                    stockEntries.push({
                        orderId: numericPart,
                        orderRef: newOrder._id,
                        quotationId: quotation.quotationId,
                        quotationRef: quotation._id,
                        type: STOCK_TYPES.PURCHASE,
                        category: "physical",
                        variantId: variant._id,
                        variantName: variant.name,
                        purchasePrice: item.purchasePrice || 0,
                        sellingPrice: Number(item.price || 0) - Number(item.discount || 0),
                        quantity: qty,
                        previousStock: previousAvailable,
                        updatedStock: variant.availableStock,
                        previousPhysicalStock: previousPhysical,
                        updatedPhysicalStock: variant.totalStock,
                        totalProductStock: currentTotalProductStock,
                        productId: item.productId
                    });
                }
            }

            // Write Stock logs and link IDs
            if (stockEntries.length > 0) {
                const insertedLogs = await Stock.insertMany(stockEntries, { session });
                for (const item of newOrder.items) {
                    const matchedLogs = insertedLogs.filter(
                        log => log.variantId && item.variantId && String(log.variantId) === String(item.variantId)
                    );
                    item.stockIds = matchedLogs.map(log => log._id);
                }
                for (const item of quotation.items) {
                    const matchedLogs = insertedLogs.filter(
                        log => log.variantId && item.variantId && String(log.variantId) === String(item.variantId)
                    );
                    item.stockIds = matchedLogs.map(log => log._id);
                }
            }

            // Save updated order and quotation items
            await newOrder.save({ session });
            await quotation.save({ session });
        });

        return res.json(new ApiResponse(200, { quotation, order: newOrder }, "Quotation booked successfully. Physical order generated."));
    } catch (error) {
        console.error("Error in bookQuotation:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

/**
 * Returns all quotations for the logged-in customer.
 */
export const getMyQuotations = asyncHandler(async (req, res) => {
    const list = await Quotation.find({ userId: req.user._id })
        .populate("items.productId")
        .sort({ createdAt: -1 });

    // Hiding purchasePrice and purchaseSetId from customer responses
    const filteredList = list.map(q => {
        const qObj = q.toObject();
        if (qObj.items) {
            qObj.items = qObj.items.map(it => {
                delete it.purchasePrice;
                delete it.purchaseSetId;
                return it;
            });
        }
        return qObj;
    });

    return res.json(new ApiResponse(200, filteredList, "My quotations retrieved successfully."));
});

/**
 * Returns all quotations (Admin view).
 */
export const getAllQuotations = asyncHandler(async (req, res) => {
    const list = await Quotation.find({})
        .populate("userId", "name phoneNo")
        .populate("items.productId")
        .sort({ createdAt: -1 });

    return res.json(new ApiResponse(200, list, "All quotations retrieved successfully."));
});

const syncProductStock = async (productId, session) => {
    const variants = await Variant.find({ productId }).session(session);
    let totalStockSum = 0;
    let availableStockSum = 0;
    for (const v of variants) {
        totalStockSum += v.totalStock || 0;
        availableStockSum += v.availableStock || 0;
    }

    // Ensure Inventory exists and validates reserved stock against physical stock
    let inventory = await Inventory.findOne({ product: productId }).session(session);
    if (!inventory) {
        // Create inventory record if missing
        inventory = await Inventory.create([
            {
                product: productId,
                physicalStock: totalStockSum,
                reservedStock: 0,
                version: 0
            }
        ], { session });
    } else {
        // Validate that reserved stock does not exceed physical stock
        if (inventory.reservedStock > totalStockSum) {
            throw new ApiError(500, `Inventory reserved stock (${inventory.reservedStock}) exceeds physical stock (${totalStockSum}) for product ${productId}.`);
        }
    }

    await Product.findByIdAndUpdate(
        productId,
        {
            totalStock: totalStockSum,
            totalProductStock: totalStockSum,
            availableStock: availableStockSum,
            // Sync physical stock in inventory as well
            // (if inventory was just created, this will be consistent)
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

/**
 * Admin updates quotation details, items, quantities, discounts, and delivery charges.
 * Re-evaluates stock reservations accordingly.
 */
export const updateQuotation = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    try {
        const {
            quotationId,
            items, // Array of { productId, variantName, quantity, discount }
            deliveryCharge,
            discount,
            discountPercent,
            discountType,
            comments,
            name,
            email,
            phoneNo,
            address,
            address2,
            city,
            state,
            pincode,
            country
        } = req.body;

        if (!quotationId) {
            throw new ApiError(400, "Quotation ID is required.");
        }

        await session.withTransaction(async () => {
            const quotation = await Quotation.findById(quotationId).session(session);
            if (!quotation) {
                throw new ApiError(404, "Quotation not found.");
            }

            if (quotation.status === "Booked") {
                throw new ApiError(400, "Cannot edit a booked quotation.");
            }
            // Step 1: If stock is currently reserved, restore the old reservation first
            if (!quotation.reservedStockRestored) {
                for (const item of quotation.items) {
                    const qty = Math.floor(Number(item.quantity));
                    if (qty <= 0) continue;

                    const variant = await Variant.findOneAndUpdate(
                        { _id: item.variantId },
                        { $inc: { availableStock: qty } },
                        { new: true, session }
                    );

                    if (variant) {
                        if (item.purchaseSets && item.purchaseSets.length > 0) {
                            for (const alloc of item.purchaseSets) {
                                const set = variant.purchaseSets.id(alloc.purchaseSetId);
                                if (set) {
                                    set.availableStock += alloc.quantity;
                                }
                            }
                        } else if (item.purchaseSetId) {
                            const set = variant.purchaseSets.id(item.purchaseSetId);
                            if (set) {
                                set.availableStock += qty;
                            } else if (variant.purchaseSets.length > 0) {
                                variant.purchaseSets[0].availableStock += qty;
                            }
                        } else if (variant.purchaseSets.length > 0) {
                            variant.purchaseSets[0].availableStock += qty;
                        }

                        await variant.save({ session });
                        await syncProductStock(item.productId, session);

                        // Reduce Inventory reservedStock
                        const inventory = await Inventory.findOne({ product: item.productId }).session(session);
                        if (inventory) {
                            inventory.reservedStock = Math.max(0, inventory.reservedStock - qty);
                            await inventory.save({ session });
                        }
                    }
                }
            }

            // Step 2: Set basic properties if provided
            if (name !== undefined) quotation.name = name.trim();
            if (email !== undefined) quotation.email = email.trim();
            if (phoneNo !== undefined) quotation.phoneNo = phoneNo.trim();
            if (comments !== undefined) quotation.comments = comments;
            if (deliveryCharge !== undefined) quotation.deliveryCharge = Number(deliveryCharge);
            if (discountType !== undefined) quotation.discountType = discountType;
            if (discount !== undefined) {
                quotation.discount = Number(discount);
                if (discountPercent === undefined) {
                    quotation.discountPercent = 0;
                }
            }
            if (discountPercent !== undefined) {
                quotation.discountPercent = Number(discountPercent);
                if (discount === undefined) {
                    quotation.discount = 0;
                }
            }
            if (address !== undefined) quotation.address = address;
            if (address2 !== undefined) quotation.address2 = address2;
            if (city !== undefined) quotation.city = city;
            if (state !== undefined) quotation.state = state;
            if (pincode !== undefined) quotation.pincode = pincode;
            if (country !== undefined) quotation.country = country;

            // Step 3: If items are updated, recalculate pricing and re-reserve stock
            if (items && Array.isArray(items)) {
                const newItems = [];
                const stockEntries = [];

                for (const updatedItem of items) {
                    const { productId, variantName, quantity, price, discount: itemDiscount = 0, discountPercent: itemDiscountPercent = 0 } = updatedItem;
                    const qty = Math.floor(Number(quantity));
                    if (qty <= 0) continue;

                    // Fetch Product to calculate price and get details
                    const product = await Product.findById(productId).session(session);
                    if (!product) {
                        throw new ApiError(404, `Product not found for ID: ${productId}`);
                    }

                    // Locate the Variant
                    let variant;
                    if (!quotation.reservedStockRestored) {
                        variant = await Variant.findOneAndUpdate(
                            {
                                productId,
                                name: variantName,
                                active: true,
                                availableStock: { $gte: qty }
                            },
                            { $inc: { availableStock: -qty } },
                            { new: true, session }
                        );
                        if (!variant) {
                            throw new ApiError(400, `Insufficient available stock for variant "${variantName}" of product "${product.fullName}".`);
                        }
                    } else {
                        variant = await Variant.findOne({ productId, name: variantName, active: true }).session(session);
                        if (!variant) {
                            throw new ApiError(404, `Active variant "${variantName}" not found for product "${product.fullName}".`);
                        }
                    }

                    // Check and reserve available stock if not restored
                    // Preserve original purchase data for possible reuse
                    const oldItem = quotation.items.find(it => it.productId.toString() === productId.toString() && it.variantName === variantName);
                    let selectedSetId = "";
                    let avgPurchasePrice = 0;
                    let allocatedSets = [];

                    if (!quotation.reservedStockRestored) {
                        const previousAvailable = variant.availableStock + qty;

                        // FIFO allocation on purchaseSets availableStock
                        let remaining = qty;
                        const sortedSets = variant.purchaseSets
                            .map((set, idx) => ({ set, idx }))
                            .filter(item => item.set.availableStock > 0)
                            .sort((a, b) => a.set.price - b.set.price);

                        let totalCost = 0;

                        for (const itemObj of sortedSets) {
                            const set = variant.purchaseSets[itemObj.idx];
                            const take = Math.min(remaining, set.availableStock);
                            set.availableStock -= take;
                            totalCost += take * set.price;
                            allocatedSets.push({
                                purchaseSetId: String(set._id),
                                quantity: take,
                                price: set.price
                            });
                            remaining -= take;

                            if (!selectedSetId && take > 0) {
                                selectedSetId = String(set._id);
                            }

                            if (remaining === 0) break;
                        }

                        if (remaining > 0 && variant.purchaseSets.length > 0) {
                            variant.purchaseSets[0].availableStock = Math.max(0, variant.purchaseSets[0].availableStock - remaining);
                            allocatedSets.push({
                                purchaseSetId: String(variant.purchaseSets[0]._id),
                                quantity: remaining,
                                price: variant.purchaseSets[0].price
                            });
                            selectedSetId = String(variant.purchaseSets[0]._id);
                            totalCost += remaining * variant.purchaseSets[0].price;
                        }

                        avgPurchasePrice = qty > 0 ? (totalCost / qty) : 0;
                        await variant.save({ session });
                        await syncProductStock(productId, session);

                        const parentProduct = await Product.findById(productId).session(session);
                        const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                        // Update Inventory
                        const inventory = await Inventory.findOne({ product: productId }).session(session);
                        if (inventory) {
                            inventory.reservedStock += qty;
                            await inventory.save({ session });
                        } else {
                            await Inventory.create([{
                                product: productId,
                                physicalStock: currentTotalProductStock,
                                reservedStock: qty,
                                version: 0
                            }], { session });
                        }

                        // Add Stock Log entry
                        stockEntries.push({
                            quotationId: quotation.quotationId,
                            quotationRef: quotation._id,
                            type: STOCK_TYPES.RESERVED,
                            category: "virtual",
                            variantId: variant._id,
                            variantName: variant.name,
                            purchasePrice: avgPurchasePrice,
                            quantity: qty,
                            previousStock: previousAvailable,
                            updatedStock: variant.availableStock,
                            previousPhysicalStock: variant.totalStock,
                            updatedPhysicalStock: variant.totalStock,
                            totalProductStock: currentTotalProductStock,
                            productId
                        });
                    } else {
                        // Preserve existing purchase data from the old item if available
                        if (oldItem) {
                            avgPurchasePrice = oldItem.purchasePrice || 0;
                            selectedSetId = oldItem.purchaseSetId || "";
                            if (oldItem.purchaseSets && oldItem.purchaseSets.length > 0) {
                                allocatedSets = oldItem.purchaseSets.map(ps => ({
                                    purchaseSetId: ps.purchaseSetId,
                                    quantity: ps.quantity,
                                    price: ps.price
                                }));
                            }
                        } else {
                            if (variant.purchaseSets && variant.purchaseSets.length > 0) {
                                avgPurchasePrice = variant.purchaseSets[0].price || 0;
                                selectedSetId = String(variant.purchaseSets[0]._id);
                                allocatedSets.push({
                                    purchaseSetId: selectedSetId,
                                    quantity: qty,
                                    price: avgPurchasePrice
                                });
                            }
                        }
                    }


                    const finalPrice = price !== undefined && price !== null ? Number(price) : (oldItem ? oldItem.price : 0);

                    newItems.push({
                        productId,
                        variantName,
                        quantity: qty,
                        price: finalPrice,
                        purchasePrice: avgPurchasePrice,
                        purchaseSetId: selectedSetId,
                        purchaseSets: allocatedSets,
                        variantId: variant._id,
                        sku: String(variant._id),
                        discount: Number(itemDiscount),
                        discountPercent: Number(itemDiscountPercent)
                    });
                }

                // Detect deleted items and forbid them
                const deletedItems = quotation.items.filter(oldItem => !items.some(it => it.productId.toString() === oldItem.productId.toString() && it.variantName === oldItem.variantName));
                if (deletedItems.length > 0) {
                    throw new ApiError(400, "Deleted items are not allowed. Use proper endpoint to remove items.");
                }

                quotation.items = newItems;

                if (stockEntries.length > 0) {
                    await Stock.insertMany(stockEntries, { session });
                }
            }

            if (items && Array.isArray(items)) {
                await recalculateQuotationTotalsAdmin(quotation, session, true, deliveryCharge !== undefined);
            } else if (req.body.orderAmount !== undefined) {
                quotation.orderAmount = Number(req.body.orderAmount);
            }
            await quotation.save({ session });

            await logActivity({
                quotationId: quotation._id,
                action: "Items Edited",
                remarks: "Quotation items and charges updated by admin.",
                req,
                session
            });
        });

        const updatedQuotation = await Quotation.findById(quotationId).populate("items.productId");
        return res.json(new ApiResponse(200, { quotation: updatedQuotation }, "Quotation updated successfully."));
    } catch (error) {
        console.error("Error in updateQuotation:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

/**
 * ADD ITEM QUANTITY IN QUOTATION (ORDER REQUEST)
 */
export const addItemQuantityInQuotation = asyncHandler(async (req, res) => {
    const { quotationId, productId, variantId, variantName, quantity = 1 } = req.body;

    if (!quotationId || !productId || (!variantId && !variantName) || quantity <= 0) {
        throw new ApiError(400, "Invalid inputs. quotationId, productId, variantId or variantName, and positive quantity are required.");
    }

    const session = await mongoose.startSession();
    try {
        let updatedQuotation;
        await session.withTransaction(async () => {
            const quotation = await Quotation.findById(quotationId).session(session);
            if (!quotation) throw new ApiError(404, "Quotation not found.");

            if (["Booked", "Rejected", "Cancelled"].includes(quotation.status)) {
                throw new ApiError(400, `Cannot add items to a quotation in ${quotation.status} status.`);
            }

            const product = await Product.findById(productId).session(session);
            if (!product) throw new ApiError(404, "Product not found.");

            let variant;
            if (!quotation.reservedStockRestored) {
                const query = variantId ? { _id: variantId } : { productId, name: variantName, active: true };
                query.availableStock = { $gte: quantity };

                variant = await Variant.findOneAndUpdate(
                    query,
                    { $inc: { availableStock: -quantity } },
                    { new: true, session }
                );
                if (!variant) {
                    throw new ApiError(400, `Insufficient available stock for variant.`);
                }
            } else {
                if (variantId) {
                    variant = await Variant.findById(variantId).session(session);
                } else if (variantName) {
                    variant = await Variant.findOne({ productId, name: variantName, active: true }).session(session);
                }
                if (!variant) throw new ApiError(404, `Active variant not found.`);
            }

            const existingItem = quotation.items.find(item => {
                const matchesProduct = item.productId.toString() === productId.toString();
                const matchesVariant = variantId
                    ? (item.variantId && item.variantId.toString() === variantId.toString())
                    : (item.variantName === variant.name);
                return matchesProduct && matchesVariant;
            });

            let selectedSetId = "";
            let avgPurchasePrice = 0;
            const allocatedSets = [];
            let newLog;

            // Handle stock reservations if not restored/released
            if (!quotation.reservedStockRestored) {
                const previousAvailable = variant.availableStock + quantity;

                // FIFO allocation
                let remaining = quantity;
                let totalCost = 0;
                const sortedSets = variant.purchaseSets
                    .map((set, idx) => ({ set, idx }))
                    .filter(item => item.set.availableStock > 0)
                    .sort((a, b) => a.set.price - b.set.price);

                for (const itemObj of sortedSets) {
                    const set = variant.purchaseSets[itemObj.idx];
                    const take = Math.min(remaining, set.availableStock);
                    set.availableStock -= take;
                    totalCost += take * set.price;
                    allocatedSets.push({
                        purchaseSetId: String(set._id),
                        quantity: take,
                        price: set.price
                    });
                    remaining -= take;

                    if (!selectedSetId && take > 0) {
                        selectedSetId = String(set._id);
                    }
                    if (remaining === 0) break;
                }

                if (remaining > 0 && variant.purchaseSets.length > 0) {
                    variant.purchaseSets[0].availableStock = Math.max(0, variant.purchaseSets[0].availableStock - remaining);
                    allocatedSets.push({
                        purchaseSetId: String(variant.purchaseSets[0]._id),
                        quantity: remaining,
                        price: variant.purchaseSets[0].price
                    });
                    selectedSetId = String(variant.purchaseSets[0]._id);
                    totalCost += remaining * variant.purchaseSets[0].price;
                }

                avgPurchasePrice = quantity > 0 ? (totalCost / quantity) : 0;
                await variant.save({ session });
                await syncProductStock(productId, session);

                const parentProduct = await Product.findById(productId).session(session);
                const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                // Update Inventory
                const inventory = await Inventory.findOne({ product: productId }).session(session);
                if (inventory) {
                    inventory.reservedStock += quantity;
                    await inventory.save({ session });
                } else {
                    await Inventory.create([{
                        product: productId,
                        physicalStock: currentTotalProductStock,
                        reservedStock: quantity,
                        version: 0
                    }], { session });
                }

                const finalSellingPrice = existingItem
                    ? (Number(existingItem.price || 0) - Number(existingItem.discount || 0))
                    : (() => {
                        const matchedSlab = determineSlabForQuantity(product, quantity);
                        return matchedSlab ? matchedSlab.price : (product.basePrice || 0);
                    })();

                // Insert Stock Log
                newLog = await Stock.create([{
                    quotationId: quotation.quotationId,
                    quotationRef: quotation._id,
                    type: STOCK_TYPES.ADD,
                    category: "virtual",
                    variantId: variant._id,
                    variantName: variant.name,
                    purchasePrice: Number(avgPurchasePrice) || 0,
                    sellingPrice: finalSellingPrice,
                    quantity,
                    previousStock: previousAvailable,
                    updatedStock: variant.availableStock,
                    previousPhysicalStock: variant.totalStock,
                    updatedPhysicalStock: variant.totalStock,
                    totalProductStock: currentTotalProductStock,
                    productId
                }], { session });
            } else {
                // If stock was restored, grab default price
                if (variant.purchaseSets && variant.purchaseSets.length > 0) {
                    avgPurchasePrice = variant.purchaseSets[0].price || 0;
                    selectedSetId = String(variant.purchaseSets[0]._id);
                    allocatedSets.push({
                        purchaseSetId: selectedSetId,
                        quantity,
                        price: avgPurchasePrice
                    });
                }
            }

            const newTotalQty = existingItem ? (existingItem.quantity + quantity) : quantity;

            if (existingItem) {
                existingItem.quantity = newTotalQty;
                // Price will be recalculated via recalculateQuotationTotals helper
                if (avgPurchasePrice > 0) {
                    const currentPurchasePrice = existingItem.purchasePrice || 0;
                    existingItem.purchasePrice = parseFloat((((currentPurchasePrice * (newTotalQty - quantity)) + (avgPurchasePrice * quantity)) / newTotalQty).toFixed(3)) || 0;
                }

                // Merge purchaseSets array
                if (!existingItem.purchaseSets) {
                    existingItem.purchaseSets = [];
                }
                for (const alloc of allocatedSets) {
                    const matched = existingItem.purchaseSets.find(s => s.purchaseSetId === alloc.purchaseSetId);
                    if (matched) {
                        matched.quantity += alloc.quantity;
                    } else {
                        existingItem.purchaseSets.push(alloc);
                    }
                }
                existingItem.purchaseSetId = selectedSetId;

                if (newLog) {
                    if (!existingItem.stockIds) {
                        existingItem.stockIds = [];
                    }
                    existingItem.stockIds.push(newLog[0]._id);
                }
            } else {
                const matchedSlab = determineSlabForQuantity(product, quantity);
                const slabPrice = matchedSlab ? matchedSlab.price : (product.basePrice || 0);

                quotation.items.push({
                    productId,
                    variantName: variant.name,
                    quantity,
                    price: slabPrice,
                    purchasePrice: avgPurchasePrice,
                    purchaseSetId: selectedSetId,
                    purchaseSets: allocatedSets,
                    variantId: variant._id,
                    sku: String(variant._id),
                    discount: 0,
                    appliedSlab: matchedSlab ? {
                        quantity: matchedSlab.quantity,
                        price: matchedSlab.price
                    } : undefined,
                    stockIds: newLog ? [newLog[0]._id] : []
                });
            }

            // Recalculate totals
            await recalculateQuotationTotalsAdmin(quotation, session, true);

            await syncStockLogSellingPrices({
                items: quotation.items,
                quotationRef: quotation._id,
                session
            });

            updatedQuotation = await quotation.save({ session });

            await logActivity({
                quotationId: quotation._id,
                action: "Item Added",
                remarks: `Added ${quantity} of ${variantName || "item"} to quotation.`,
                req,
                session
            });
        });

        const populated = await Quotation.findById(updatedQuotation._id).populate("items.productId");
        return res.status(200).json(new ApiResponse(200, { quotation: populated }, "Item added to quotation successfully."));
    } catch (error) {
        console.error("Error in addItemQuantityInQuotation:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

/**
 * REMOVE ITEM QUANTITY IN QUOTATION (ORDER REQUEST)
 */
export const removeItemQuantityInQuotation = asyncHandler(async (req, res) => {
    const { quotationId, productId, variantId, variantName, quantity = 1 } = req.body;

    if (!quotationId || !productId || (!variantId && !variantName) || quantity <= 0) {
        throw new ApiError(400, "Invalid inputs. quotationId, productId, variantId or variantName, and positive quantity are required.");
    }

    const session = await mongoose.startSession();
    try {
        let updatedQuotation;
        await session.withTransaction(async () => {
            const quotation = await Quotation.findById(quotationId).session(session);
            if (!quotation) throw new ApiError(404, "Quotation not found.");

            if (["Booked", "Rejected", "Cancelled"].includes(quotation.status)) {
                throw new ApiError(400, `Cannot remove items from a quotation in ${quotation.status} status.`);
            }

            const itemIndex = quotation.items.findIndex(item => {
                const matchesProduct = item.productId.toString() === productId.toString();
                const matchesVariant = variantId
                    ? (item.variantId && item.variantId.toString() === variantId.toString())
                    : (item.variantName === variantName);
                return matchesProduct && matchesVariant;
            });

            if (itemIndex === -1) {
                throw new ApiError(404, "Item not found in quotation.");
            }

            const item = quotation.items[itemIndex];
            if (item.quantity < quantity) {
                throw new ApiError(400, `Cannot remove quantity (${quantity}) greater than item quantity (${item.quantity}).`);
            }

            let variant;
            if (variantId) {
                variant = await Variant.findById(variantId).session(session);
            } else if (variantName) {
                variant = await Variant.findOne({ productId, name: variantName }).session(session);
            }
            const product = await Product.findById(productId).session(session);

            // Restore stock reservation if not restored/released
            if (!quotation.reservedStockRestored && variant) {
                const variantUpdated = await Variant.findOneAndUpdate(
                    { _id: variant._id },
                    { $inc: { availableStock: quantity } },
                    { new: true, session }
                );

                if (variantUpdated) {
                    const previousAvailable = variantUpdated.availableStock - quantity;

                    // Return back to the purchase sets from where it came
                    if (item.purchaseSets && item.purchaseSets.length > 0) {
                        let remainingToRestore = quantity;
                        for (const alloc of item.purchaseSets) {
                            const take = Math.min(remainingToRestore, alloc.quantity);
                            const set = variantUpdated.purchaseSets.id(alloc.purchaseSetId);
                            if (set) {
                                set.availableStock += take;
                            }
                            alloc.quantity -= take;
                            remainingToRestore -= take;
                            if (remainingToRestore === 0) break;
                        }
                        item.purchaseSets = item.purchaseSets.filter(alloc => alloc.quantity > 0);
                    } else if (item.purchaseSetId) {
                        const set = variantUpdated.purchaseSets.id(item.purchaseSetId);
                        if (set) {
                            set.availableStock += quantity;
                        } else if (variantUpdated.purchaseSets.length > 0) {
                            variantUpdated.purchaseSets[0].availableStock += quantity;
                        }
                    } else if (variantUpdated.purchaseSets.length > 0) {
                        variantUpdated.purchaseSets[0].availableStock += quantity;
                    }

                    await variantUpdated.save({ session });
                    await syncProductStock(productId, session);

                    const parentProduct = await Product.findById(productId).session(session);
                    const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

                    // Update Inventory
                    const inventory = await Inventory.findOne({ product: productId }).session(session);
                    if (inventory) {
                        inventory.reservedStock = Math.max(0, inventory.reservedStock - quantity);
                        await inventory.save({ session });
                    }

                    // Insert Stock Log
                    const newLog = await Stock.create([{
                        quotationId: quotation.quotationId,
                        quotationRef: quotation._id,
                        type: STOCK_TYPES.REMOVE,
                        category: "virtual",
                        variantId: variantUpdated._id,
                        variantName: variantUpdated.name,
                        purchasePrice: Number(item.purchasePrice) || 0,
                        sellingPrice: Number(item.price || 0) - Number(item.discount || 0),
                        quantity,
                        previousStock: previousAvailable,
                        updatedStock: variantUpdated.availableStock,
                        previousPhysicalStock: variantUpdated.totalStock,
                        updatedPhysicalStock: variantUpdated.totalStock,
                        totalProductStock: currentTotalProductStock,
                        productId
                    }], { session });

                    if (newLog) {
                        if (!item.stockIds) {
                            item.stockIds = [];
                        }
                        item.stockIds.push(newLog[0]._id);
                    }
                }
            }

            // Update item quantity
            item.quantity -= quantity;
            if (item.quantity <= 0) {
                quotation.items.splice(itemIndex, 1);
            }

            // Recalculate totals
            await recalculateQuotationTotalsAdmin(quotation, session, true);

            await syncStockLogSellingPrices({
                items: quotation.items,
                quotationRef: quotation._id,
                session
            });

            updatedQuotation = await quotation.save({ session });

            await logActivity({
                quotationId: quotation._id,
                action: "Item Removed",
                remarks: `Removed ${quantity} of ${variantName || "item"} from quotation.`,
                req,
                session
            });
        });

        const populated = await Quotation.findById(updatedQuotation._id).populate("items.productId");
        return res.status(200).json(new ApiResponse(200, { quotation: populated }, "Item removed from quotation successfully."));
    } catch (error) {
        console.error("Error in removeItemQuantityInQuotation:", error);
        throw error;
    } finally {
        session.endSession();
    }
});

export const recordQuotationCallAttempt = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const { remarks } = req.body;

    if (!_id) {
        throw new ApiError(400, "Quotation Id is required");
    }

    const quotation = await Quotation.findById(_id);
    if (!quotation) {
        throw new ApiError(404, "Quotation not found");
    }

    const currentAttempts = quotation.callAttempts?.noOfAttempts || 0;
    if (currentAttempts >= 3) {
        throw new ApiError(400, "Maximum 3 call attempts allowed for a quotation");
    }

    const nextAttemptNo = currentAttempts + 1;

    if (!quotation.callAttempts) {
        quotation.callAttempts = { noOfAttempts: 0, history: [] };
    }

    quotation.callAttempts.noOfAttempts = nextAttemptNo;
    quotation.callAttempts.history.push({
        attemptNo: nextAttemptNo,
        date: new Date(),
        employeeId: req?.user?._id,
        remarks: remarks?.trim() || ""
    });

    await quotation.save();

    await logActivity({
        quotationId: quotation._id,
        action: "Call Attempt",
        remarks: `Call attempt #${nextAttemptNo} recorded. Remarks: "${remarks?.trim() || "N/A"}"`,
        req
    });

    const updatedQuotation = await Quotation.findById(_id)
        .populate("items.productId")
        .populate({
            path: "callAttempts.history.employeeId",
            model: "User",
            select: "name email role"
        });

    return res
        .status(200)
        .json(new ApiResponse(200, updatedQuotation, "Call attempt recorded successfully"));
});

export const getQuotationById = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    if (!_id) {
        throw new ApiError(400, "Quotation ID is required.");
    }

    const quotation = await Quotation.findById(_id)
        .populate("userId", "name phoneNo email role")
        .populate("items.productId")
        .populate({
            path: "callAttempts.history.employeeId",
            model: "User",
            select: "name email role"
        });

    if (!quotation) {
        throw new ApiError(404, "Quotation not found.");
    }

    const activityLogs = await ActivityLog.find({ quotationId: quotation._id })
        .populate("performedBy", "name email role")
        .sort({ createdAt: -1 });

    const quotationJson = quotation.toJSON();
    quotationJson.activityLogs = activityLogs || [];

    return res.status(200).json(new ApiResponse(200, quotationJson, "Quotation fetched successfully."));
});

export const updateQuotationItems =
    asyncHandler(async (req, res) => {
        const session =
            await mongoose.startSession();

        try {
            const { id } =
                req.params;

            const {
                items,
                discount,
                discountPercent,
                deliveryCharge
            } = req.body;

            if (!id) {
                throw new ApiError(
                    400,
                    "Quotation ID is required."
                );
            }

            await session.withTransaction(
                async () => {
                    const quotation =
                        await Quotation.findById(
                            id
                        ).session(
                            session
                        );

                    if (!quotation) {
                        throw new ApiError(
                            404,
                            "Quotation not found."
                        );
                    }

                    if (
                        [
                            "Booked",
                            "Rejected",
                            "Cancelled"
                        ].includes(
                            quotation.status
                        )
                    ) {
                        throw new ApiError(
                            400,
                            `Cannot edit a quotation in ${quotation.status} status.`
                        );
                    }

                    const oldItemsMap =
                        buildOldItemsMap(
                            quotation
                        );

                    const affectedProductIds =
                        new Set();

                    const seenVariantKeys =
                        new Set();

                    const pendingStockLogs =
                        [];

                    const newItems =
                        [];

                    /*
                     * =================================================
                     * PROCESS REQUESTED ITEMS
                     * =================================================
                     */
                    for (
                        const reqItem of items ||
                        []
                    ) {
                        const key =
                            validateAndGetItemKey(
                                {
                                    reqItem,
                                    seenVariantKeys
                                }
                            );

                        const qty =
                            Math.floor(
                                Number(
                                    reqItem.quantity ||
                                    0
                                )
                            );

                        /*
                         * qty === 0  → explicit deletion:
                         *   do NOT add to newItems, do NOT remove
                         *   from oldItemsMap so the deleted-items
                         *   loop below releases its stock fully.
                         * qty < 0   → invalid, skip silently.
                         */
                        if (qty === 0) {
                            seenVariantKeys.delete(key); // allow map to handle it
                            continue;
                        }

                        if (qty < 0) {
                            continue;
                        }

                        const productId =
                            reqItem.productId;

                        const variantId =
                            reqItem.variantId;

                        const variantName =
                            reqItem.variantName;

                        const oldInfo =
                            oldItemsMap.get(
                                key
                            ) || {
                                quantity: 0,
                                stockIds: [],
                                price: 0,
                                discount: 0,
                                discountPercent: 0,
                                discountType:
                                    "flat",
                                purchasePrice: 0,
                                purchaseSetId:
                                    "",
                                purchaseSets: [],
                                variantId:
                                    null
                            };

                        const finalPrice =
                            reqItem.price !==
                                undefined &&
                                reqItem.price !==
                                null
                                ? Number(
                                    reqItem.price
                                )
                                : Number(
                                    oldInfo.price ||
                                    0
                                );

                        const itemDiscount =
                            Number(
                                reqItem.discount ||
                                0
                            );

                        const itemDiscountPercent =
                            Number(
                                reqItem.discountPercent ||
                                0
                            );

                        const itemDiscountType =
                            reqItem.discountType ||
                            oldInfo.discountType ||
                            "flat";

                        const syncedDiscount =
                            syncItemDiscount(
                                itemDiscount,
                                itemDiscountPercent,
                                finalPrice,
                                itemDiscountType
                            );

                        const finalDiscount =
                            Number(
                                syncedDiscount.discount ||
                                0
                            );

                        const finalDiscountPercent =
                            Number(
                                syncedDiscount.discountPercent ||
                                0
                            );

                        const {
                            oldQuantity,
                            diff
                        } =
                            calculateItemDelta(
                                {
                                    oldInfo,
                                    quantity:
                                        qty
                                }
                            );

                        const product =
                            await Product.findById(
                                productId
                            ).session(
                                session
                            );

                        if (!product) {
                            throw new ApiError(
                                404,
                                `Product not found for ID: ${productId}`
                            );
                        }

                        let variant;

                        if (variantId) {
                            variant =
                                await Variant.findOne(
                                    {
                                        _id:
                                            variantId,
                                        active:
                                            true
                                    }
                                ).session(
                                    session
                                );
                        } else {
                            variant =
                                await Variant.findOne(
                                    {
                                        productId,
                                        name:
                                            variantName,
                                        active:
                                            true
                                    }
                                ).session(
                                    session
                                );
                        }

                        if (!variant) {
                            throw new ApiError(
                                404,
                                `Active variant "${variantName}" not found for product "${product.fullName}".`
                            );
                        }

                        let itemStockIds =
                            [
                                ...oldInfo.stockIds
                            ];

                        let allocatedSets =
                            clonePurchaseSets(
                                oldInfo.purchaseSets
                            );

                        if (allocatedSets.length === 0 && oldQuantity > 0) {
                            const fallbackSetId = oldInfo.purchaseSetId || (variant.purchaseSets[0] ? String(variant.purchaseSets[0]._id) : "");
                            if (fallbackSetId) {
                                allocatedSets = [{
                                    purchaseSetId: fallbackSetId,
                                    quantity: oldQuantity,
                                    price: Number(oldInfo.purchasePrice || 0)
                                }];
                            }
                        }

                        let selectedSetId =
                            oldInfo.purchaseSetId ||
                            "";

                        let avgPurchasePrice =
                            Number(
                                oldInfo.purchasePrice ||
                                0
                            );

                        /*
                         * ============================================
                         * INCREASE
                         * ============================================
                         */
                        if (diff > 0) {
                            const {
                                variant:
                                variantResult,
                                previousAvailableStock,
                                updatedAvailableStock
                            } =
                                await reserveVariantStock(
                                    {
                                        variantId,
                                        productId,
                                        variantName,
                                        quantity:
                                            diff,
                                        session
                                    }
                                );

                            await reserveInventoryStock(
                                {
                                    productId,
                                    quantity:
                                        diff,
                                    session
                                }
                            );

                            const allocation =
                                allocatePurchaseSets(
                                    {
                                        variant:
                                            variantResult,
                                        allocatedSets,
                                        quantity:
                                            diff,
                                        selectedSetId
                                    }
                                );

                            allocatedSets =
                                allocation.allocatedSets;

                            selectedSetId =
                                allocation.selectedSetId;

                            const incrementalPurchasePrice =
                                diff > 0
                                    ? allocation.totalCost /
                                    diff
                                    : 0;

                            avgPurchasePrice =
                                calculateWeightedPurchasePrice(
                                    {
                                        oldPurchasePrice:
                                            Number(
                                                oldInfo.purchasePrice ||
                                                0
                                            ),
                                        oldQuantity,
                                        newPurchasePrice:
                                            incrementalPurchasePrice,
                                        newQuantity:
                                            diff
                                    }
                                );

                            await savePurchaseSets(
                                {
                                    variantId:
                                        variantResult._id,
                                    purchaseSets:
                                        variantResult.purchaseSets,
                                    session
                                }
                            );

                            affectedProductIds.add(
                                String(
                                    productId
                                )
                            );

                            pendingStockLogs.push(
                                buildPendingStockLog(
                                    {
                                        quotation,
                                        variant:
                                            variantResult,
                                        productId,
                                        type:
                                            "add-item",
                                        quantity:
                                            diff,
                                        purchasePrice:
                                            incrementalPurchasePrice,
                                        previousStock:
                                            previousAvailableStock,
                                        updatedStock:
                                            updatedAvailableStock,
                                        price:
                                            finalPrice,
                                        discount:
                                            finalDiscount,
                                        itemQuantity:
                                            qty
                                    }
                                )
                            );
                        }

                        /*
                         * ============================================
                         * DECREASE
                         * ============================================
                         */
                        else if (diff < 0) {
                            const restoreQty =
                                Math.abs(
                                    diff
                                );

                            const {
                                variant:
                                variantResult,
                                previousAvailableStock,
                                updatedAvailableStock
                            } =
                                await releaseVariantStock(
                                    {
                                        variantId,
                                        productId,
                                        variantName,
                                        quantity:
                                            restoreQty,
                                        session
                                    }
                                );

                            await releaseInventoryStock(
                                {
                                    productId,
                                    quantity:
                                        restoreQty,
                                    session
                                }
                            );

                            const restoration =
                                restorePurchaseSets(
                                    {
                                        variant:
                                            variantResult,
                                        allocatedSets,
                                        quantity:
                                            restoreQty
                                    }
                                );

                            allocatedSets =
                                restoration.allocatedSets;

                            selectedSetId =
                                restoration.selectedSetId;

                            // Price of units REMAINING in quotation (for item update)
                            avgPurchasePrice =
                                restoration.purchasePrice;

                            // Price of units REMOVED (for stock log P&L)
                            const stockLogPurchasePrice =
                                restoration.restoredPurchasePrice;

                            await savePurchaseSets(
                                {
                                    variantId:
                                        variantResult._id,
                                    purchaseSets:
                                        variantResult.purchaseSets,
                                    session
                                }
                            );

                            affectedProductIds.add(
                                String(
                                    productId
                                )
                            );

                            pendingStockLogs.push(
                                buildPendingStockLog(
                                    {
                                        quotation,
                                        variant:
                                            variantResult,
                                        productId,
                                        type:
                                            "remove-item",
                                        quantity:
                                            restoreQty,
                                        purchasePrice:
                                            stockLogPurchasePrice,
                                        previousStock:
                                            previousAvailableStock,
                                        updatedStock:
                                            updatedAvailableStock,
                                        price:
                                            finalPrice,
                                        discount:
                                            finalDiscount,
                                        itemQuantity:
                                            qty
                                    }
                                )
                            );
                        }

                        /*
                         * Existing quotation item's Stock IDs are
                         * preserved. New Stock IDs will be appended
                         * after Stock insertion.
                         */
                        newItems.push({
                            productId,
                            variantName,
                            quantity: qty,
                            price: finalPrice,
                            discount:
                                finalDiscount,
                            discountPercent:
                                finalDiscountPercent,
                            discountType:
                                itemDiscountType,
                            stockIds:
                                itemStockIds,
                            purchasePrice:
                                avgPurchasePrice,
                            purchaseSetId:
                                selectedSetId,
                            purchaseSets:
                                allocatedSets.filter(
                                    set =>
                                        Number(
                                            set.quantity
                                        ) > 0
                                ),
                            variantId:
                                variant._id,
                            sku: String(
                                variant._id
                            )
                        });

                        oldItemsMap.delete(
                            key
                        );
                    }

                    /*
                     * =================================================
                     * DELETED ITEMS
                     * =================================================
                     */
                    for (
                        const [
                            key,
                            oldInfo
                        ] of oldItemsMap.entries()
                    ) {
                        const oldQty =
                            Number(
                                oldInfo.quantity ||
                                0
                            );

                        if (
                            oldQty <= 0
                        ) {
                            continue;
                        }

                        let variantQuery;

                        if (
                            oldInfo.variantId
                        ) {
                            variantQuery = {
                                _id:
                                    oldInfo.variantId,
                                active:
                                    true
                            };
                        } else {
                            const separatorIndex =
                                key.indexOf(
                                    "_"
                                );

                            if (
                                separatorIndex ===
                                -1
                            ) {
                                throw new ApiError(
                                    500,
                                    `Unable to resolve deleted quotation item "${key}".`
                                );
                            }

                            const productId =
                                key.slice(
                                    0,
                                    separatorIndex
                                );

                            const variantName =
                                key.slice(
                                    separatorIndex +
                                    1
                                );

                            variantQuery = {
                                productId,
                                name:
                                    variantName,
                                active:
                                    true
                            };
                        }

                        const variant =
                            await Variant.findOneAndUpdate(
                                variantQuery,
                                {
                                    $inc: {
                                        availableStock:
                                            oldQty
                                    }
                                },
                                {
                                    new:
                                        true,
                                    session
                                }
                            );

                        if (!variant) {
                            throw new ApiError(
                                500,
                                `Could not restore stock for deleted quotation item "${key}".`
                            );
                        }

                        const previousAvailableStock =
                            variant.availableStock -
                            oldQty;

                        await releaseInventoryStock(
                            {
                                productId:
                                    variant.productId,
                                quantity:
                                    oldQty,
                                session
                            }
                        );

                        let allocatedSets =
                            clonePurchaseSets(
                                oldInfo.purchaseSets
                            );

                        if (allocatedSets.length === 0 && oldQty > 0) {
                            const fallbackSetId = oldInfo.purchaseSetId || (variant.purchaseSets[0] ? String(variant.purchaseSets[0]._id) : "");
                            if (fallbackSetId) {
                                allocatedSets = [{
                                    purchaseSetId: fallbackSetId,
                                    quantity: oldQty,
                                    price: Number(oldInfo.purchasePrice || 0)
                                }];
                            }
                        }

                        for (const allocation of allocatedSets) {
                            const set =
                                variant.purchaseSets.find(s => String(s._id) === String(allocation.purchaseSetId));

                            if (!set) {
                                throw new ApiError(
                                    500,
                                    `Purchase set ${allocation.purchaseSetId} was not found while restoring deleted quotation item "${variant.name}".`
                                );
                            }

                            set.availableStock +=
                                Number(
                                    allocation.quantity ||
                                    0
                                );
                        }

                        await savePurchaseSets(
                            {
                                variantId:
                                    variant._id,
                                purchaseSets:
                                    variant.purchaseSets,
                                session
                            }
                        );

                        affectedProductIds.add(
                            String(
                                variant.productId
                            )
                        );

                        pendingStockLogs.push(
                            buildPendingStockLog(
                                {
                                    quotation,
                                    variant,
                                    productId:
                                        variant.productId,
                                    type:
                                        "remove-item",
                                    quantity:
                                        oldQty,
                                    purchasePrice:
                                        Number(
                                            oldInfo.purchasePrice ||
                                            0
                                        ),
                                    previousStock:
                                        previousAvailableStock,
                                    updatedStock:
                                        variant.availableStock,
                                    price:
                                        oldInfo.price,
                                    discount:
                                        oldInfo.discount,
                                    itemQuantity:
                                        oldQty
                                }
                            )
                        );
                    }

                    /*
                     * Replace quotation items.
                     */
                    quotation.items =
                        newItems;

                    /*
                     * =================================================
                     * SYNC ALL AFFECTED PRODUCTS ONCE
                     * =================================================
                     */
                    const productStockMap =
                        new Map();

                    for (
                        const productId of affectedProductIds
                    ) {
                        const result =
                            await syncProductStock2(
                                new mongoose.Types.ObjectId(
                                    productId
                                ),
                                session
                            );

                        productStockMap.set(
                            String(
                                productId
                            ),
                            result
                        );
                    }

                    /*
                     * =================================================
                     * INSERT STOCK LOGS
                     * =================================================
                     */
                    const insertedLogs =
                        await insertPendingStockLogs(
                            {
                                pendingLogs:
                                    pendingStockLogs,
                                productStockMap,
                                session
                            }
                        );

                    /*
                     * Append new Stock IDs to corresponding quotation
                     * items.
                     *
                     * Since each pending log is generated while processing
                     * the current quotation item, itemStockIdsRef can be used
                     * when needed. Existing Stock IDs remain preserved.
                     */
                    for (
                        const result of insertedLogs
                    ) {
                        if (
                            result.itemStockIdsRef
                        ) {
                            result.itemStockIdsRef.push(
                                result.log._id
                            );
                        }
                    }

                    /*
                     * At this point newItems already contains the
                     * accumulated stock IDs.
                     */
                    await syncStockLogSellingPrices(
                        {
                            items:
                                quotation.items,
                            quotationRef:
                                quotation._id,
                            session
                        }
                    );

                    /*
                     * =================================================
                     * RECALCULATE TOTALS
                     * =================================================
                     */
                    let subtotal = 0;

                    for (const item of quotation.items) {
                        const itemQty =
                            Number(
                                item.quantity ||
                                0
                            );

                        const itemPrice =
                            Number(
                                item.price ||
                                0
                            );

                        const itemDiscount =
                            Number(
                                item.discount ||
                                0
                            );

                        subtotal +=
                            itemQty *
                            (
                                itemPrice -
                                itemDiscount
                            );
                    }

                    quotation.subtotal =
                        subtotal;

                    let flatDiscount =
                        Number(
                            discount !==
                                undefined
                                ? discount
                                : quotation.discount ||
                                0
                        );

                    let percentDiscount =
                        Number(
                            discountPercent !==
                                undefined
                                ? discountPercent
                                : quotation.discountPercent ||
                                0
                        );

                    const globalDiscountType =
                        req.body
                            .discountType ||
                        quotation.discountType ||
                        "flat";

                    if (
                        subtotal > 0
                    ) {
                        if (
                            globalDiscountType ===
                            "percentage"
                        ) {
                            flatDiscount =
                                Number(
                                    (
                                        (subtotal *
                                            percentDiscount) /
                                        100
                                    ).toFixed(2)
                                );
                        } else {
                            percentDiscount =
                                Number(
                                    (
                                        (flatDiscount /
                                            subtotal) *
                                        100
                                    ).toFixed(2)
                                );
                        }
                    }

                    quotation.discount =
                        flatDiscount;

                    quotation.discountPercent =
                        percentDiscount;

                    quotation.deliveryCharge =
                        deliveryCharge !==
                            undefined
                            ? Number(
                                deliveryCharge
                            )
                            : Number(
                                quotation.deliveryCharge ||
                                0
                            );

                    quotation.orderAmount =
                        Math.max(
                            0,
                            subtotal -
                            flatDiscount +
                            quotation.deliveryCharge
                        );

                    await quotation.save(
                        {
                            session
                        }
                    );

                    await logActivity({
                        quotationId:
                            quotation._id,
                        action:
                            "Items Edited",
                        remarks:
                            "Quotation items, pricing, or quantities updated.",
                        req,
                        session
                    });
                }
            );

            const updatedQuotation =
                await Quotation.findById(
                    id
                ).populate(
                    "items.productId"
                );

            return res
                .status(200)
                .json(
                    new ApiResponse(
                        200,
                        {
                            quotation:
                                updatedQuotation
                        },
                        "Quotation items updated successfully."
                    )
                );
        } catch (error) {
            console.error(
                "Error in updateQuotationItems:",
                error
            );
            throw error;
        } finally {
            session.endSession();
        }
    });

export const getQuotationActivity = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const activityLogs = await ActivityLog.find({ quotationId: id })
        .sort({ createdAt: -1 });
    return res.status(200).json(new ApiResponse(200, activityLogs, "Quotation activity logs fetched successfully."));
});



// export const updateQuotationItems = asyncHandler(async (req, res) => {
//     const session = await mongoose.startSession();
//     try {
//         const { id } = req.params;
//         const { items, discount, discountPercent, deliveryCharge } = req.body;

//         if (!id) {
//             throw new ApiError(400, "Quotation ID is required.");
//         }

//         // Load quotation within transaction for atomic consistency
//         const quotation = await Quotation.findById(id).session(session);
//         if (!quotation) {
//             throw new ApiError(404, "Quotation not found.");
//         }
//         if (["Booked", "Rejected", "Cancelled"].includes(quotation.status)) {
//             throw new ApiError(400, `Cannot edit a quotation in ${quotation.status} status.`);
//         }
//         await session.withTransaction(async () => {
//             const oldItemsMap = new Map();
//             const affectedProductIds = new Set();
//             const seenVariantKeys = new Set();
//             for (const item of quotation.items) {
//                 const key = item.variantId ? item.variantId.toString() : `${item.productId.toString()}_${item.variantName}`;
//                 oldItemsMap.set(key, {
//                     quantity: item.quantity,
//                     stockIds: [...(item.stockIds || [])],
//                     price: item.price,
//                     discount: item.discount,
//                     purchasePrice: item.purchasePrice,
//                     purchaseSetId: item.purchaseSetId,
//                     purchaseSets: (item.purchaseSets || []).map(set => ({
//                         purchaseSetId: String(set.purchaseSetId),
//                         quantity: Number(set.quantity),
//                         price: Number(set.price)
//                     })),
//                     variantId: item.variantId
//                 });
//             }

//             const newItems = [];
//             const itemChanges = [];

//             if (items && Array.isArray(items)) {
//                 for (const reqItem of items) {
//                     // Duplicate variant detection
//                     const dupKey = reqItem.variantId ? String(reqItem.variantId) : `${reqItem.productId.toString()}_${reqItem.variantName}`;
//                     if (seenVariantKeys.has(dupKey)) {
//                         throw new ApiError(400, `Duplicate variant "${reqItem.variantName}" in quotation items.`);
//                     }
//                     seenVariantKeys.add(dupKey);

//                     const productId = reqItem.productId;
//                     const variantId = reqItem.variantId;
//                     const variantName = reqItem.variantName;
//                     const qty = Math.floor(Number(reqItem.quantity || 0));
//                     const itemDiscount = Number(reqItem.discount || 0);
//                     const itemDiscountPercent = Number(reqItem.discountPercent || 0);

//                     if (qty <= 0) continue;

//                     const key = variantId ? variantId.toString() : `${productId.toString()}_${variantName}`;
//                     const oldInfo = oldItemsMap.get(key) || { quantity: 0, stockIds: [], price: 0, discount: 0, purchasePrice: 0, purchaseSetId: "", purchaseSets: [], variantId: null };
//                     const oldQty = oldInfo.quantity;
//                     const diff = qty - oldQty;

//                     const product = await Product.findById(productId).session(session);
//                     if (!product) throw new ApiError(404, `Product not found for ID: ${productId}`);

//                     let variant;
//                     if (reqItem.variantId) {
//                         variant = await Variant.findOne({ _id: reqItem.variantId, active: true }).session(session);
//                     } else {
//                         variant = await Variant.findOne({ productId, name: variantName, active: true }).session(session);
//                     }
//                     if (!variant) throw new ApiError(404, `Active variant "${variantName}" not found for product "${product.fullName}".`);

//                     let itemStockIds = [...oldInfo.stockIds];
//                     let allocatedSets = [...oldInfo.purchaseSets];
//                     let selectedSetId = oldInfo.purchaseSetId;
//                     let avgPurchasePrice = oldInfo.purchasePrice || 0;

//                     // Adjust virtual stock reservations if quantity changed
//                     if (diff > 0) {
//                         const query = reqItem.variantId
//                             ? { _id: reqItem.variantId, active: true, availableStock: { $gte: diff } }
//                             : { productId, name: variantName, active: true, availableStock: { $gte: diff } };
//                         const variantResult = await Variant.findOneAndUpdate(
//                             query,
//                             { $inc: { availableStock: -diff } },
//                             { new: true, session }
//                         );

//                         if (!variantResult) {
//                             throw new ApiError(400, `Insufficient available stock for variant "${variantName}" of product "${product.fullName}".`);
//                         }

//                         await Inventory.findOneAndUpdate(
//                             { product: productId },
//                             { $inc: { reservedStock: diff } },
//                             { new: true, session }
//                         );

//                         // FIFO batch allocation
//                         let remaining = diff;
//                         const sortedSets = variantResult.purchaseSets
//                             .map((set, idx) => ({ set, idx }))
//                             .filter(itemObj => itemObj.set.availableStock > 0)
//                             .sort((a, b) => a.set.price - b.set.price);

//                         let totalCost = 0;
//                         for (const itemObj of sortedSets) {
//                             const set = variantResult.purchaseSets[itemObj.idx];
//                             const take = Math.min(remaining, set.availableStock);
//                             set.availableStock -= take;
//                             totalCost += take * set.price;

//                             const existingSet = allocatedSets.find(s => s.purchaseSetId === String(set._id));
//                             if (existingSet) {
//                                 existingSet.quantity += take;
//                             } else {
//                                 allocatedSets.push({
//                                     purchaseSetId: String(set._id),
//                                     quantity: take,
//                                     price: set.price
//                                 });
//                             }
//                             remaining -= take;
//                             if (!selectedSetId && take > 0) {
//                                 selectedSetId = String(set._id);
//                             }
//                             if (remaining === 0) break;
//                         }

//                         if (remaining > 0) {
//                             throw new ApiError(400, `Unable to allocate required stock from purchase sets for variant "${variantName}".`);
//                         }

//                         // Save only the purchaseSets changes, never re-write availableStock via save()
//                         await Variant.updateOne(
//                             { _id: variantResult._id },
//                             { $set: { purchaseSets: variantResult.purchaseSets } },
//                             { session }
//                         );
//                         affectedProductIds.add(String(productId));

//                         const parentProduct = await Product.findById(productId).session(session);
//                         const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

//                         // Create virtual stock log
//                         const newStockLog = await Stock.create([{
//                             quotationId: quotation.quotationId,
//                             quotationRef: quotation._id,
//                             type: "add-item", // sign: -
//                             category: "virtual",
//                             variantId: variantResult._id,
//                             variantName: variantResult.name,
//                             purchasePrice: diff > 0 ? (totalCost / diff) : 0,
//                             sellingPrice: Number(reqItem.price) - (itemDiscount / qty),
//                             quantity: diff,
//                             previousStock: variantResult.availableStock + diff,
//                             updatedStock: variantResult.availableStock,
//                             previousPhysicalStock: variantResult.totalStock,
//                             updatedPhysicalStock: variantResult.totalStock,
//                             totalProductStock: currentTotalProductStock,
//                             productId: productId
//                         }], { session });

//                         itemStockIds.push(newStockLog[0]._id);

//                     } else if (diff < 0) {
//                         const restoreQty = -diff;
//                         const query = reqItem.variantId ? { _id: reqItem.variantId } : { productId, name: variantName };
//                         const variantResult = await Variant.findOneAndUpdate(
//                             query,
//                             { $inc: { availableStock: restoreQty } },
//                             { new: true, session }
//                         );

//                         await Inventory.findOneAndUpdate(
//                             { product: productId },
//                             { $inc: { reservedStock: -restoreQty } },
//                             { new: true, session }
//                         );

//                         // FIFO batch restoration
//                         let remaining = restoreQty;
//                         for (const alloc of allocatedSets) {
//                             const set = variantResult.purchaseSets.id(alloc.purchaseSetId);
//                             if (set) {
//                                 const restoreBatch = Math.min(remaining, alloc.quantity);
//                                 set.availableStock += restoreBatch;
//                                 alloc.quantity -= restoreBatch;
//                                 remaining -= restoreBatch;
//                             }
//                             if (remaining === 0) break;
//                         }

//                         if (remaining > 0) {
//                             throw new ApiError(400, `Unable to restore required stock to purchase sets for variant "${variantName}".`);
//                         }

//                         if (!variantResult) {
//                             throw new ApiError(400, `Could not find variant to restore stock for "${variantName}".`);
//                         }

//                         // Save only the purchaseSets changes, never re-write availableStock via save()
//                         await Variant.updateOne(
//                             { _id: variantResult._id },
//                             { $set: { purchaseSets: variantResult.purchaseSets } },
//                             { session }
//                         );
//                         affectedProductIds.add(String(productId));

//                         const parentProduct = await Product.findById(productId).session(session);
//                         const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

//                         // Create virtual stock log
//                         const newStockLog = await Stock.create([{
//                             quotationId: quotation.quotationId,
//                             quotationRef: quotation._id,
//                             type: "remove-item", // sign: +
//                             category: "virtual",
//                             variantId: variantResult._id,
//                             variantName: variantResult.name,
//                             purchasePrice: variantResult.purchaseSets?.[0]?.price || 0,
//                             sellingPrice: Number(reqItem.price) - (itemDiscount / qty),
//                             quantity: restoreQty,
//                             previousStock: variantResult.availableStock - restoreQty,
//                             updatedStock: variantResult.availableStock,
//                             previousPhysicalStock: variantResult.totalStock,
//                             updatedPhysicalStock: variantResult.totalStock,
//                             totalProductStock: currentTotalProductStock,
//                             productId: productId
//                         }], { session });

//                         itemStockIds.push(newStockLog[0]._id);
//                     }

//                     // Price/discount update (recalculate sellingPrice in existing logs if price/discount changed)
//                     const finalPrice = reqItem.price !== undefined && reqItem.price !== null ? Number(reqItem.price) : oldInfo.price;
//                     const itemDiscountType = reqItem.discountType !== undefined ? reqItem.discountType : (oldInfo.discountType || "flat");
//                     const syncedDiscount = syncItemDiscount(itemDiscount, itemDiscountPercent, finalPrice, itemDiscountType);
//                     const finalDiscount = syncedDiscount.discount;
//                     const finalDiscountPercent = syncedDiscount.discountPercent;
//                     const finalUnitSellingPrice = finalPrice - finalDiscount;

//                     if (itemStockIds.length > 0) {
//                         await Stock.updateMany(
//                             { _id: { $in: itemStockIds } },
//                             { $set: { sellingPrice: finalUnitSellingPrice } },
//                             { session }
//                         );
//                     }

//                     const changes = [];
//                     if (qty !== oldQty) {
//                         changes.push(`Qty: ${oldQty} -> ${qty}`);
//                     }
//                     if (finalPrice !== oldInfo.price) {
//                         changes.push(`Price: ₹${oldInfo.price} -> ₹${finalPrice}`);
//                     }
//                     if (finalDiscount !== oldInfo.discount) {
//                         changes.push(`Discount: ₹${oldInfo.discount} -> ₹${finalDiscount}`);
//                     }
//                     if (changes.length > 0) {
//                         itemChanges.push(`${variantName} (${changes.join(", ")})`);
//                     }

//                     newItems.push({
//                         productId,
//                         variantName,
//                         quantity: qty,
//                         price: finalPrice,
//                         discount: finalDiscount,
//                         discountPercent: finalDiscountPercent,
//                         discountType: itemDiscountType,
//                         stockIds: itemStockIds,
//                         purchasePrice: avgPurchasePrice,
//                         purchaseSetId: selectedSetId,
//                         purchaseSets: allocatedSets.filter(s => s.quantity > 0),
//                         variantId: variant._id,
//                         sku: String(variant._id)
//                     });

//                     oldItemsMap.delete(key);
//                 }

//                 // Restore any completely deleted items
//                 for (const [key, oldInfo] of oldItemsMap.entries()) {
//                     const oldQty = oldInfo.quantity;

//                     // Resolve the query: prefer variantId, fall back to productId+name from composite key
//                     const variantQuery = oldInfo.variantId
//                         ? { _id: oldInfo.variantId }
//                         : (() => { const [pid, vname] = key.split("_"); return { productId: pid, name: vname }; })();

//                     const variantResult = await Variant.findOneAndUpdate(
//                         variantQuery,
//                         { $inc: { availableStock: oldQty } },
//                         { new: true, session }
//                     );

//                     if (!variantResult) {
//                         console.warn(`[updateQuotationItems] Could not find variant to restore stock for key: ${key}`);
//                         continue;
//                     }

//                     await Inventory.findOneAndUpdate(
//                         { product: variantResult.productId },
//                         { $inc: { reservedStock: -oldQty } },
//                         { new: true, session }
//                     );

//                     for (const alloc of oldInfo.purchaseSets) {
//                         const set = variantResult.purchaseSets.id(alloc.purchaseSetId);
//                         if (set) {
//                             set.availableStock += alloc.quantity;
//                         }
//                     }

//                     // Save only purchaseSets, never re-write availableStock via save()
//                     await Variant.updateOne(
//                         { _id: variantResult._id },
//                         { $set: { purchaseSets: variantResult.purchaseSets } },
//                         { session }
//                     );
//                     affectedProductIds.add(String(variantResult.productId));

//                     const parentProduct = await Product.findById(variantResult.productId).session(session);
//                     const currentTotalProductStock = parentProduct ? (parentProduct.totalProductStock || parentProduct.totalStock || 0) : 0;

//                     await Stock.create([{
//                         quotationId: quotation.quotationId,
//                         quotationRef: quotation._id,
//                         type: "remove-item", // sign: +
//                         category: "virtual",
//                         variantId: variantResult._id,
//                         variantName: variantResult.name,
//                         purchasePrice: oldInfo.purchasePrice,
//                         sellingPrice: oldInfo.price - (oldInfo.discount / oldQty),
//                         quantity: oldQty,
//                         previousStock: variantResult.availableStock - oldQty,
//                         updatedStock: variantResult.availableStock,
//                         previousPhysicalStock: variantResult.totalStock,
//                         updatedPhysicalStock: variantResult.totalStock,
//                         totalProductStock: currentTotalProductStock,
//                         productId: variantResult.productId
//                     }], { session });

//                     itemChanges.push(`Removed item ${variantResult.name || key} (Qty: ${oldQty})`);
//                 }

//                 quotation.items = newItems;

//                 // Synchronize product stock for all affected products once
//                 for (const pid of affectedProductIds) {
//                     await syncProductStock(pid, session);
//                 }
//             }

//             // Recalculate totals
//             let subtotal = 0;
//             for (const item of quotation.items) {
//                 const qty = item.quantity;
//                 const price = item.price;
//                 subtotal += qty * (price - (item.discount || 0));
//             }
//             quotation.subtotal = subtotal;

//             let flatDiscount = Number(discount !== undefined ? discount : quotation.discount);
//             let percentDiscount = Number(discountPercent !== undefined ? discountPercent : quotation.discountPercent);
//             // Use the saved discountType to decide which value is the anchor
//             const globalDiscountType = req.body.discountType || quotation.discountType || 'flat';
//             if (subtotal > 0) {
//                 if (globalDiscountType === 'percentage') {
//                     // Percentage is the anchor — recompute flat from new subtotal
//                     flatDiscount = parseFloat(((subtotal * percentDiscount) / 100).toFixed(2));
//                 } else {
//                     // Flat is the anchor — keep flat constant, recompute percent for display
//                     percentDiscount = parseFloat(((flatDiscount / subtotal) * 100).toFixed(2));
//                 }
//             }
//             quotation.discount = flatDiscount;
//             quotation.discountPercent = percentDiscount;

//             const delCharge = deliveryCharge !== undefined ? Number(deliveryCharge) : quotation.deliveryCharge;
//             quotation.deliveryCharge = delCharge;

//             quotation.orderAmount = Math.max(0, subtotal - flatDiscount + delCharge);

//             await quotation.save({ session });

//             const remarks = itemChanges.length > 0 ? `Updated items: ${itemChanges.join("; ")}` : "Quotation items, pricing, or quantities updated.";

//             await logActivity({
//                 quotationId: quotation._id,
//                 action: "Items Edited",
//                 remarks,
//                 req,
//                 session
//             });
//         });

//         const updatedQuotation = await Quotation.findById(id).populate("items.productId");
//         return res.status(200).json(new ApiResponse(200, { quotation: updatedQuotation }, "Quotation items updated successfully."));
//     } catch (error) {
//         console.error("Error in updateQuotationItems:", error);
//         throw error;
//     } finally {
//         session.endSession();
//     }
// });
