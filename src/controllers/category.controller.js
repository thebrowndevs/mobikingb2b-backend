import { Category } from "../models/category.model.js";
import { SubCategory } from "../models/sub_category.model.js";
import { Product } from "../models/product.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import mongoose from "mongoose";

//Parent Ctegory
const createCategory = asyncHandler(async (req, res) => {
    const { name, slug, active, image } = req.body;

    if (!name || !slug) {
        throw new ApiError(400, "Details not found");
    }

    // const imageLocalPath = req.files?.image[0]?.path;

    // if (!imageLocalPath) {
    //     throw new ApiError(400, "Image is required")
    // }
    // const image = await uploadOnCloudinary(imageLocalPath)
    // if (!image) {
    //     throw new ApiError(400, "Image is required")
    // }

    const newCategory = await Category.create({
        name,
        slug,
        image: image ? image : "",
        active
    });

    if (!newCategory) {
        throw new ApiError(409, "Could not create category");
    }

    return res.status(201).json(
        new ApiResponse(201, newCategory, "Category created Successfully")
    )
});

const editCategory = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const { name, slug, active, image } = req.body;

    if (!_id || !name || !slug) {
        throw new ApiError(400, "Details not found");
    }

    const foundCategory = await Category.findById(_id);
    if (!foundCategory) {
        throw new ApiError(409, `Category not found`);
    }

    const updatedCategory = await Category.findByIdAndUpdate(
        { _id },
        {
            name,
            slug,
            active,
            image: image ? image : foundCategory?.image
        },
        { new: true }
    ).populate("subCategories")
        .exec();

    if (!updatedCategory) {
        throw new ApiError(409, "Could not update category");
    }

    return res.status(200).json(
        new ApiResponse(200, updatedCategory, "Category updated Successfully")
    )
});

const deleteCategory = asyncHandler(async (req, res) => {
    const { _id } = req.params;

    if (!_id) {
        throw new ApiError(400, "Details not found");
    }

    const foundCategory = await Category.findById(_id);
    if (!foundCategory) {
        throw new ApiError(409, `Category not found`);
    }

    const deletedCategory = await Category.findByIdAndDelete(_id);

    if (!deletedCategory) {
        throw new ApiError(409, "Could not delete category");
    }

    return res.status(200).json(
        new ApiResponse(200, deletedCategory, "Category deleted Successfully")
    )
});

const getAllCategorySlugs = asyncHandler(async (req, res) => {
    const allCategories = await Category.find({ active: true })
        .select("-_id slug updatedAt").exec();

    if (!allCategories) {
        throw new ApiError(409, "Could not find categories");
    }

    return res.status(200).json(
        new ApiResponse(200, allCategories, "Category slugs fetched Successfully")
    )
});

const getAllCategories = asyncHandler(async (req, res) => {
    const { searchQuery, search } = req.query;
    let { page, limit } = req.query;
    const query = searchQuery || search;
    const filter = {};

    if (query && query.trim()) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        const regexArray = words.map(word => new RegExp(word, "i"));

        filter.$or = [
            { $and: regexArray.map(r => ({ name: r })) },
            { $and: regexArray.map(r => ({ slug: r })) }
        ];
    }

    if (page !== undefined && limit !== undefined) {
        page = parseInt(page, 10) || 1;
        limit = parseInt(limit, 10) || 10;
        const skip = (page - 1) * limit;

        const totalCategories = await Category.countDocuments(filter);
        const totalPages = Math.ceil(totalCategories / limit);

        const categories = await Category.find(filter)
            .populate({
                path: "subCategories",
                model: "SubCategory",
                select: "-products"
            })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .exec();

        return res.status(200).json(
            new ApiResponse(200, {
                categories,
                pagination: {
                    totalCategories,
                    totalPages,
                    currentPage: page,
                    limit,
                    hasMore: page < totalPages
                }
            }, "Categories fetched Successfully")
        );
    } else {
        const allCategories = await Category.find(filter).populate({
            path: "subCategories",
            model: "SubCategory",
            select: "-products"
        }).sort({ createdAt: -1 }).exec();

        if (!allCategories) {
            throw new ApiError(409, "Could not find categories");
        }

        return res.status(200).json(
            new ApiResponse(200, allCategories, "Categories fetched Successfully")
        );
    }
});

const getCategoryById = asyncHandler(async (req, res) => {
    const completeCatgeoryDetails = await Category.findById(req?.params?._id).populate("subCategories").exec();

    if (!completeCatgeoryDetails) {
        throw new ApiError(409, "Could not fetch category details");
    }

    return res.status(200).json(
        new ApiResponse(200, completeCatgeoryDetails, "Category details fetched Successfully")
    )
});

const getCategoryBySlug = asyncHandler(async (req, res) => {
    const completeCatgeoryDetails = await Category.findOne({
        slug: req?.params?.slug
    }).populate("subCategories").exec();

    if (!completeCatgeoryDetails) {
        throw new ApiError(409, "Could not fetch category details");
    }

    return res.status(200).json(
        new ApiResponse(200, completeCatgeoryDetails, "Category details fetched Successfully")
    )
});


//Sub categories
const createSubCategory = asyncHandler(async (req, res) => {
    const {
        name, slug, active,
        sequenceNo, featured,
        deliveryCharge,
        minOrderAmount,
        minFreeDeliveryOrderAmount,
        categoryId,
        icon,
        theme,
        upperBanner,
        lowerBanner,
        photos, tags
    } = req.body;

    //Todo: Add Images, upper, lower banner in the subcategories

    if (!name || !slug ||
        // !sequenceNo || 
        !categoryId) {
        throw new ApiError(400, "Details not found");
    }

    // Validate parent category Id
    const foundCategory = await Category.findById(categoryId);
    if (!foundCategory) {
        throw new ApiError(409, `Parent category not found`);
    }

    // const upperBannerLocalPath = req.files?.upperBanner[0]?.path;
    // const lowerBannerLocalPath = req.files?.lowerBanner[0]?.path;

    // if (!upperBannerLocalPath || !lowerBannerLocalPath) {
    //     throw new ApiError(400, "Avatar file is required")
    // }

    // const upperBanner = await uploadOnCloudinary(upperBannerLocalPath)
    // const lowerBanner = await uploadOnCloudinary(lowerBannerLocalPath)
    // // console.log(photosLocalPath);

    // let photos = [];

    // if (Array.isArray(req.files?.photos) && req.files.photos.length > 0) {
    //     const uploadPromises = req.files.photos.map(async (fl) => {
    //         const filePath = fl?.path;
    //         const photo = await uploadOnCloudinary(filePath);
    //         return photo;
    //     });

    //     photos = await Promise.all(uploadPromises); // ✅ Wait for all uploads
    //     photos = photos?.map(ph => ph?.secure_url);
    // }

    // if (!upperBanner || !lowerBanner) {
    //     throw new ApiError(400, "Upper and lower banners are required")
    // }

    const newSubCategory = await SubCategory.create({
        name, slug, active,
        sequenceNo: sequenceNo || 0, featured,
        icon,
        theme,
        upperBanner: upperBanner ? upperBanner : "",
        lowerBanner: lowerBanner ? lowerBanner : "",
        photos: photos ? photos : [],
        tags: tags || [],
        deliveryCharge,
        minOrderAmount,
        minFreeDeliveryOrderAmount,
        parentCategory: categoryId
    });

    if (!newSubCategory) {
        throw new ApiError(409, "Could not create sub category");
    }

    //add the subCategory in parent category
    const updatedCategory = await Category.findByIdAndUpdate(
        { _id: categoryId },
        {
            $push: {
                subCategories: newSubCategory?._id
            }
        },
        { new: true }
    ).populate("subCategories").exec();
    console.log("Parent Category: ", updatedCategory);

    return res.status(201).json(
        new ApiResponse(201, newSubCategory, "Sub category created Successfully")
    )
});

const editSubCategory = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const {
        name, slug, active,
        sequenceNo, featured,
        deliveryCharge,
        minOrderAmount,
        minFreeDeliveryOrderAmount,
        categoryId,
        icon,
        theme,
        upperBanner,
        lowerBanner,
        photos,
        tags
    } = req.body;

    //Todo: Add Images, upper, lower banner in the subcategories

    if (!_id || !name || !slug ||
        // !sequenceNo || 
        !categoryId) {
        throw new ApiError(400, "Details not found");
    }

    // Validate parent category Id
    const foundCategory = await Category.findById(categoryId);
    if (!foundCategory) {
        throw new ApiError(409, `Parent category not found`);
    }

    // Validate sub category Id
    const foundSubCategory = await SubCategory.findById(_id);
    if (!foundSubCategory) {
        throw new ApiError(409, `Sub category not found`);
    }

    const updatedSubCategory = await SubCategory.findByIdAndUpdate(
        { _id },
        {
            name, slug, active,
            sequenceNo: sequenceNo || foundSubCategory?.sequenceNo || 0,
            featured,
            deliveryCharge,
            minOrderAmount,
            minFreeDeliveryOrderAmount,
            parentCategory: categoryId,
            icon: icon ? icon : foundSubCategory?.icon,
            theme: theme || foundSubCategory?.theme || "",
            upperBanner: upperBanner ? upperBanner : foundSubCategory?.upperBanner,
            lowerBanner: lowerBanner ? lowerBanner : foundSubCategory?.lowerBanner,
            photos: photos ? photos : foundSubCategory?.photos,
            tags: tags ? tags : foundSubCategory?.tags,
        },
        { new: true }
    ).populate("parentCategory products").exec();
    if (!updatedSubCategory) {
        throw new ApiError(409, "Could not update sub category");
    }

    // update parent category
    if (foundSubCategory?.parentCategory !== updatedSubCategory?.parentCategory) {
        //Remove subCategory in old parent category
        const oldCategory = await Category.findByIdAndUpdate(
            { _id: foundSubCategory?.parentCategory },
            {
                $pull: {
                    subCategories: foundSubCategory?._id
                }
            },
            { new: true }
        ).populate("subCategories").exec();
        console.log("Old Parent Category: ", oldCategory);

        //add the subCategory in new parent category
        const newCategory = await Category.findByIdAndUpdate(
            { _id: updatedSubCategory?.parentCategory?._id },
            {
                $push: {
                    subCategories: updatedSubCategory?._id
                }
            },
            { new: true }
        ).populate("subCategories").exec();
        console.log("New Parent Category: ", newCategory);
    }

    return res.status(200).json(
        new ApiResponse(200, updatedSubCategory, "Sub Category updated Successfully")
    )
});

const updateSubCategoryStatus = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const {
        active,
    } = req.body;

    //Todo: Add Images, upper, lower banner in the subcategories

    if (!_id) {
        throw new ApiError(400, "Details not found");
    }

    // Validate sub category Id
    const foundSubCategory = await SubCategory.findById(_id);
    if (!foundSubCategory) {
        throw new ApiError(409, `Sub category not found`);
    }

    const updatedSubCategory = await SubCategory.findByIdAndUpdate(
        { _id },
        {
            active: active != undefined ? active : foundSubCategory?.active
        },
        { new: true }
    ).populate("parentCategory products").exec();
    if (!updatedSubCategory) {
        throw new ApiError(409, "Could not update sub category");
    }

    return res.status(200).json(
        new ApiResponse(200, updatedSubCategory, "Sub Category updated Successfully")
    )
});

const deleteSubCategory = asyncHandler(async (req, res) => {
    const { _id } = req.params;

    //Todo: Add Images, upper, lower banner in the subcategories

    if (!_id) {
        throw new ApiError(400, "Details not found");
    }

    // Validate sub category Id
    const foundSubCategory = await SubCategory.findById(_id);
    if (!foundSubCategory) {
        throw new ApiError(409, `Sub category not found`);
    }

    const deletedSubCategory = await SubCategory.findByIdAndDelete(_id).populate("parentCategory products").exec();
    if (!deletedSubCategory) {
        throw new ApiError(409, "Could not delete sub category");
    }
    // console.log("Sub Category: ", deletedSubCategory);

    //delete the subCategory in parent category
    const updatedCategory = await Category.findByIdAndUpdate(
        { _id: deletedSubCategory?.parentCategory?._id },
        {
            $pull: {
                subCategories: deletedSubCategory?._id
            }
        },
        { new: true }
    ).populate("subCategories").exec();
    console.log("Parent Category: ", updatedCategory);

    return res.status(200).json(
        new ApiResponse(200, deleteSubCategory, "Sub Category deleted Successfully")
    )
});

const getAllSubCategorySlugs = asyncHandler(async (req, res) => {
    const allSubCategories = await SubCategory.find({ active: true })
        .select("-_id slug updatedAt")
        .exec();

    if (!allSubCategories) {
        throw new ApiError(409, "Could not find sub categories");
    }

    return res.status(200).json(
        new ApiResponse(200, allSubCategories, "Sub Category slugs fetched Successfully")
    )
});

const getAllSubCategories = asyncHandler(async (req, res) => {
    const { parentCategory, categoryId, searchQuery, search } = req.query;
    let { page, limit } = req.query;
    const filter = {};

    const categoryFilter = parentCategory || categoryId;
    if (categoryFilter && categoryFilter.trim()) {
        filter.parentCategory = categoryFilter.trim();
    }

    const query = searchQuery || search;
    if (query && query.trim()) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        const regexArray = words.map(word => new RegExp(word, "i"));

        filter.$or = [
            { $and: regexArray.map(r => ({ name: r })) },
            { $and: regexArray.map(r => ({ slug: r })) }
        ];
    }

    if (page !== undefined && limit !== undefined) {
        page = parseInt(page, 10) || 1;
        limit = parseInt(limit, 10) || 10;
        const skip = (page - 1) * limit;

        const totalSubCategories = await SubCategory.countDocuments(filter);
        const totalPages = Math.ceil(totalSubCategories / limit);

        const subCategories = await SubCategory.find(filter)
            .populate({
                path: "parentCategory",
                model: "Category",
            })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .exec();

        return res.status(200).json(
            new ApiResponse(200, {
                subCategories,
                pagination: {
                    totalSubCategories,
                    totalPages,
                    currentPage: page,
                    limit,
                    hasMore: page < totalPages
                }
            }, "Sub-Categories fetched Successfully")
        );
    } else {
        const allSubCategories = await SubCategory.find(filter)
            .populate({
                path: "parentCategory",
                model: "Category",
            })
            .sort({ createdAt: -1 })
            .exec();

        if (!allSubCategories) {
            throw new ApiError(409, "Could not find sub categories");
        }

        return res.status(200).json(
            new ApiResponse(200, allSubCategories, "Sub Categories fetched Successfully")
        );
    }
});

const getProductsBySubCategory = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const subCategory = await SubCategory.findById(_id).populate({
        path: "products",
        model: "Product",
        select: "fullName slug regularPrice sellingPrice totalStock images active photos"
    }).exec();

    if (!subCategory) {
        throw new ApiError(404, "SubCategory not found");
    }

    return res.status(200).json(
        new ApiResponse(200, subCategory.products || [], "SubCategory products fetched successfully")
    );
});

const getAllSubCategoryNames = asyncHandler(async (req, res) => {
    const allSubCategories = await SubCategory.find({})
        .select("_id name slug")
        .exec();

    if (!allSubCategories) {
        throw new ApiError(409, "Could not find sub categories");
    }

    return res.status(200).json(
        new ApiResponse(200, allSubCategories, "Sub Categories fetched Successfully")
    )
});

const getAllFeaturedSubCategories = asyncHandler(async (req, res) => {
    const allFeaturedSubCategories = await SubCategory.find({
        featured: true
    })
        .populate({
            path: "parentCategory",
            model: "Category",
        })
        .populate({
            path: "products",
            model: "Product",
            select: "-orders -stock"
        }).exec();
    // .populate("parentCategory products").exec();

    if (!allFeaturedSubCategories) {
        throw new ApiError(409, "Could not find featured sub categories");
    }

    return res.status(200).json(
        new ApiResponse(200, allFeaturedSubCategories, "Featured Sub Categories fetched Successfully")
    )
});

const getSubCategoryById = asyncHandler(async (req, res) => {
    const completeSubCategoryDetails = await SubCategory.findById(req.params._id)
        .populate({
            path: "parentCategory",
            model: "Category",
        })
        .populate({
            path: "products",
            model: "Product",
            select: "-orders -stock"
        }).exec()
    // .populate("parentCategory").populate("products").exec();

    if (!completeSubCategoryDetails) {
        throw new ApiError(409, "Could not fetch sub category details");
    }

    return res.status(200).json(
        new ApiResponse(200, completeSubCategoryDetails, "Sub Category details fetched Successfully")
    )
});

const getSubCategoryBySlug = asyncHandler(async (req, res) => {
    const completeSubCategoryDetails = await SubCategory.findOne({
        slug: req.params.slug
    })
        // .populate({
        //     path: "parentCategory",
        //     model: "Category",
        // })
        .populate({
            path: "products",
            model: "Product",
            select: "-orders -stock -groups"
        }).exec()
    // .populate("parentCategory").populate("products").exec();

    if (!completeSubCategoryDetails) {
        throw new ApiError(409, "Could not fetch sub category details");
    }

    return res.status(200).json(
        new ApiResponse(200, completeSubCategoryDetails, "Sub Category details fetched Successfully")
    )
});

const getSubCategoryProductsBySlugPaginated = asyncHandler(async (req, res) => {
    const { slug } = req.params;
    if (!slug) {
        throw new ApiError(400, "Slug is required");
    }

    const subCategory = await SubCategory.findOne({ slug }).lean();
    if (!subCategory) {
        throw new ApiError(404, "Sub Category not found");
    }

    const productIds = subCategory.products || [];

    // Parse cursor params
    const lastIndex = Math.max(-1, parseInt(req.query.lastIndex, 10) || -1); // -1 => start
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10)); // default 10 per batch
    const start = lastIndex + 1;
    const orderBy = req.query?.orderBy?.toLowerCase();

    // Match criteria for active products belonging to the subcategory
    const matchQuery = {
        _id: { $in: productIds },
        active: true
    };

    if (orderBy) {
        // ----------------------------------------------------
        // CASE A: Price sorting requested -> Use Aggregation Pipeline
        // ----------------------------------------------------
        const matchStage = {
            _id: { $in: productIds.map(id => new mongoose.Types.ObjectId(id)) },
            active: true
        };

        const addLatestPriceStage = {
            $addFields: {
                latestPrice: {
                    $let: {
                        vars: {
                            latestPriceObj: { $arrayElemAt: ["$sellingPrice", -1] }
                        },
                        in: { $ifNull: ["$$latestPriceObj.price", 0] }
                    }
                }
            }
        };

        // 1) Compute total matching documents
        const countPipeline = [
            { $match: matchStage },
            addLatestPriceStage,
            { $count: "total" }
        ];

        const countResult = await Product.aggregate(countPipeline).exec();
        const total = (countResult[0] && countResult[0].total) ? countResult[0].total : 0;

        // if start beyond total, return empty array with pagination
        if (start >= total) {
            return res.status(200).json(new ApiResponse(200, {
                subCategory: {
                    _id: subCategory._id,
                    name: subCategory.name,
                    slug: subCategory.slug,
                    active: subCategory.active
                },
                products: [],
                pagination: {
                    lastIndex,
                    limit,
                    returned: 0,
                    total,
                    hasMore: false
                }
            }, "Products fetched successfully"));
        }

        // 2) Fetch products, sort, and paginate
        const pipeline = [
            { $match: matchStage },
            addLatestPriceStage,
            {
                $project: {
                    orders: 0,
                    stock: 0,
                    groups: 0,
                    category: 0
                }
            },
            {
                $sort: {
                    latestPrice: orderBy === "desc" ? -1 : 1,
                    totalStock: -1,
                    _id: 1
                }
            },
            { $skip: start },
            { $limit: limit }
        ];

        const products = await Product.aggregate(pipeline, { allowDiskUse: true }).exec();

        const returned = Array.isArray(products) ? products.length : 0;
        const newLastIndex = start + returned - 1;
        const hasMore = (start + returned) < total;

        return res.status(200).json(new ApiResponse(200, {
            subCategory: {
                ...subCategory,
                products: undefined // exclude products list to avoid duplicating data
            },
            products,
            pagination: {
                lastIndex: newLastIndex,
                limit,
                returned,
                total,
                hasMore
            }
        }, "Sub Category products fetched successfully"));
    } else {
        // ----------------------------------------------------
        // CASE B: Default sorting -> Use Standard Mongoose Query
        // ----------------------------------------------------
        // 1) Compute total matching documents using countDocuments
        const total = await Product.countDocuments(matchQuery);

        // if start beyond total, return empty array with pagination
        if (start >= total) {
            return res.status(200).json(new ApiResponse(200, {
                subCategory: {
                    _id: subCategory._id,
                    name: subCategory.name,
                    slug: subCategory.slug,
                    active: subCategory.active
                },
                products: [],
                pagination: {
                    lastIndex,
                    limit,
                    returned: 0,
                    total,
                    hasMore: false
                }
            }, "Products fetched successfully"));
        }

        // 2) Fetch products with the query, sort, and skip/limit pagination
        const products = await Product.find(matchQuery)
            .select("-orders -stock -groups -category")
            .sort({ totalStock: -1, _id: 1 })
            .skip(start)
            .limit(limit)
            .lean()
            .exec();

        const returned = Array.isArray(products) ? products.length : 0;
        const newLastIndex = start + returned - 1;
        const hasMore = (start + returned) < total;

        return res.status(200).json(new ApiResponse(200, {
            subCategory: {
                ...subCategory,
                products: undefined // exclude products list to avoid duplicating data
            },
            products,
            pagination: {
                lastIndex: newLastIndex,
                limit,
                returned,
                total,
                hasMore
            }
        }, "Sub Category products fetched successfully"));
    }
});


export {
    createCategory,
    editCategory,
    updateSubCategoryStatus,
    deleteCategory,
    getAllCategorySlugs,
    getAllCategories,
    getCategoryById,
    getCategoryBySlug,
    createSubCategory,
    editSubCategory,
    getAllSubCategorySlugs,
    deleteSubCategory,
    getAllSubCategories,
    getProductsBySubCategory,
    getAllSubCategoryNames,
    getAllFeaturedSubCategories,
    getSubCategoryById,
    getSubCategoryBySlug,
    getSubCategoryProductsBySlugPaginated
}