import mongoose from "mongoose";
import { Product } from "../../models/product.model.js";
import { Variant } from "../../models/variant.model.js";
import { Stock } from "../../models/stock.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { STOCK_TYPES } from "../../constants.js";

const updateProductStock = asyncHandler(async (req, res) => {
    let {
        vendor,
        variantId,
        purchasePrice,
        sellingPrice,
        quantity
    } = req.body;

    if (!variantId || quantity === undefined || purchasePrice === undefined || sellingPrice === undefined) {
        throw new ApiError(400, "All stock details are required (variantId, quantity, purchasePrice, sellingPrice)");
    }

    const parsedQuantity = parseInt(quantity);
    if (isNaN(parsedQuantity) || parsedQuantity === 0) {
        throw new ApiError(400, "Quantity must be a valid non-zero number");
    }

    const stockCorrected = vendor === "zaz";
    const stockCorrected2 = vendor === "zaz2";

    const session = await mongoose.startSession();
    let updatedProduct = null;

    try {
        await session.withTransaction(async () => {
            const variant = await Variant.findById(variantId).session(session);
            if (!variant) {
                throw new ApiError(404, "Variant not found");
            }

            const productId = variant.productId;

            // Step 1: Update Variant purchaseSets and totalStock
            const existingSet = variant.purchaseSets.find(set => set.price === purchasePrice);
            if (existingSet) {
                existingSet.quantity += parsedQuantity;
                existingSet.remainingStock += parsedQuantity;
            } else {
                variant.purchaseSets.push({
                    price: purchasePrice,
                    quantity: parsedQuantity,
                    remainingStock: parsedQuantity
                });
            }
            variant.totalStock += parsedQuantity;
            await variant.save({ session });

            // Step 2: Update Product totalStock
            const productUpdate = {
                $inc: { totalStock: parsedQuantity }
            };
            if (stockCorrected || stockCorrected2) {
                productUpdate.$set = {
                    ...(stockCorrected && { stockCorrected: true, isChecked: true }),
                    ...(stockCorrected2 && { stockCorrected2: true, isChecked: true })
                };
            }

            const afterProductUpdate = await Product.findByIdAndUpdate(
                productId,
                productUpdate,
                { new: true, session }
            );

            if (!afterProductUpdate) {
                throw new ApiError(409, "Product update failed");
            }

            // Step 3: Create stock log
            const [stockEntry] = await Stock.create([{
                type: STOCK_TYPES.STOCK_IN,
                vendor,
                variantId,
                variantName: variant.name,
                purchasePrice,
                sellingPrice,
                quantity: parsedQuantity,
                previousStock: variant.totalStock - parsedQuantity,
                updatedStock: variant.totalStock,
                productId,
                isScratchy: false
            }], { session });

            // Step 4: Link stock entry to product
            await Product.findByIdAndUpdate(
                productId,
                { $push: { stock: stockEntry._id } },
                { session }
            );

            // Step 5: Re-fetch populated product for API response
            updatedProduct = await Product.findById(productId)
                .populate("category stock groups variants")
                .session(session)
                .exec();
        });
    } catch (err) {
        throw err;
    } finally {
        session.endSession();
    }

    return res.status(201).json(
        new ApiResponse(201, updatedProduct, "Product stock updated successfully")
    );
});

const bulkUpdateProductStock = asyncHandler(async (req, res) => {
    let {
        vendor,
        productId,
        updates
    } = req.body;

    if (!updates || !Array.isArray(updates) || updates.length === 0) {
        throw new ApiError(400, "Updates array is required");
    }

    const session = await mongoose.startSession();
    let updatedProduct = null;

    try {
        await session.withTransaction(async () => {
            const stockCorrected = vendor === "zaz";
            const stockCorrected2 = vendor === "zaz2";

            let resolvedProductId = productId;

            for (const update of updates) {
                let { variantId, quantity, purchasePrice, sellingPrice } = update;
                if (!variantId || quantity === undefined || purchasePrice === undefined || sellingPrice === undefined) {
                    throw new ApiError(400, "Variant ID, quantity, purchasePrice, and sellingPrice are required for each update");
                }

                const parsedQuantity = parseInt(quantity);
                if (isNaN(parsedQuantity) || parsedQuantity === 0) {
                    throw new ApiError(400, "Quantity must be a valid non-zero number");
                }

                const variant = await Variant.findById(variantId).session(session);
                if (!variant) {
                    throw new ApiError(404, `Variant not found for ID: ${variantId}`);
                }

                if (!resolvedProductId) {
                    resolvedProductId = variant.productId;
                }

                // Step 1: Update Variant purchaseSets and totalStock
                const existingSet = variant.purchaseSets.find(set => set.price === purchasePrice);
                if (existingSet) {
                    existingSet.quantity += parsedQuantity;
                    existingSet.remainingStock += parsedQuantity;
                } else {
                    variant.purchaseSets.push({
                        price: purchasePrice,
                        quantity: parsedQuantity,
                        remainingStock: parsedQuantity
                    });
                }
                variant.totalStock += parsedQuantity;
                await variant.save({ session });

                // Step 2: Update Product totalStock
                const productUpdate = {
                    $inc: { totalStock: parsedQuantity }
                };
                if (stockCorrected || stockCorrected2) {
                    productUpdate.$set = {
                        ...(stockCorrected && { stockCorrected: true, isChecked: true }),
                        ...(stockCorrected2 && { stockCorrected2: true, isChecked: true })
                    };
                }

                const afterProductUpdate = await Product.findByIdAndUpdate(
                    variant.productId,
                    productUpdate,
                    { new: true, session }
                );

                if (!afterProductUpdate) {
                    throw new ApiError(409, `Product update failed for variant ID: ${variantId}`);
                }

                // Step 3: Create stock log
                const [stockEntry] = await Stock.create([{
                    type: STOCK_TYPES.STOCK_IN,
                    vendor,
                    variantId,
                    variantName: variant.name,
                    purchasePrice,
                    sellingPrice,
                    quantity: parsedQuantity,
                    previousStock: variant.totalStock - parsedQuantity,
                    updatedStock: variant.totalStock,
                    productId: variant.productId,
                    isScratchy: false
                }], { session });

                // Step 4: Link stock entry to product
                await Product.findByIdAndUpdate(
                    variant.productId,
                    { $push: { stock: stockEntry._id } },
                    { session }
                );
            }

            if (resolvedProductId) {
                updatedProduct = await Product.findById(resolvedProductId)
                    .populate("category stock groups variants")
                    .session(session)
                    .exec();
            }
        });
    } catch (err) {
        throw err;
    } finally {
        session.endSession();
    }

    return res.status(201).json(
        new ApiResponse(201, updatedProduct, "Product stock updated in bulk successfully")
    );
});

export {
    updateProductStock,
    bulkUpdateProductStock
};
