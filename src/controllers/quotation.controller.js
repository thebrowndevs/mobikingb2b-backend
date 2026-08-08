import mongoose from "mongoose";
import { Quotation } from "../models/quotation.model.js";
import { Order } from "../models/order.model.js";
import { Cart } from "../models/cart.model.js";
import { User } from "../models/user.model.js";
import { Variant } from "../models/variant.model.js";
import { Inventory } from "../models/inventory.model.js";
import { Stock } from "../models/stock.model.js";
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
            pincode: foundAddress.pinCode || ""
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
            deliveryCharge,
            orderAmount,
            status: "New",
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

                // 1. Locate the Variant
                const variant = await Variant.findOne({ productId: item.productId._id, name: item.variantName, active: true }).session(session);
                if (!variant) {
                    throw new ApiError(404, `Variant "${item.variantName}" not found for product.`);
                }

                if (variant.totalStock < qty) {
                    throw new ApiError(400, `Insufficient stock for variant "${item.variantName}".`);
                }

                // Update Variant totalStock
                const previousStock = variant.totalStock;
                variant.totalStock -= qty;

                // FIFO allocation on purchaseSets
                let remaining = qty;
                const sortedSets = variant.purchaseSets
                    .map((set, idx) => ({ set, idx }))
                    .filter(item => item.set.remainingStock > 0)
                    .sort((a, b) => a.set.price - b.set.price);

                let selectedSetId = "";
                let totalCost = 0;

                for (const itemObj of sortedSets) {
                    const set = variant.purchaseSets[itemObj.idx];
                    const take = Math.min(remaining, set.remainingStock);
                    set.remainingStock -= take;
                    totalCost += take * set.price;
                    remaining -= take;

                    if (!selectedSetId && take > 0) {
                        selectedSetId = String(set._id);
                    }

                    if (remaining === 0) break;
                }

                const avgPurchasePrice = qty > 0 ? (totalCost / qty) : 0;

                // Sync the finalized purchase price and set ID on the Quotation items
                const quoteItem = newQuote.items.find(i => String(i.productId) === String(item.productId._id) && i.variantName === item.variantName);
                if (quoteItem) {
                    quoteItem.purchasePrice = avgPurchasePrice;
                    quoteItem.purchaseSetId = selectedSetId;
                    quoteItem.variantId = variant._id;
                    quoteItem.sku = String(variant._id);
                }

                await variant.save({ session });

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
                    previousStock,
                    updatedStock: variant.totalStock,
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

            // If moving to Cancelled / Rejected -> release reservation and restore variant stocks
            if (status === "Cancelled" || status === "Rejected") {
                for (const item of quotation.items) {
                    const qty = Math.floor(Number(item.quantity));
                    if (qty <= 0) continue;

                    // 1. Restore stock to Variant
                    const variant = await Variant.findOne({ productId: item.productId, name: item.variantName }).session(session);
                    if (variant) {
                        const previousStock = variant.totalStock;
                        variant.totalStock += qty;

                        // Add back remainingStock to the specific purchaseSet
                        if (item.purchaseSetId) {
                            const set = variant.purchaseSets.id(item.purchaseSetId);
                            if (set) {
                                set.remainingStock += qty;
                            } else {
                                // Fallback
                                if (variant.purchaseSets.length > 0) {
                                    variant.purchaseSets[0].remainingStock += qty;
                                }
                            }
                        } else {
                            if (variant.purchaseSets.length > 0) {
                                variant.purchaseSets[0].remainingStock += qty;
                            }
                        }

                        await variant.save({ session });

                        // 2. Reduce Inventory reservedStock
                        const inventory = await Inventory.findOne({ product: item.productId }).session(session);
                        if (inventory) {
                            inventory.reservedStock = Math.max(0, inventory.reservedStock - qty);
                            await inventory.save({ session });
                        }

                        // 3. Queue Stock Log (Virtual - cancelled/rejected)
                        stockEntries.push({
                            quotationId: quotation.quotationId,
                            quotationRef: quotation._id,
                            type: status === "Cancelled" ? STOCK_TYPES.CANCELLED : STOCK_TYPES.REJECTED,
                            category: "virtual",
                            variantId: variant._id,
                            variantName: variant.name,
                            purchasePrice: item.purchasePrice || 0,
                            quantity: qty,
                            previousStock,
                            updatedStock: variant.totalStock,
                            productId: item.productId
                        });
                    }
                }
            } else if (status === "Hold") {
                // Just log the virtual 'hold' change
                for (const item of quotation.items) {
                    const variant = await Variant.findOne({ productId: item.productId, name: item.variantName }).session(session);
                    stockEntries.push({
                        quotationId: quotation.quotationId,
                        quotationRef: quotation._id,
                        type: STOCK_TYPES.HOLD,
                        category: "virtual",
                        variantId: variant?._id,
                        variantName: item.variantName,
                        purchasePrice: item.purchasePrice || 0,
                        quantity: item.quantity,
                        previousStock: variant?.totalStock || 0,
                        updatedStock: variant?.totalStock || 0,
                        productId: item.productId
                    });
                }
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
            status: "New",
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
            items: quotation.items
        });

        await session.withTransaction(async () => {
            // Save the booked order
            await newOrder.save({ session });

            // Mark quotation status as Booked
            quotation.status = "Booked";
            await quotation.save({ session });

            const stockEntries = [];

            // Perform inventory physical deductions & log physical 'purchase' logs
            for (const item of quotation.items) {
                const qty = Math.floor(Number(item.quantity));
                if (qty <= 0) continue;

                // 1. Deduct physical stock & reserved stock from Inventory
                const inventory = await Inventory.findOne({ product: item.productId }).session(session);
                if (inventory) {
                    inventory.physicalStock = Math.max(0, inventory.physicalStock - qty);
                    inventory.reservedStock = Math.max(0, inventory.reservedStock - qty);
                    await inventory.save({ session });
                }

                // 2. Fetch Variant for tracking details in log
                const variant = await Variant.findOne({ productId: item.productId, name: item.variantName }).session(session);

                // 3. Queue Physical 'purchase' Stock Log
                stockEntries.push({
                    orderId: numericPart,
                    orderRef: newOrder._id,
                    quotationId: quotation.quotationId,
                    quotationRef: quotation._id,
                    type: STOCK_TYPES.PURCHASE,
                    category: "physical",
                    variantId: variant?._id,
                    variantName: item.variantName,
                    purchasePrice: item.purchasePrice || 0,
                    quantity: qty,
                    previousStock: (variant?.totalStock || 0) + qty, // totalStock was already decremented by qty at reservation
                    updatedStock: variant?.totalStock || 0,
                    productId: item.productId
                });
            }

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
