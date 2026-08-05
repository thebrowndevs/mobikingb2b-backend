import mongoose from "mongoose";
import { Product } from "../models/product.model.js";
import { Stock } from "../models/stock.model.js";
import { SubCategory } from "../models/sub_category.model.js";
import { Order } from "../models/order.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Brand } from "../models/brand.model.js";
import { createStockEntry } from "../services/stock.service.js";
import { STOCK_TYPES } from "../constants.js";

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
        rating, reviewCount
    } = req.body;

    //TODO: Add Images to it

    //Validate details
    if (
        !slug ||
        !fullName || !description ||
        !price || !categoryId
    ) {
        throw new ApiError(400, "Details not found");
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

    //create selling price
    const sellingPrice = [{ price }]

    // let images = [];

    // if (Array.isArray(req.files?.images) && req.files.images.length > 0) {
    //     const uploadPromises = req.files.images.map(async (fl) => {
    //         const filePath = fl?.path;
    //         const image = await uploadOnCloudinary(filePath);
    //         return image;
    //     });

    //     images = await Promise.all(uploadPromises); // ✅ Wait for all uploads
    //     images = images?.map(ph => ph?.secure_url);
    // }

    //create new product
    const newProduct = await Product.create({
        name, fullName, description,
        brand: brandId,
        tags: tags || [],
        slug, active,
        sellingPrice,
        category: categoryId,
        images: images ? images : [],
        keyInformation,
        descriptionPoints,
        sku, hsn, gst,
        basePrice: basePrice || 0,
        regularPrice: regularPrice || 0,
        rating, reviewCount
    });
    if (!newProduct) {
        throw new ApiError(409, "Could not create product");
    }

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

// ✅ FIX 1: updateProductStock — product_controller.js
// REPLACE the entire function (lines 255–354) with this:

const updateProductStock = asyncHandler(async (req, res) => {
    let {
        vendor,
        variantName,
        purchasePrice,
        quantity,
        productId
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

    // if (!existingProduct.variants.has(variantName)) {
    //     throw new ApiError(404, `Variant "${variantName}" not found on this product`);
    // }

    // ── Single atomic $inc — no stale read, no overwrite ─────────────────────
    const session = await mongoose.startSession();
    let updatedProduct = null;

    try {
        await session.withTransaction(async () => {

            // ── Verify product + variant exist BEFORE touching anything ──────────────
            const existingProduct = await Product.findById(productId).select("variants totalStock stock stockCorrected");
            if (!existingProduct) {
                throw new ApiError(409, "Product not found");
            }

            if (!existingProduct.variants.has(variantName)) {
                await Product.findByIdAndUpdate(
                    productId,
                    { $set: { [`variants.${variantName}`]: 0 } },
                    { session }
                );
            }

            // Step 1: Atomic increment first — this is the source of truth
            const afterUpdate = await Product.findOneAndUpdate(
                {
                    _id: productId,
                    [`variants.${variantName}`]: { $exists: true }
                },
                {
                    $inc: {
                        totalStock: parsedQuantity,
                        [`variants.${variantName}`]: parsedQuantity
                    },
                    // ...(stockCorrected && { $set: { stockCorrected: true } })
                    ...((stockCorrected || stockCorrected2) && {
                        $set: {
                            ...(stockCorrected && { stockCorrected: true, isChecked: true }),
                            ...(stockCorrected2 && { stockCorrected2: true, isChecked: true })
                        }
                    })
                },
                { new: true, session }  // new:true → returns POST-increment values
            ).select("variants totalStock stock stockCorrected");

            if (!afterUpdate) {
                throw new ApiError(409, "Stock update failed — product or variant not found");
            }

            // Step 2: Derive previousStock from the actual DB result
            //         This is always accurate regardless of concurrent orders
            const updatedVariantQty = afterUpdate.variants.get(variantName);
            const previousVariantQty = updatedVariantQty - parsedQuantity;

            // Step 3: Create stock log inside the same transaction
            const [stockEntry] = await Stock.create([{
                type: STOCK_TYPES.STOCK_IN,
                vendor,
                variantName,
                purchasePrice,
                quantity: parsedQuantity,
                previousStock: previousVariantQty,  // accurate
                updatedStock: updatedVariantQty,     // accurate
                productId
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
    // .populate("category stock groups").exec(); //populate order, group here
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

    const { variantName, type, isScratchy } = req.query;

    const filter = { productId };
    if (variantName && variantName !== "all") {
        filter.variantName = variantName;
    }
    if (type && type !== "all") {
        filter.type = type;
    }

    if (isScratchy === "true") {
        filter.isScratchy = true;
    } else if (isScratchy === "false") {
        filter.isScratchy = { $ne: true };
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
        rating, reviewCount
    } = req.body;

    //TODO: Add Images to it

    //Validations
    if (
        !_id
        // || !slug ||
        // !name || !fullName || !description ||
        // price == undefined || price == null || !categoryId
    ) {
        throw new ApiError(400, "Details not found");
    }

    const foundProduct = await Product.findById(_id);
    if (!foundProduct) {
        throw new ApiError(409, `Product not found`);
    }

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

    //create selling price
    let sellingPrice = foundProduct?.sellingPrice[foundProduct?.sellingPrice?.length - 1];
    if (price && sellingPrice?.price !== price) {
        sellingPrice = [...foundProduct?.sellingPrice, { price }]
    } else {
        sellingPrice = foundProduct?.sellingPrice
    }

    const updates = {
        name: name?.trim() || foundProduct?.name,
        fullName: fullName?.trim() || foundProduct?.fullName,
        description: description?.trim() || foundProduct?.description,
        brand: brandId ? brandId : foundProduct?.brand ? foundProduct?.brand : null,
        slug,
        hsn, sku,
        gst,
        active: active != undefined ? active : foundProduct?.active,
        sellingPrice,
        descriptionPoints: descriptionPoints || foundProduct?.descriptionPoints,
        keyInformation: keyInformation || foundProduct?.keyInformation,
        basePrice: basePrice || foundProduct?.basePrice || 0,
        regularPrice: regularPrice || foundProduct?.regularPrice || 0,
        category: categoryId,
        images: images ? images : foundProduct?.images,
        tags: tags ? tags : foundProduct?.tags,
        rating, reviewCount
    }

    const updatedProduct = await Product.findByIdAndUpdate(
        { _id },
        {
            ...updates
        },
        { new: true }
    ).populate("category stock groups").exec(); //populate order, group here
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
        ).populate("products parentCategory").exec();
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
    ).populate("category stock groups").exec(); //populate order, group here
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
    }).populate("category groups").select("-orders -stock").exec();

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
        .select("-orders")
        .lean()
        .exec();

    if (!completeProductDetails) {
        throw new ApiError(409, "Product not found");
    }

    // Count orders per variant and status combination using countDocuments
    const variants = completeProductDetails.variants || {};
    const statuses = [
        "New", "Accepted", "Rejected", "Shipped", "Delivered",
        "Cancelled", "Returned", "Replaced", "Hold",
        "RTO Initiated", "RTO In-Transit", "RTO"
    ];

    const countPromises = [];
    const variantNames = Object.keys(variants);

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
        .populate("groups category").exec();

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
        .populate("groups category").exec();

    if (!allProducts) {
        throw new ApiError(409, "Could not find products");
    }

    return res.status(200).json(
        new ApiResponse(200, allProducts, "Products fetched Successfully")
    )
});

const markProductInGroup = asyncHandler(async (req, res) => { });
const deleteProduct = asyncHandler(async (req, res) => { });
const getProductsByCategory = asyncHandler(async (req, res) => { });
const getProductsByGroup = asyncHandler(async (req, res) => { });

export {
    createProduct,
    updateProductStock,
    markProductChecked,
    getStockHistoryByProduct,
    editProduct,
    updateProductStatus,
    markProductInGroup,
    deleteProduct,
    getRelatedProducts,
    getAllProductSlugs,
    getAllProducts,
    getAllActiveInstockProducts,
    getProductsByCategory,
    getProductsByGroup,
    getProductById,
    getProductBySlug,
    getProductOrders
}