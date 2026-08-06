import mongoose from "mongoose";
import { Product } from "../models/product.model.js";
import { Variant } from "../models/variant.model.js";
import { Stock } from "../models/stock.model.js";
import { Inventory } from "../models/inventory.model.js";
import { SubCategory } from "../models/sub_category.model.js";
import { Order } from "../models/order.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Brand } from "../models/brand.model.js";
import { createStockEntry } from "../services/stock.service.js";
import { STOCK_TYPES } from "../constants.js";

const parseOptionalNumber = (val) => {
    if (val === "" || val === null || val === undefined) return null;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? null : parsed;
};

const createProduct = asyncHandler(async (req, res) => {
    let {
        name, fullName, description,
        brandId,
        price, categoryId,
        slug, active, images, tags,
        descriptionPoints,
        keyInformation,
        basePrice, regularPrice,
        sku, hsn, gst,
        rating, reviewCount,
        sellingPrice,
        discount, moq,
        webVisibility, appVisibility
    } = req.body;

    //Validate details
    if (
        !slug ||
        !fullName || !description ||
        !categoryId
    ) {
        throw new ApiError(400, "Details not found or missing category");
    }

    name = name?.trim()
    fullName = fullName.trim()
    description = description.trim()

    // Validate parent category Id
    const foundCategory = await SubCategory.findById(categoryId);
    if (!foundCategory) {
        throw new ApiError(409, `Category not found`);
    }

    if (brandId) {
        if (!mongoose.Types.ObjectId.isValid(brandId)) {
            throw new ApiError(409, `Valid brandId not found`);
        }
        const foundBrand = await Brand.findById(brandId);
        if (!foundBrand) {
            throw new ApiError(409, `Brand not found`);
        }
    }

    //create selling price and calculate min/max prices
    let sellingPriceObj;
    if (sellingPrice) {
        sellingPriceObj = typeof sellingPrice === "string" ? JSON.parse(sellingPrice) : sellingPrice;
    } else {
        sellingPriceObj = {
            type: "fixed",
            slabs: [{ quantity: 1, price: parseFloat(price) || 0 }]
        };
    }

    let minPrice = 0;
    let maxPrice = 0;
    if (sellingPriceObj.slabs && sellingPriceObj.slabs.length > 0) {
        const prices = sellingPriceObj.slabs.map(slab => slab.price);
        minPrice = Math.min(...prices);
        maxPrice = Math.max(...prices);
    }

    const ratingVal = parseOptionalNumber(rating);
    const reviewCountVal = parseOptionalNumber(reviewCount);
    const regularPriceVal = parseOptionalNumber(regularPrice);
    const basePriceVal = parseOptionalNumber(basePrice);
    const gstVal = parseOptionalNumber(gst);
    const discountVal = parseOptionalNumber(discount);
    const moqVal = parseOptionalNumber(moq);

    //create new product
    const newProduct = await Product.create({
        name, fullName, description,
        brand: brandId || null,
        tags: tags || [],
        slug,
        active: active !== undefined ? active : true,
        webVisibility: webVisibility !== undefined ? webVisibility : true,
        appVisibility: appVisibility !== undefined ? appVisibility : true,
        sellingPrice: sellingPriceObj,
        minPrice,
        maxPrice,
        category: categoryId,
        images: images ? images : [],
        keyInformation,
        descriptionPoints,
        sku: sku || null,
        hsn: hsn || null,
        gst: gstVal !== null ? gstVal : 18,
        discount: discountVal,
        basePrice: basePriceVal,
        regularPrice: regularPriceVal,
        rating: ratingVal,
        reviewCount: reviewCountVal,
        moq: moqVal !== null ? moqVal : 1
    });
    if (!newProduct) {
        throw new ApiError(409, "Could not create product");
    }

    const inventory = await Inventory.create({
        product: newProduct._id,
        physicalStock: 0,
        reservedStock: 0,
        version: 0
    });

    newProduct.inventory = inventory._id;
    await newProduct.save();

    //add the product in subCategory
    const updatedSubCategory = await SubCategory.findByIdAndUpdate(
        { _id: categoryId },
        {
            $push: {
                products: newProduct?._id
            }
        },
        { new: true }
    ).populate("parentCategory products").exec();
    console.log("Sub Category: ", updatedSubCategory);

    //return response
    return res.status(201).json(
        new ApiResponse(201, newProduct, "Product created Successfully")
    )
});

// const duplicateProduct = asyncHandler(async (req, res) => {
//     let {
//         productId,
//         name, fullName, description,
//         brandId,
//         price, categoryId,
//         slug, active, images, tags,
//         descriptionPoints,
//         keyInformation,
//         basePrice, regularPrice,
//         sku, hsn, gst,
//         rating, reviewCount
//     } = req.body;

//     if (
//         !productId || !mongoose.Types.ObjectId.isValid(productId)
//     ) {
//         throw new ApiError(400, "Valid product Id not found");
//     }

//     const foundProduct = await Product.findById(productId);
//     if (!foundProduct) {
//         throw new ApiError(409, `Product not found`);
//     }

//     //create selling price
//     let sellingPrice = [];
//     if (foundProduct?.sellingPrice) {
//         sellingPrice = [{ price: foundProduct?.sellingPrice[foundProduct?.sellingPrice?.length - 1] }]
//     }

//     //create new product
//     const newProduct = await Product.create({
//         name: `${foundProduct?.fullName}-copy`,
//         fullName: `${foundProduct?.fullName}-copy`,
//         description: foundProduct?.description,
//         brand: foundProduct?.brand,
//         tags: foundProduct?.tags || [],
//         slug: `${foundProduct?.slug}-copy`,
//         active: false,
//         sellingPrice,
//         category: foundProduct?.category,
//         images: foundProduct?.images || [],
//         keyInformation: foundProduct?.keyInformation,
//         descriptionPoints: foundProduct?.descriptionPoints,
//         hsn: foundProduct?.hsn,
//         gst: foundProduct?.gst,
//         basePrice: foundProduct?.basePrice || 0,
//         regularPrice: foundProduct?.regularPrice || 0,
//         rating, reviewCount
//     });
//     if (!newProduct) {
//         throw new ApiError(409, "Could not create product");
//     }

//     //add the product in subCategory
//     const updatedSubCategory = await SubCategory.findByIdAndUpdate(
//         { _id: categoryId },
//         {
//             $push: {
//                 products: newProduct?._id
//             }
//         },
//         { new: true }
//     ).populate("parentCategory products").exec();
//     console.log("Sub Category: ", updatedSubCategory);

//     //return response
//     return res.status(201).json(
//         new ApiResponse(201, newProduct, "Product created Successfully")
//     )
// });

// const updateProductStock = asyncHandler(async (req, res) => {
//     const {
//         vendor,
//         variantName,
//         purchasePrice,
//         quantity,
//         productId
//     } = req.body;

//     // Validate input
//     if (
//         !vendor ||
//         !variantName ||
//         !purchasePrice ||
//         !quantity ||
//         !productId
//     ) {
//         throw new ApiError(400, "Details not found");
//     }

//     const parsedQuantity = parseInt(quantity);
//     if (isNaN(parsedQuantity) || parsedQuantity < 0) {
//         throw new ApiError(400, "Quantity must be a valid number");
//     }

//     // Check if product exists
//     const existingProduct = await Product.findById(productId)
//         .populate("category stock").exec(); //populate order, group here

//     if (!existingProduct) {
//         throw new ApiError(409, "Product not found");
//     }

//     // Create new stock entry
//     const newProductStock = await Stock.create({
//         vendor,
//         variantName,
//         purchasePrice,
//         quantity,
//         productId
//     });

//     if (!newProductStock) {
//         throw new ApiError(409, "Could not create stock");
//     }

//     // Update totalStock and variant quantity
//     const currentVariantQty = existingProduct.variants.get(variantName) || 0;
//     const updatedVariantQty = currentVariantQty + parsedQuantity;
//     const updatedTotalStock = existingProduct.totalStock + parsedQuantity;


//     existingProduct.totalStock = updatedTotalStock;
//     existingProduct.variants.set(variantName, updatedVariantQty);
//     existingProduct.stock.push(newProductStock._id);

//     const updatedProduct = await Product.findByIdAndUpdate(
//         existingProduct?._id,
//         {
//             totalStock: existingProduct.totalStock,
//             variants: existingProduct.variants,
//             stock: existingProduct.stock
//         },
//         { new: true }
//     ).populate("category stock groups").exec(); //populate orders

//     return res.status(201).json(
//         new ApiResponse(201, updatedProduct, "Product stock updated successfully")
//     );
// });

// const updateProductStock = asyncHandler(async (req, res) => {
//     let {
//         vendor,
//         variantName,
//         purchasePrice,
//         quantity,
//         productId
//     } = req.body;


//     if (!variantName || quantity === undefined || !productId) {
//         throw new ApiError(400, "All stock details are required");
//     }
//     variantName = variantName.trim()

//     let stockCorrected = false;
//     if(vendor && (vendor == "zaz" || vendor == "zaz2")){
//         stockCorrected = true;
//     }

//     const parsedQuantity = parseInt(quantity);
//     if (isNaN(parsedQuantity)) {
//         throw new ApiError(400, "Quantity must be a valid number");
//     }

//     if (parsedQuantity == 0) {
//         throw new ApiError(400, "Quantity cannot be 0");
//     }

//     // Fetch product
//     const existingProduct = await Product.findById(productId)
//         .populate("category stock")
//         .exec();

//     if (!existingProduct) {
//         throw new ApiError(409, "Product not found");
//     }

//     const currentVariantQty = existingProduct.variants.get(variantName) || 0;
//     const currentTotalStock = existingProduct.totalStock || 0;

//     const updatedVariantQty = currentVariantQty + parsedQuantity;
//     const updatedTotalStock = currentTotalStock + parsedQuantity;

//     // Prevent going below zero
//     // if (updatedVariantQty < 0 || updatedTotalStock < 0) {
//     //     throw new ApiError(400, "Insufficient stock for this operation");
//     // }

//     // // Create stock entry (even for deduction)
//     // const newProductStock = await Stock.create({
//     //     type:"stock-in",
//     //     vendor,
//     //     variantName,
//     //     purchasePrice,
//     //     quantity: parsedQuantity,
//     //     previousStock: currentVariantQty,
//     //     updatedStock: updatedVariantQty,
//     //     productId
//     // });

//     // if (!newProductStock) {
//     //     throw new ApiError(500, "Could not create stock entry");
//     // }

//     const newProductStock = await createStockEntry({
//         type:STOCK_TYPES.STOCK_IN,
//         vendor,
//         variantName,
//         purchasePrice,
//         quantity: parsedQuantity,
//         previousStock: currentVariantQty,
//         updatedStock: updatedVariantQty,
//         productId
//     })

//     // console.log("New Product Stock entry received: ",newProductStock);

//     // Update product
//     existingProduct.totalStock = updatedTotalStock;
//     existingProduct.variants.set(variantName, updatedVariantQty);
//     existingProduct.stock.push(newProductStock._id);

//     const updatedProduct = await Product.findByIdAndUpdate(
//         existingProduct._id,
//         {
//             totalStock: updatedTotalStock,
//             variants: existingProduct.variants,
//             stock: existingProduct.stock,
//             stockCorrected: (vendor == "zaz" || vendor == "zaz2") ? true : (existingProduct?.stockCorrected ?? false)
//         },
//         { new: true }
//     )
//         .populate("category stock groups")
//         .exec();

//     return res.status(201).json(
//         new ApiResponse(201, updatedProduct, "Product stock updated successfully")
//     );
// });


const updateProductStock = asyncHandler(async (req, res) => {
    let {
        vendor,
        variantId,
        purchasePrice,
        quantity,
        clientVersion
    } = req.body;

    // Strict validation rule enforcement
    if (clientVersion === undefined || clientVersion === null) {
        throw new ApiError(400, "Security Validation Failed: clientVersion parameter is required to adjust inventory lines.");
    }

    if (!variantId || quantity === undefined || purchasePrice === undefined) {
        throw new ApiError(400, "All stock processing fields are required (variantId, quantity, purchasePrice)");
    }

    const parsedQuantity = parseInt(quantity);
    if (isNaN(parsedQuantity) || parsedQuantity === 0) {
        throw new ApiError(400, "Processing volume must evaluate to a valid non-zero integer");
    }

    // CRITICAL OPTIMIZATION: Validate Variant outside the heavy transaction layer
    const variant = await Variant.findById(variantId);
    if (!variant) {
        throw new ApiError(404, "Invalid Operational Scope: Targeted variant could not be found.");
    }
    const productId = variant.productId;

    const session = await mongoose.startSession();
    let updatedProduct = null;

    try {
        await session.withTransaction(async () => {

            // STEP 1: Strict Concurrency Check First (Isolated Source of Truth)
            // Defensive backfill: if inventory does not exist, initialize it first.
            let inventoryExists = await Inventory.findOne({ product: productId }).session(session);
            if (!inventoryExists) {
                await Inventory.create([{
                    product: productId,
                    physicalStock: 0,
                    reservedStock: 0,
                    version: 0
                }], { session });
            }

            const updatedInventory = await Inventory.findOneAndUpdate(
                { product: productId, version: clientVersion },
                {
                    $inc: {
                        physicalStock: parsedQuantity,
                        version: 1 // Increment checkpoint sequence line
                    }
                },
                { new: true, session }
            );

            // Fail-Fast: Abort transaction instantly if a conflict occurs
            if (!updatedInventory) {
                throw new ApiError(409, "Transaction Conflict: This inventory allocation line was updated by another process. Please refresh your view.");
            }

            // STEP 2: Evaluate Purchase Price Layer
            // Attempt to update the existing purchase set array entry atomically
            let afterVariantUpdate = await Variant.findOneAndUpdate(
                { _id: variantId, "purchaseSets.price": purchasePrice },
                {
                    $inc: {
                        "purchaseSets.$.quantity": parsedQuantity,
                        "purchaseSets.$.remainingStock": parsedQuantity,
                        totalStock: parsedQuantity
                    }
                },
                { new: true, session }
            );

            // Fallback Engine: If the purchase price layer doesn't exist yet, push a brand-new entry
            if (!afterVariantUpdate) {
                afterVariantUpdate = await Variant.findByIdAndUpdate(
                    variantId,
                    {
                        $push: {
                            purchaseSets: {
                                price: purchasePrice,
                                quantity: parsedQuantity,
                                remainingStock: parsedQuantity
                            }
                        },
                        $inc: { totalStock: parsedQuantity }
                    },
                    { new: true, session }
                );
            }

            // Safety check to intercept syntactically correct but missing runtime IDs
            if (!afterVariantUpdate) {
                throw new ApiError(404, "Data Integrity Violation: Variant manipulation baseline fell out of sync execution scopes.");
            }

            // STEP 3: Update Top-Level Storefront Product Cache
            const afterProductUpdate = await Product.findByIdAndUpdate(
                productId,
                {
                    $inc: {
                        totalStock: parsedQuantity,
                        availableStock: parsedQuantity
                    },
                    $set: { inventory: updatedInventory._id }
                },
                { new: true, session }
            );

            if (!afterProductUpdate) {
                throw new ApiError(409, "Storefront Catalog Synchronisation Failure: Operation aborted securely.");
            }

            // STEP 4: Build Variant-Level Immutable Stock Log
            const variantTotalStockAfter = afterVariantUpdate.totalStock;
            const [stockEntry] = await Stock.create([{
                type: STOCK_TYPES.STOCK_IN, // Maps to your STOCK_TYPES matrix reference schemas
                vendor,
                variantId,
                variantName: variant.name,
                purchasePrice,
                quantity: parsedQuantity,
                previousStock: variantTotalStockAfter - parsedQuantity, // Accurate variant snapshot history
                updatedStock: variantTotalStockAfter,
                productId,
                isScratchy: false
            }], { session });

            // STEP 5: Associate Log Index Reference back to parent product document
            await Product.findByIdAndUpdate(
                productId,
                { $push: { stock: stockEntry._id } },
                { session }
            );

            // STEP 6: Execute single cleanly populated readout pass for frontend application view updates
            // updatedProduct = await Product.findById(productId)
            //     // .populate("category stock groups variants")
            //     .session(session)
            //     .exec();
        });
    } catch (err) {
        throw err; // Handled cleanly by your global ApiError handling middleware
    } finally {
        session.endSession(); // Clear and release transaction thread back to pool allocation
    }

    return res.status(201).json(
        new ApiResponse(201, null, "Product stock parameters updated successfully.")
    );
});


const bulkUpdateProductStock = asyncHandler(async (req, res) => {
    let {
        vendor,
        productId,
        updates,
        clientVersion
    } = req.body;

    // Enforce explicit Optimistic Concurrency Control (OCC) tracking metrics globally
    if (clientVersion === undefined || clientVersion === null) {
        throw new ApiError(400, "Security Validation Failed: clientVersion parameter is required to perform bulk inventory mutations.");
    }

    if (!updates || !Array.isArray(updates) || updates.length === 0) {
        throw new ApiError(400, "Updates processing matrix array is required and cannot be empty.");
    }

    // --- PHASE 1: PRE-VALIDATION & AGGREGATION (Outside heavy transaction layers) ---
    let totalBulkQuantity = 0;
    const validatedUpdates = [];
    let resolvedProductId = productId;

    for (const update of updates) {
        let { variantId, quantity, purchasePrice } = update;
        console.log(variantId, quantity, purchasePrice);
        if (!variantId || quantity === undefined || purchasePrice === undefined) {
            throw new ApiError(400, "Variant identification strings, quantities, and cost brackets are required across all entries.");
        }

        const parsedQuantity = parseInt(quantity);
        if (isNaN(parsedQuantity) || parsedQuantity === 0) {
            throw new ApiError(400, "Processing volumes must evaluate to valid non-zero operational values.");
        }

        // Validate variant tracking boundaries outside transaction allocations to prevent resource choking
        const variant = await Variant.findById(variantId);
        if (!variant) {
            throw new ApiError(404, `Operational Target Missing: Variant reference row could not be located for ID: ${variantId}`);
        }

        if (!resolvedProductId) {
            resolvedProductId = variant.productId;
        } else if (resolvedProductId.toString() !== variant.productId.toString()) {
            throw new ApiError(400, "Data Integration Mismatch: Bulk updating across multiple distinct products inside a single payload is prohibited.");
        }

        totalBulkQuantity += parsedQuantity;
        validatedUpdates.push({
            variant,
            parsedQuantity,
            purchasePrice
        });
    }

    if (!resolvedProductId) {
        throw new ApiError(400, "Target Mapping Failure: Unable to calculate parent product tracking parameters cleanly.");
    }

    const session = await mongoose.startSession();
    let updatedProduct = null;

    try {
        await session.withTransaction(async () => {

            // Defensive backfill: if inventory does not exist, initialize it first.
            let inventoryExists = await Inventory.findOne({ product: resolvedProductId }).session(session);
            if (!inventoryExists) {
                await Inventory.create([{
                    product: resolvedProductId,
                    physicalStock: 0,
                    reservedStock: 0,
                    version: 0
                }], { session });
            }

            // --- PHASE 2: THE CENTRAL VERSION LOCK ENGINE ---
            // Execute exactly ONE version-check database statement utilizing the aggregate bulk calculation total. NO UPSERT.
            const updatedInventory = await Inventory.findOneAndUpdate(
                { product: resolvedProductId, version: clientVersion },
                {
                    $inc: {
                        physicalStock: totalBulkQuantity,
                        version: 1 // Single clean version progression regardless of item array size
                    }
                },
                { new: true, session }
            );

            // Fail-Fast: Abort transaction instantly if overlapping webhooks or admins touched this product row
            if (!updatedInventory) {
                throw new ApiError(409, "Bulk Transaction Conflict: The central inventory line was updated by another background process. Please refresh your data matrix view.");
            }

            const generatedStockLogIds = [];

            // --- PHASE 3: SUB-LOOP SUB-DOCUMENT MUTATIONS ---
            for (const item of validatedUpdates) {
                const { variant, parsedQuantity, purchasePrice } = item;
                const variantId = variant._id;

                // Step 1: Update target Variant cost tiers and total arrays atomically inside the safe transaction shell
                let afterVariantUpdate = await Variant.findOneAndUpdate(
                    { _id: variantId, "purchaseSets.price": purchasePrice },
                    {
                        $inc: {
                            "purchaseSets.$.quantity": parsedQuantity,
                            "purchaseSets.$.remainingStock": parsedQuantity,
                            totalStock: parsedQuantity
                        }
                    },
                    { new: true, session }
                );

                // Fallback Engine: Push a brand new purchase pricing matrix row if the layer is unique
                if (!afterVariantUpdate) {
                    afterVariantUpdate = await Variant.findByIdAndUpdate(
                        variantId,
                        {
                            $push: {
                                purchaseSets: {
                                    price: purchasePrice,
                                    quantity: parsedQuantity,
                                    remainingStock: parsedQuantity
                                }
                            },
                            $inc: { totalStock: parsedQuantity }
                        },
                        { new: true, session }
                    );
                }

                if (!afterVariantUpdate) {
                    throw new ApiError(404, `Data Integrity Fault: Variant execution array synchronization failed on row: ${variantId}`);
                }

                // Step 2: Build individual variant tracking historical log footprints
                const variantTotalStockAfter = afterVariantUpdate.totalStock;
                const [stockEntry] = await Stock.create([{
                    type: STOCK_TYPES.STOCK_IN, // Maps to your STOCK_TYPES matrix reference schemas
                    vendor,
                    variantId,
                    variantName: variant.name,
                    purchasePrice,
                    quantity: parsedQuantity,
                    previousStock: variantTotalStockAfter - parsedQuantity, // Safe individual variant history snapshot tracking
                    updatedStock: variantTotalStockAfter,
                    productId: resolvedProductId,
                    isScratchy: false
                }], { session });

                generatedStockLogIds.push(stockEntry._id);
            }

            // Step 4: Execute a single aggregate update transaction sweep to synchronize the parent Product storefront cache
            const afterProductUpdate = await Product.findByIdAndUpdate(
                resolvedProductId,
                {
                    $inc: {
                        totalStock: totalBulkQuantity,
                        availableStock: totalBulkQuantity
                    },
                    // Append all newly generated operational logs directly into the history array row inside a single operation
                    $push: { stock: { $each: generatedStockLogIds } },
                    $set: { inventory: updatedInventory._id }
                },
                { new: true, session }
            );

            if (!afterProductUpdate) {
                throw new ApiError(409, "Storefront Catalog Synchronization Failure: Operation terminated securely within pipeline scopes.");
            }

            // Step 5: Read out cleanly populated dataset matrix values for direct client response transmissions
            // updatedProduct = await Product.findById(resolvedProductId)
            //     .populate("category stock groups variants")
            //     .session(session)
            //     .exec();
        });
    } catch (err) {
        throw err; // Passed cleanly downstream into your global ApiError interceptor middleware
    } finally {
        session.endSession(); // Terminate execution context allocation footprints securely
    }

    return res.status(201).json(
        new ApiResponse(201, null, "Product variant stock arrays updated in bulk successfully.")
    );
});

const markProductChecked = asyncHandler(async (req, res) => {
    const { _id } = req.params;

    //Validations
    if (
        !_id
    ) {
        throw new ApiError(400, "Details not found");
    }

    const foundProduct = await Product.findById(_id);
    if (!foundProduct) {
        throw new ApiError(409, `Product not found`);
    }

    const updatedProduct = await Product.findByIdAndUpdate(
        { _id },
        {
            isChecked: true
        },
        { new: true }
    )
    // .populate("category stock groups variants").exec();
    if (!updatedProduct) {
        throw new ApiError(409, "Could not update product");
    }

    return res.status(200).json(
        new ApiResponse(200, updatedProduct, "Product checked Successfully")
    )
});

const getStockHistoryByProduct = asyncHandler(async (req, res) => {
    const productId = req?.params?._id;
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        throw new ApiError(400, "Valid Product Id required")
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const { variantName, type } = req.query;

    const filter = { productId };
    if (variantName && variantName !== "all") {
        filter.variantName = variantName;
    }
    if (type && type !== "all") {
        filter.type = type;
    }

    const [history, totalCount] = await Promise.all([
        Stock.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Stock.countDocuments(filter)
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    return res.status(200).json(
        new ApiResponse(200, {
            history,
            totalCount,
            pagination: {
                page,
                limit,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            }
        }, "Product stock history fetched Successfully")
    );
});

const editProduct = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const {
        name, fullName, description,
        brandId,
        tags,
        price, categoryId,
        slug, active,
        descriptionPoints,
        keyInformation, images,
        basePrice, regularPrice,
        hsn, sku, gst,
        rating, reviewCount,
        sellingPrice,
        discount, moq,
        webVisibility, appVisibility
    } = req.body;

    //Validations
    if (
        !_id
    ) {
        throw new ApiError(400, "Details not found");
    }

    const foundProduct = await Product.findById(_id);
    if (!foundProduct) {
        throw new ApiError(409, `Product not found`);
    }

    if (categoryId) {
        const foundCategory = await SubCategory.findById(categoryId);
        if (!foundCategory) {
            throw new ApiError(409, `Category not found`);
        }
    }

    if (brandId) {
        if (!mongoose.Types.ObjectId.isValid(brandId)) {
            throw new ApiError(409, `Valid brandId not found`);
        }
        const foundBrand = await Brand.findById(brandId);
        if (!foundBrand) {
            throw new ApiError(409, `Brand not found`);
        }
    }

    //create selling price and calculate min/max prices
    let sellingPriceObj = foundProduct?.sellingPrice;
    if (sellingPrice) {
        sellingPriceObj = typeof sellingPrice === "string" ? JSON.parse(sellingPrice) : sellingPrice;
    } else if (price) {
        sellingPriceObj = {
            type: "fixed",
            slabs: [{ quantity: 1, price: parseFloat(price) || 0 }]
        };
    }

    let minPrice = 0;
    let maxPrice = 0;
    if (sellingPriceObj.slabs && sellingPriceObj.slabs.length > 0) {
        const prices = sellingPriceObj.slabs.map(slab => slab.price);
        minPrice = Math.min(...prices);
        maxPrice = Math.max(...prices);
    }

    const updates = {
        name: name?.trim() || foundProduct?.name,
        fullName: fullName?.trim() || foundProduct?.fullName,
        description: description?.trim() || foundProduct?.description,
        brand: brandId ? brandId : foundProduct?.brand ? foundProduct?.brand : null,
        slug,
        hsn: hsn === "" ? null : hsn || foundProduct?.hsn,
        sku: sku === "" ? null : sku || foundProduct?.sku,
        gst: gst !== undefined ? parseOptionalNumber(gst) : foundProduct?.gst,
        discount: discount !== undefined ? parseOptionalNumber(discount) : foundProduct?.discount,
        active: active !== undefined ? active : foundProduct?.active,
        webVisibility: webVisibility !== undefined ? webVisibility : foundProduct?.webVisibility,
        appVisibility: appVisibility !== undefined ? appVisibility : foundProduct?.appVisibility,
        sellingPrice: sellingPriceObj,
        minPrice,
        maxPrice,
        descriptionPoints: descriptionPoints || foundProduct?.descriptionPoints,
        keyInformation: keyInformation || foundProduct?.keyInformation,
        basePrice: basePrice !== undefined ? parseOptionalNumber(basePrice) : foundProduct?.basePrice,
        regularPrice: regularPrice !== undefined ? parseOptionalNumber(regularPrice) : foundProduct?.regularPrice,
        category: categoryId || foundProduct?.category,
        images: images ? images : foundProduct?.images,
        tags: tags ? tags : foundProduct?.tags,
        rating: rating !== undefined ? parseOptionalNumber(rating) : foundProduct?.rating,
        reviewCount: reviewCount !== undefined ? parseOptionalNumber(reviewCount) : foundProduct?.reviewCount,
        moq: moq !== undefined ? parseOptionalNumber(moq) : foundProduct?.moq
    }

    const updatedProduct = await Product.findByIdAndUpdate(
        { _id },
        {
            ...updates
        },
        { new: true }
    ).populate("category stock groups variants").exec();
    if (!updatedProduct) {
        throw new ApiError(409, "Could not update product");
    }


    ////YET TO BE UODATED 
    // update parent category
    if (foundProduct?.category !== updatedProduct?.category?._id) {
        //Remove product in old sub category
        const oldCategory = await SubCategory.findByIdAndUpdate(
            { _id: foundProduct?.category },
            {
                $pull: {
                    products: foundProduct?._id
                }
            },
            { new: true }
        ).populate("products parentCategory").exec();
        console.log("Old Sub Category: ", oldCategory);

        //add the product in new sub category
        const newCategory = await SubCategory.findByIdAndUpdate(
            { _id: updatedProduct?.category?._id },
            {
                $push: {
                    products: updatedProduct?._id
                }
            },
            { new: true }
        )
        // .populate("products parentCategory").exec();
        console.log("New Sub Category: ", newCategory);
    }

    return res.status(200).json(
        new ApiResponse(200, updatedProduct, "Product updated Successfully")
    )
});

const updateProductStatus = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const {
        active,
    } = req.body;

    //Validations
    if (
        !_id
    ) {
        throw new ApiError(400, "Details not found");
    }

    const foundProduct = await Product.findById(_id);
    if (!foundProduct) {
        throw new ApiError(409, `Product not found`);
    }

    const updatedProduct = await Product.findByIdAndUpdate(
        { _id },
        {
            active: active != undefined ? active : foundProduct?.active
        },
        { new: true }
    )
    // .populate("category stock groups variants").exec();
    if (!updatedProduct) {
        throw new ApiError(409, "Could not update product");
    }

    return res.status(200).json(
        new ApiResponse(200, updatedProduct, "Product updated Successfully")
    )
});

const getProductBySlug = asyncHandler(async (req, res) => {
    const completeProductDetails = await Product.findOne({
        slug: req.params.slug
    }).populate("category groups variants").select("-orders -stock").exec();

    if (!completeProductDetails) {
        throw new ApiError(409, "Could not fetch product details");
    }

    return res.status(200).json(
        new ApiResponse(200, completeProductDetails, "Product details fetched Successfully")
    )
});

/*
const getProductById = asyncHandler(async (req, res) => {

    const _id = req?.params?._id;
    if (!_id || !mongoose.Types.ObjectId.isValid(_id)) {
        throw new ApiError(400, "Valid Id required")
    }

    const completeProductDetails = await Product.findById(_id)
        .populate("category stock groups")
        .populate({
            path: "orders",
            model: "Order",
            populate: {
                path: "items.productId",
                model: "Product",
                select: "name fullName images"
            }
        })
        .exec();

    if (!completeProductDetails) {
        throw new ApiError(409, "Product not found");
    }

    return res.status(200).json(
        new ApiResponse(200, completeProductDetails, "Product details fetched Successfully")
    )
});
*/

const getProductById = asyncHandler(async (req, res) => {
    const _id = req?.params?._id;
    if (!_id || !mongoose.Types.ObjectId.isValid(_id)) {
        throw new ApiError(400, "Valid Id required")
    }

    const completeProductDetails = await Product.findById(_id)
        .populate({
            path: "category",
            model: "SubCategory",
            select: "name"
        })
        .populate({
            path: "brand",
            select: "name"
        })
        .populate("variants")
        .populate("inventory")
        .select("-orders")
        .lean()
        .exec();

    if (!completeProductDetails) {
        throw new ApiError(409, "Product not found");
    }

    // Count orders per variant and status combination using countDocuments
    const variants = completeProductDetails.variants || [];
    const statuses = [
        "New", "Accepted", "Rejected", "Shipped", "Delivered",
        "Cancelled", "Returned", "Replaced", "Hold",
        "RTO Initiated", "RTO In-Transit", "RTO"
    ];

    const countPromises = [];
    const variantNames = variants.map(v => v.name);

    variantNames.forEach(variantName => {
        statuses.forEach(status => {
            countPromises.push(
                Order.countDocuments({
                    abondonedOrder: false,
                    items: {
                        $elemMatch: {
                            productId: _id,
                            variantName: variantName
                        }
                    },
                    status: status
                }).then(count => ({
                    variantName,
                    status,
                    count
                }))
            );
        });
    });

    const results = await Promise.all(countPromises);

    // Format count data into structure: [ { name: "variantName", count: { "status": qty } } ]
    const formattedCounts = variantNames.map(variantName => {
        const countMap = {};
        results.forEach(res => {
            if (res.variantName === variantName && res.count > 0) {
                countMap[res.status] = res.count;
            }
        });
        return {
            name: variantName,
            count: countMap
        };
    });

    completeProductDetails.variantOrderCounts = formattedCounts;

    return res.status(200).json(
        new ApiResponse(200, completeProductDetails, "Product details fetched Successfully")
    )
});

const getProductOrders = asyncHandler(async (req, res) => {
    const productId = req?.params?._id;
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        throw new ApiError(400, "Valid Product Id required");
    }

    const page = Math.max(1, parseInt(req?.query?.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req?.query?.limit) || 10));
    const skip = (page - 1) * limit;

    const filter = {
        "items.productId": new mongoose.Types.ObjectId(productId),
        abondonedOrder: false
    };

    const [totalCount, orders] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate({
                path: "userId",
                model: "User",
                select: "name email phoneNo orders",
                populate: {
                    path: "orders",
                    model: "Order",
                    select: "_id status"
                }
            })
            .populate({
                path: "items.productId",
                model: "Product",
                select: "name fullName"
            })
            .lean()
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    return res.status(200).json(
        new ApiResponse(200, {
            orders,
            totalCount,
            pagination: {
                page,
                limit,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            }
        }, "Product orders fetched successfully")
    );
});

// Controller: related products by slug (aggregation + populate category but exclude category.products)
const getRelatedProducts = asyncHandler(async (req, res) => {
    const { slug } = req.params;
    if (!slug) throw new ApiError(400, "Product slug is required");

    // find the product to get its category and groups
    const product = await Product.findOne({ slug })
        .select("category groups _id")
        .lean()
        .exec();

    if (!product) throw new ApiError(404, "Product not found");

    const orConditions = [];
    if (product.category) orConditions.push({ category: product.category });
    if (product.groups && product.groups.length > 0) orConditions.push({ groups: { $in: product.groups } });

    if (orConditions.length === 0) {
        return res.status(200).json(new ApiResponse(200, [], "No related products found"));
    }

    const pipeline = [
        {
            $match: {
                _id: { $ne: product._id },
                active: true,
                $or: orConditions
            }
        },
        { $sample: { size: 20 } },

        // Lookup/populate category (assumes SubCategory model -> collection name "subcategories")
        {
            $lookup: {
                from: "subcategories",          // <<-- adjust this if your collection name differs
                localField: "category",
                foreignField: "_id",
                as: "category"
            }
        },
        // unwind so category becomes an object (preserve if null)
        {
            $unwind: { path: "$category", preserveNullAndEmptyArrays: true }
        },

        // final projection: exclude fields you don't want returned AND exclude category.products
        {
            $project: {
                orders: 0,
                stock: 0,
                groups: 0,
                "category.products": 0   // remove products from populated category
            }
        },
        // sort by totalStock so out of stock items are pushed to the end
        {
            $sort: { totalStock: -1 }
        }
    ];

    const relatedProducts = await Product.aggregate(pipeline).exec();

    return res.status(200).json(
        new ApiResponse(200, relatedProducts, "Related products fetched successfully")
    );
});

const getAllProductSlugs = asyncHandler(async (req, res) => {
    const allProducts = await Product.find({ active: true })
        .select("-_id slug updatedAt").exec();

    if (!allProducts) {
        throw new ApiError(409, "Could not find products");
    }

    return res.status(200).json(
        new ApiResponse(200, allProducts, "Products Slug fetched Successfully")
    )
});

const getAllProducts = asyncHandler(async (req, res) => {
    const allProducts = await Product.find({})
        .select("-orders -stock")
        .populate("groups category variants").exec();

    if (!allProducts) {
        throw new ApiError(409, "Could not find products");
    }

    return res.status(200).json(
        new ApiResponse(200, allProducts, "Products fetched Successfully")
    )
});

const getAllActiveInstockProducts = asyncHandler(async (req, res) => {
    const allProducts = await Product.find({
        active: true, totalStock: { $gt: 0 }
    })
        .select("-orders -stock")
        .populate("groups category variants").exec();

    if (!allProducts) {
        throw new ApiError(409, "Could not find products");
    }

    return res.status(200).json(
        new ApiResponse(200, allProducts, "Products fetched Successfully")
    )
});




// New variant CRUD controllers
const createVariant = asyncHandler(async (req, res) => {
    const { productId, name, images, totalStock, webVisibility, appVisibility, active, purchaseSets } = req.body;
    if (!productId || !name) {
        throw new ApiError(400, "Product ID and Variant Name are required");
    }
    const product = await Product.findById(productId);
    if (!product) {
        throw new ApiError(404, "Product not found");
    }
    const newVariant = await Variant.create({
        productId,
        name,
        images: images || [],
        totalStock: totalStock || 0,
        webVisibility: webVisibility !== undefined ? webVisibility : true,
        appVisibility: appVisibility !== undefined ? appVisibility : true,
        active: active !== undefined ? active : true,
        purchaseSets: purchaseSets || []
    });

    // add variant reference to Product
    await Product.findByIdAndUpdate(productId, {
        $push: { variants: newVariant._id }
    });

    return res.status(201).json(new ApiResponse(201, newVariant, "Variant created successfully"));
});

const updateVariant = asyncHandler(async (req, res) => {
    const { variantId } = req.params;
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        throw new ApiError(400, "Valid Variant ID required");
    }
    const updates = req.body;
    const updatedVariant = await Variant.findByIdAndUpdate(
        variantId,
        { $set: updates },
        { new: true }
    );
    if (!updatedVariant) {
        throw new ApiError(404, "Variant not found");
    }
    return res.status(200).json(new ApiResponse(200, updatedVariant, "Variant updated successfully"));
});

const deleteVariant = asyncHandler(async (req, res) => {
    const { variantId } = req.params;
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        throw new ApiError(400, "Valid Variant ID required");
    }
    const variant = await Variant.findById(variantId);
    if (!variant) {
        throw new ApiError(404, "Variant not found");
    }

    // remove from Product
    await Product.findByIdAndUpdate(variant.productId, {
        $pull: { variants: variantId }
    });

    await Variant.findByIdAndDelete(variantId);
    return res.status(200).json(new ApiResponse(200, null, "Variant deleted successfully"));
});

// Update Product Price slabs separate API
const updateProductPrice = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const { price, sellingPrice } = req.body;

    if (!_id || !mongoose.Types.ObjectId.isValid(_id)) {
        throw new ApiError(400, "Valid Product ID required");
    }

    const product = await Product.findById(_id);
    if (!product) {
        throw new ApiError(404, "Product not found");
    }

    let sellingPriceObj;
    if (sellingPrice) {
        sellingPriceObj = typeof sellingPrice === "string" ? JSON.parse(sellingPrice) : sellingPrice;
    } else if (price) {
        sellingPriceObj = {
            type: "fixed",
            slabs: [{ quantity: 1, price: parseFloat(price) }]
        };
    } else {
        throw new ApiError(400, "Price or sellingPrice is required");
    }

    let minPrice = 0;
    let maxPrice = 0;
    if (sellingPriceObj.slabs && sellingPriceObj.slabs.length > 0) {
        const prices = sellingPriceObj.slabs.map(slab => slab.price);
        minPrice = Math.min(...prices);
        maxPrice = Math.max(...prices);
    }

    const updatedProduct = await Product.findByIdAndUpdate(
        _id,
        {
            $set: {
                sellingPrice: sellingPriceObj,
                minPrice,
                maxPrice
            }
        },
        { new: true }
    ).populate("category stock groups variants").exec();

    return res.status(200).json(new ApiResponse(200, updatedProduct, "Product price updated successfully"));
});



const markProductInGroup = asyncHandler(async (req, res) => { });
const deleteProduct = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    if (_id && mongoose.Types.ObjectId.isValid(_id)) {
        await Inventory.deleteMany({ product: _id });
    }
});
const getProductsByCategory = asyncHandler(async (req, res) => { });
const getProductsByGroup = asyncHandler(async (req, res) => { });

const getProductInventoryDetails = asyncHandler(async (req, res) => {
    const _id = req?.params?._id;
    if (!_id || !mongoose.Types.ObjectId.isValid(_id)) {
        throw new ApiError(400, "Valid ID required");
    }
    const product = await Product.findById(_id)
        .select("name fullName totalStock availableStock inventory variants")
        .populate({
            path: "variants",
            select: "name totalStock active webVisibility appVisibility"
        })
        .populate({
            path: "inventory",
            select: "physicalStock reservedStock version"
        })
        .lean()
        .exec();
    if (!product) {
        throw new ApiError(404, "Product not found");
    }
    return res.status(200).json(new ApiResponse(200, product, "Product inventory details fetched successfully"));
});

export {
    createProduct,
    updateProductStock,
    markProductChecked,
    getStockHistoryByProduct,
    editProduct,
    updateProductStatus,
    getRelatedProducts,
    getAllProductSlugs,
    getAllProducts,
    getAllActiveInstockProducts,
    getProductById,
    getProductBySlug,
    getProductOrders,
    createVariant,
    updateVariant,
    deleteVariant,
    updateProductPrice,
    markProductInGroup,
    deleteProduct, getProductsByCategory,
    getProductsByGroup,
    bulkUpdateProductStock,
    getProductInventoryDetails
}