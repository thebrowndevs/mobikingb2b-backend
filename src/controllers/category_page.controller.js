import mongoose from "mongoose";
import { AppCategoryPage as CategoryPage } from "../models/appCategoryPage.model.js";
import { Group } from "../models/group.model.js";
import { Product } from "../models/product.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const getCategoryPageLayout = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    let categoryPage = await CategoryPage.findOne({ active: true }).select("_id active groups").lean();

    if (!categoryPage) {
        return res.status(200).json(
            new ApiResponse(200, {
                _id: null,
                active: false,
                groups: [],
                pagination: {
                    totalGroups: 0,
                    page,
                    limit,
                    totalPages: 0
                }
            }, "Category page layout fetched successfully")
        );
    }

    const allGroupIds = Array.isArray(categoryPage.groups) ? categoryPage.groups : [];
    const totalGroups = allGroupIds.length;

    if (totalGroups === 0 || skip >= totalGroups) {
        return res.status(200).json(
            new ApiResponse(200, {
                _id: categoryPage._id,
                active: categoryPage.active,
                groups: [],
                pagination: {
                    totalGroups,
                    page,
                    limit,
                    totalPages: Math.ceil(totalGroups / limit)
                }
            }, "Category page layout fetched successfully")
        );
    }

    const categoryPageObjectId = mongoose.isValidObjectId(categoryPage._id)
        ? (typeof categoryPage._id === 'string' ? new mongoose.Types.ObjectId(categoryPage._id) : categoryPage._id)
        : categoryPage._id;

    const pipeline = [
        { $match: { _id: categoryPageObjectId } },
        {
            $project: {
                active: 1,
                groups: { $slice: ['$groups', skip, limit] }
            }
        },
        {
            $lookup: {
                from: 'groups',
                let: { groupIds: '$groups' },
                pipeline: [
                    {
                        $match: {
                            $expr: { $in: ['$_id', '$$groupIds'] },
                            active: true
                        }
                    },
                    { $addFields: { __order: { $indexOfArray: ['$$groupIds', '$_id'] } } },
                    { $sort: { __order: 1 } },
                    {
                        $lookup: {
                            from: 'subcategories',
                            localField: 'categories',
                            foreignField: '_id',
                            pipeline: [
                                { $project: { _id: 1, name: 1, slug: 1, icon: 1, photos: 1, upperBanner: 1, lowerBanner: 1 } }
                            ],
                            as: 'categories'
                        }
                    },
                    {
                        $lookup: {
                            from: 'categories',
                            localField: 'parentCategories',
                            foreignField: '_id',
                            pipeline: [
                                { $project: { _id: 1, name: 1, slug: 1, image: 1 } }
                            ],
                            as: 'parentCategories'
                        }
                    },
                    {
                        $lookup: {
                            from: 'brands',
                            localField: 'brands',
                            foreignField: '_id',
                            pipeline: [
                                { $project: { _id: 1, name: 1, image: 1 } }
                            ],
                            as: 'brands'
                        }
                    },
                    {
                        $lookup: {
                            from: 'products',
                            let: { prodIds: '$products' },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: { $in: ['$_id', '$$prodIds'] },
                                        active: true,
                                        totalStock: { $gt: 0 }
                                    }
                                },
                                { $addFields: { __order: { $indexOfArray: ['$$prodIds', '$_id'] } } },
                                { $sort: { __order: 1 } },
                                { $limit: 6 },
                                { $project: { _id: 1, name: 1, fullName: 1, slug: 1, images: 1, regularPrice: 1, basePrice: 1, sellingPrice: 1, totalStock: 1 } }
                            ],
                            as: 'products'
                        }
                    }
                ],
                as: 'groups'
            }
        }
    ];

    const [result = null] = await CategoryPage.aggregate(pipeline).exec();
    const groups = result && Array.isArray(result.groups) ? result.groups : [];

    return res.status(200).json(
        new ApiResponse(200, {
            _id: categoryPage._id,
            active: categoryPage.active,
            groups,
            pagination: {
                totalGroups,
                page,
                limit,
                totalPages: Math.ceil(totalGroups / limit)
            }
        }, "Category page layout fetched successfully")
    );
});

const getCategoryPageLayoutAdmin = asyncHandler(async (req, res) => {
    let categoryPage = await CategoryPage.findOne({})
        .populate({
            path: 'groups',
            // populate: [
            //     { path: 'products', select: '_id fullName images regularPrice basePrice sellingPrice totalStock' },
            //     { path: 'groupSubCategories' },
            //     { path: 'parentCategories', select: 'name _id slug image' },
            //     { path: 'brands', select: 'name _id image' }
            // ]
        })
        .lean();

    if (!categoryPage) {
        categoryPage = await CategoryPage.create({ active: true, groups: [] });
    }

    return res.status(200).json(
        new ApiResponse(200, categoryPage, "Category page layout admin fetched successfully")
    );
});

const editCategoryPageLayout = asyncHandler(async (req, res) => {
    const { active, groups } = req.body;

    let categoryPage = await CategoryPage.findOne({});
    if (!categoryPage) {
        categoryPage = await CategoryPage.create({ active: true, groups: [] });
    }

    if (typeof active === 'boolean') {
        categoryPage.active = active;
    }

    if (Array.isArray(groups)) {
        const validGroupIds = groups.filter(id => mongoose.Types.ObjectId.isValid(id));
        const oldGroupIds = (categoryPage.groups || []).map(g => g.toString());
        const newGroupIds = validGroupIds.map(g => g.toString());

        categoryPage.groups = validGroupIds;

        const addedGroupIds = newGroupIds.filter(id => !oldGroupIds.includes(id));
        const removedGroupIds = oldGroupIds.filter(id => !newGroupIds.includes(id));

        if (addedGroupIds.length > 0) {
            await Group.updateMany(
                { _id: { $in: addedGroupIds } },
                { $set: { appCategoryGroup: true } }
            );
        }

        if (removedGroupIds.length > 0) {
            await Group.updateMany(
                { _id: { $in: removedGroupIds } },
                { $set: { appCategoryGroup: false } }
            );
        }
    }

    await categoryPage.save();

    const updated = await CategoryPage.findById(categoryPage._id)
        .populate({
            path: 'groups',
            populate: [
                { path: 'products', select: '_id fullName images regularPrice basePrice sellingPrice totalStock' },
                { path: 'categories' },
                { path: 'parentCategories', select: 'name _id slug image' },
                { path: 'brands', select: 'name _id image' }
            ]
        })
        .lean();

    return res.status(200).json(
        new ApiResponse(200, updated, "Category page layout updated successfully")
    );
});

export {
    getCategoryPageLayout,
    getCategoryPageLayoutAdmin,
    editCategoryPageLayout
};
