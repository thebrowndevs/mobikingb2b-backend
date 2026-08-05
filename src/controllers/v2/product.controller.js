import mongoose from "mongoose";
import { Product } from "../../models/product.model.js";
import { Stock } from "../../models/stock.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { STOCK_TYPES } from "../../constants.js";

const updateProductStock = asyncHandler(async (req, res) => {
    let {
        vendor,
        variantName,
        purchasePrice,
        quantity,
        productId,
        isScratchy = false
    } = req.body;

    if (!variantName || quantity === undefined || !productId) {
        throw new ApiError(400, "All stock details are required");
    }

    variantName = variantName.trim();

    const parsedQuantity = parseInt(quantity);
    if (isNaN(parsedQuantity)) {
        throw new ApiError(400, "Quantity must be a valid number");
    }
    if (parsedQuantity === 0) {
        throw new ApiError(400, "Quantity cannot be 0");
    }

    const stockCorrected = vendor === "zaz";
    const stockCorrected2 = vendor === "zaz2";

    const session = await mongoose.startSession();
    let updatedProduct = null;

    try {
        await session.withTransaction(async () => {

            const existingProduct = await Product.findById(productId).select("variants scratchyVariants totalStock scratchyStock stock stockCorrected");
            if (!existingProduct) {
                throw new ApiError(409, "Product not found");
            }

            if (isScratchy) {
                if (!existingProduct.scratchyVariants || !existingProduct.scratchyVariants.has(variantName)) {
                    await Product.findByIdAndUpdate(
                        productId,
                        { $set: { [`scratchyVariants.${variantName}`]: 0 } },
                        { session }
                    );
                }
            } else {
                if (!existingProduct.variants || !existingProduct.variants.has(variantName)) {
                    await Product.findByIdAndUpdate(
                        productId,
                        { $set: { [`variants.${variantName}`]: 0 } },
                        { session }
                    );
                }
            }

            // Step 1: Atomic increment
            const updateFields = isScratchy ? {
                $inc: {
                    totalStock: parsedQuantity,
                    scratchyStock: parsedQuantity,
                    [`scratchyVariants.${variantName}`]: parsedQuantity
                },
                ...((stockCorrected || stockCorrected2) && {
                    $set: {
                        ...(stockCorrected && { stockCorrected: true, isChecked: true }),
                        ...(stockCorrected2 && { stockCorrected2: true, isChecked: true })
                    }
                })
            } : {
                $inc: {
                    totalStock: parsedQuantity,
                    [`variants.${variantName}`]: parsedQuantity
                },
                ...((stockCorrected || stockCorrected2) && {
                    $set: {
                        ...(stockCorrected && { stockCorrected: true, isChecked: true }),
                        ...(stockCorrected2 && { stockCorrected2: true, isChecked: true })
                    }
                })
            };

            const selectFields = "variants scratchyVariants totalStock scratchyStock stock stockCorrected";

            const afterUpdate = await Product.findOneAndUpdate(
                {
                    _id: productId,
                    [isScratchy ? `scratchyVariants.${variantName}` : `variants.${variantName}`]: { $exists: true }
                },
                updateFields,
                { new: true, session }
            ).select(selectFields);

            if (!afterUpdate) {
                throw new ApiError(409, "Stock update failed — product or variant not found");
            }

            // Step 2: Derive previousStock from the actual DB result
            const updatedVariantQty = isScratchy
                ? afterUpdate.scratchyVariants.get(variantName)
                : afterUpdate.variants.get(variantName);
            const previousVariantQty = updatedVariantQty - parsedQuantity;

            // Step 3: Create stock log inside the same transaction
            const [stockEntry] = await Stock.create([{
                type: STOCK_TYPES.STOCK_IN,
                vendor,
                variantName,
                purchasePrice,
                quantity: parsedQuantity,
                previousStock: previousVariantQty,
                updatedStock: updatedVariantQty,
                productId,
                isScratchy: !!isScratchy
            }], { session });

            // Step 4: Link the new stock entry to the product
            await Product.findByIdAndUpdate(
                productId,
                { $push: { stock: stockEntry._id } },
                { session }
            );

            // Step 5: Re-fetch with full population for the API response
            updatedProduct = await Product.findById(productId)
                .populate("category stock groups")
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
        updates,
        isScratchy = false
    } = req.body;

    if (!productId || !updates || !Array.isArray(updates) || updates.length === 0) {
        throw new ApiError(400, "Product ID and updates array are required");
    }

    const session = await mongoose.startSession();
    let updatedProduct = null;

    try {
        await session.withTransaction(async () => {
            const existingProduct = await Product.findById(productId).select("variants scratchyVariants totalStock scratchyStock stock stockCorrected");
            if (!existingProduct) {
                throw new ApiError(404, "Product not found");
            }

            const stockCorrected = vendor === "zaz";
            const stockCorrected2 = vendor === "zaz2";

            for (const update of updates) {
                let { variantName, quantity, purchasePrice } = update;
                if (!variantName || quantity === undefined) {
                    throw new ApiError(400, "Variant name and quantity are required for each update");
                }
                variantName = variantName.trim();
                const parsedQuantity = parseInt(quantity);
                if (isNaN(parsedQuantity) || parsedQuantity === 0) {
                    throw new ApiError(400, "Quantity must be a valid non-zero number");
                }

                if (isScratchy) {
                    if (!existingProduct.scratchyVariants || !existingProduct.scratchyVariants.has(variantName)) {
                        await Product.findByIdAndUpdate(
                            productId,
                            { $set: { [`scratchyVariants.${variantName}`]: 0 } },
                            { session }
                        );
                    }
                } else {
                    if (!existingProduct.variants || !existingProduct.variants.has(variantName)) {
                        await Product.findByIdAndUpdate(
                            productId,
                            { $set: { [`variants.${variantName}`]: 0 } },
                            { session }
                        );
                    }
                }

                const updateFields = isScratchy ? {
                    $inc: {
                        totalStock: parsedQuantity,
                        scratchyStock: parsedQuantity,
                        [`scratchyVariants.${variantName}`]: parsedQuantity
                    },
                    ...((stockCorrected || stockCorrected2) && {
                        $set: {
                            ...(stockCorrected && { stockCorrected: true, isChecked: true }),
                            ...(stockCorrected2 && { stockCorrected2: true, isChecked: true })
                        }
                    })
                } : {
                    $inc: {
                        totalStock: parsedQuantity,
                        [`variants.${variantName}`]: parsedQuantity
                    },
                    ...((stockCorrected || stockCorrected2) && {
                        $set: {
                            ...(stockCorrected && { stockCorrected: true, isChecked: true }),
                            ...(stockCorrected2 && { stockCorrected2: true, isChecked: true })
                        }
                    })
                };

                const selectFields = "variants scratchyVariants totalStock scratchyStock stock stockCorrected";

                const afterUpdate = await Product.findOneAndUpdate(
                    {
                        _id: productId,
                        [isScratchy ? `scratchyVariants.${variantName}` : `variants.${variantName}`]: { $exists: true }
                    },
                    updateFields,
                    { new: true, session }
                ).select(selectFields);

                if (!afterUpdate) {
                    throw new ApiError(409, `Stock update failed for variant "${variantName}"`);
                }

                const updatedVariantQty = isScratchy
                    ? afterUpdate.scratchyVariants.get(variantName)
                    : afterUpdate.variants.get(variantName);
                const previousVariantQty = updatedVariantQty - parsedQuantity;

                const [stockEntry] = await Stock.create([{
                    type: STOCK_TYPES.STOCK_IN,
                    vendor,
                    variantName,
                    purchasePrice,
                    quantity: parsedQuantity,
                    previousStock: previousVariantQty,
                    updatedStock: updatedVariantQty,
                    productId,
                    isScratchy: !!isScratchy
                }], { session });

                await Product.findByIdAndUpdate(
                    productId,
                    { $push: { stock: stockEntry._id } },
                    { session }
                );
            }

            updatedProduct = await Product.findById(productId)
                .populate("category stock groups")
                .session(session)
                .exec();
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
