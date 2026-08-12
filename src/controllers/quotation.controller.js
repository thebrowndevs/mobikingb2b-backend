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
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { STOCK_TYPES } from "../constants.js";
import { Address } from "../models/address.model.js";

/**
 * Creates a new B2B Quotation from the user's cart.
 * Reserves stock virtually and logs virtual 'reserved' stock logs.
 */
export const createQuotation = asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    try {
        let {
            userId,
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
            orderAmount
        } = req.body;

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
            items: cart.items
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
                        productId: item.productId._id,
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

                // 2. Update Inventory (Reserved Stock)
                const inventory = await Inventory.findOne({ product: item.productId._id }).session(session);
                if (inventory) {
                    inventory.reservedStock += qty;
                    await inventory.save({ session });
                } else {
                    await Inventory.create([{
                        product: item.productId._id,
                        physicalStock: qty,
                        reservedStock: qty,
                        version: 0
                    }], { session });
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
                    quantity: qty,
                    previousStock: previousAvailableStock,
                    updatedStock: variant.availableStock,
                    previousPhysicalStock: variant.totalStock,
                    updatedPhysicalStock: variant.totalStock,
                    totalProductStock: currentTotalProductStock,
                    productId: item.productId._id
                });
            }

            // Save Quotation item updates
            await newQuote.save({ session });

            // Write Stock logs
            if (stockEntries.length > 0) {
                await Stock.insertMany(stockEntries, { session });
            }

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

                    const variant = await Variant.findOneAndUpdate(
                        { _id: item.variantId },
                        { $inc: { availableStock: qty } },
                        { new: true, session }
                    );

                    if (variant) {
                        const previousAvailable = variant.availableStock - qty;

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

                    const variant = await Variant.findOneAndUpdate(
                        {
                            _id: item.variantId,
                            availableStock: { $gte: qty }
                        },
                        { $inc: { availableStock: -qty } },
                        { new: true, session }
                    );

                    if (!variant) {
                        throw new ApiError(400, `Insufficient available stock to re-reserve variant "${item.variantName}".`);
                    }

                    const previousAvailable = variant.availableStock + qty;

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
                const paymentsToCreate = req.body.stages.map(stg => ({
                    orderId: newOrder._id,
                    amount: Number(stg.amount),
                    method: stg.method,
                    status: stg.status || "Pending",
                    notes: stg.notes || "",
                    paidAt: stg.status === "Paid" ? new Date() : undefined
                }));
                await Payment.insertMany(paymentsToCreate, { session });

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

            // Add order to user's orders list
            await User.findByIdAndUpdate(
                quotation.userId,
                { $push: { orders: newOrder._id } },
                { session }
            );

            const stockEntries = [];

            // Perform inventory physical deductions & log physical 'purchase' logs
            for (const item of quotation.items) {
                const qty = Math.floor(Number(item.quantity));
                if (qty <= 0) continue;

                // 1. Atomically decrement variant stock levels first
                const updateInc = { totalStock: -qty };
                if (quotation.reservedStockRestored) {
                    updateInc.availableStock = -qty;
                }

                const variant = await Variant.findOneAndUpdate(
                    { _id: item.variantId },
                    { $inc: updateInc },
                    { new: true, session }
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

            // Save updated order and quotation items
            await newOrder.save({ session });
            await quotation.save({ session });

            if (stockEntries.length > 0) {
                await Stock.insertMany(stockEntries, { session });
            }
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

const determineSlabForQuantity = (product, quantity) => {
    if (!product.sellingPrice) return null;
    if (product.sellingPrice.type === "fixed") {
        if (product.sellingPrice.slabs && product.sellingPrice.slabs.length > 0) {
            return { quantity: product.sellingPrice.slabs[0].quantity, price: product.sellingPrice.slabs[0].price };
        }
        return { quantity: 1, price: product.basePrice || 0 };
    }

    const slabs = product.sellingPrice.slabs || [];
    if (slabs.length === 0) return { quantity: 1, price: product.basePrice || 0 };

    const sortedSlabs = [...slabs].sort((a, b) => a.quantity - b.quantity);

    let matchedSlab = sortedSlabs[0];
    for (const slab of sortedSlabs) {
        if (quantity >= slab.quantity) {
            matchedSlab = slab;
        } else {
            break;
        }
    }
    return { quantity: matchedSlab.quantity, price: matchedSlab.price };
};

const recalculateQuotationTotals = async (quotation, session, keepReceivedPrices = false, keepDeliveryCharge = false) => {
    let subtotal = 0;
    const categoryCharges = new Map();

    // Group items by productId to find total product quantity
    const productQuantities = new Map();
    for (const item of quotation.items) {
        const prodIdStr = item.productId.toString();
        productQuantities.set(prodIdStr, (productQuantities.get(prodIdStr) || 0) + item.quantity);
    }

    // Now recalculate pricing for each item
    for (const item of quotation.items) {
        const product = await Product.findById(item.productId)
            .session(session)
            .populate("category")
            .exec();

        if (!product) {
            throw new ApiError(404, `Product not found for item: ${item.productId}`);
        }

        const totalProductQty = productQuantities.get(item.productId.toString()) || item.quantity;
        const matchedSlab = determineSlabForQuantity(product, totalProductQty);

        let basePrice = 0;
        if (matchedSlab) {
            const currentAppliedSlabQty = item.appliedSlab ? item.appliedSlab.quantity : null;
            if (currentAppliedSlabQty === matchedSlab.quantity && item.appliedSlab.price !== undefined) {
                basePrice = item.appliedSlab.price;
            } else {
                item.appliedSlab = {
                    quantity: matchedSlab.quantity,
                    price: matchedSlab.price
                };
                basePrice = matchedSlab.price;
            }
        } else {
            basePrice = item.appliedSlab ? item.appliedSlab.price : (product.sellingPrice?.slabs?.[0]?.price || product.basePrice || 0);
        }

        // Sync item discount and discountPercent
        let itemFlat = Number(item.discount || 0);
        let itemPercent = Number(item.discountPercent || 0);

        if (basePrice > 0) {
            if (itemPercent > 0 && itemFlat === 0) {
                itemFlat = parseFloat(((basePrice * itemPercent) / 100).toFixed(2));
            } else if (itemFlat > 0 && itemPercent === 0) {
                itemPercent = parseFloat(((itemFlat / basePrice) * 100).toFixed(2));
            } else if (itemFlat > 0 && itemPercent > 0) {
                itemPercent = parseFloat(((itemFlat / basePrice) * 100).toFixed(2));
            }
        }

        item.discount = parseFloat(itemFlat.toFixed(2));
        item.discountPercent = parseFloat(itemPercent.toFixed(2));

        if (keepReceivedPrices && item.price !== undefined && item.price !== null && item.price > 0 && itemFlat === 0 && itemPercent === 0) {
            // Keep the per-item price same as received if no discount update is requested
        } else {
            item.price = Math.max(0, basePrice - item.discount);
        }

        subtotal += item.price * item.quantity;

        // Delivery Charge calculation (max delivery charge of all item categories)
        if (product.category) {
            const categoryId = product.category._id.toString();
            const deliveryCharge = product.category.deliveryCharge || 0;
            if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
                categoryCharges.set(categoryId, deliveryCharge);
            }
        }
    }

    if (!keepDeliveryCharge) {
        const values = Array.from(categoryCharges.values());
        const totalDeliveryCharge = Math.max(...values, 0);
        quotation.deliveryCharge = parseFloat(totalDeliveryCharge.toFixed(2));
    } else {
        quotation.deliveryCharge = parseFloat((quotation.deliveryCharge || 0).toFixed(2));
    }

    const subtotalFixed = parseFloat(subtotal.toFixed(2));
    quotation.subtotal = subtotalFixed;

    // Auto-sync discount and discountPercent
    let flatDiscount = Number(quotation.discount || 0);
    let percentDiscount = Number(quotation.discountPercent || 0);

    if (percentDiscount > 0 && flatDiscount === 0) {
        flatDiscount = parseFloat(((subtotalFixed * percentDiscount) / 100).toFixed(2));
    } else if (flatDiscount > 0 && percentDiscount === 0) {
        percentDiscount = subtotalFixed > 0 ? parseFloat(((flatDiscount / subtotalFixed) * 100).toFixed(2)) : 0;
    } else if (flatDiscount > 0 && percentDiscount > 0) {
        percentDiscount = subtotalFixed > 0 ? parseFloat(((flatDiscount / subtotalFixed) * 100).toFixed(2)) : 0;
    }

    quotation.discount = parseFloat(flatDiscount.toFixed(2));
    quotation.discountPercent = parseFloat(percentDiscount.toFixed(2));
    quotation.orderAmount = parseFloat((Math.max(0, subtotalFixed - quotation.discount) + quotation.deliveryCharge).toFixed(2));
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

        const quotation = await Quotation.findById(quotationId);
        if (!quotation) {
            throw new ApiError(404, "Quotation not found.");
        }

        if (quotation.status === "Booked") {
            throw new ApiError(400, "Cannot edit a booked quotation.");
        }

        await session.withTransaction(async () => {
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
                    let selectedSetId = "";
                    let avgPurchasePrice = 0;
                    const allocatedSets = [];

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

                    const oldItem = quotation.items.find(it => it.productId.toString() === productId.toString() && it.variantName === variantName);
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

                quotation.items = newItems;

                if (stockEntries.length > 0) {
                    await Stock.insertMany(stockEntries, { session });
                }
            }

            await recalculateQuotationTotals(quotation, session, true, deliveryCharge !== undefined);
            await quotation.save({ session });
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

            let selectedSetId = "";
            let avgPurchasePrice = 0;
            const allocatedSets = [];

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

                // Insert Stock Log
                await Stock.create([{
                    quotationId: quotation.quotationId,
                    quotationRef: quotation._id,
                    type: STOCK_TYPES.ADD,
                    category: "virtual",
                    variantId: variant._id,
                    variantName: variant.name,
                    purchasePrice: Number(avgPurchasePrice) || 0,
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

            // Find or push item
            const existingItem = quotation.items.find(item => {
                const matchesProduct = item.productId.toString() === productId.toString();
                const matchesVariant = variantId
                    ? (item.variantId && item.variantId.toString() === variantId.toString())
                    : (item.variantName === variant.name);
                return matchesProduct && matchesVariant;
            });

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
            } else {
                quotation.items.push({
                    productId,
                    variantName: variant.name,
                    quantity,
                    price: 0, // recalculateQuotationTotals will compute this
                    purchasePrice: avgPurchasePrice,
                    purchaseSetId: selectedSetId,
                    purchaseSets: allocatedSets,
                    variantId: variant._id,
                    sku: String(variant._id),
                    discount: 0
                });
            }

            // Recalculate totals
            await recalculateQuotationTotals(quotation, session, true);

            updatedQuotation = await quotation.save({ session });
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
                    await Stock.create([{
                        quotationId: quotation.quotationId,
                        quotationRef: quotation._id,
                        type: STOCK_TYPES.REMOVE,
                        category: "virtual",
                        variantId: variantUpdated._id,
                        variantName: variantUpdated.name,
                        purchasePrice: Number(item.purchasePrice) || 0,
                        quantity,
                        previousStock: previousAvailable,
                        updatedStock: variantUpdated.availableStock,
                        previousPhysicalStock: variantUpdated.totalStock,
                        updatedPhysicalStock: variantUpdated.totalStock,
                        totalProductStock: currentTotalProductStock,
                        productId
                    }], { session });
                }
            }

            // Update item quantity
            item.quantity -= quantity;
            if (item.quantity <= 0) {
                quotation.items.splice(itemIndex, 1);
            }

            // Recalculate totals
            await recalculateQuotationTotals(quotation, session, true);

            updatedQuotation = await quotation.save({ session });
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
