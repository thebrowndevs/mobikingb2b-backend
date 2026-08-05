import { Home } from "../models/home.model.js";
import { sendRouteReloadNotification } from "../services/firebase.service.js";
import { Group } from "../models/group.model.js";
import { Product } from "../models/product.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import mongoose from 'mongoose';

const formatBanners = (banners) => {
    if (!banners || !Array.isArray(banners)) return [];
    return banners.map(b => {
        if (typeof b === 'string') {
            return {
                desktopUrl: b,
                mobileUrl: b,
                redirectUrl: ''
            };
        }
        return {
            desktopUrl: b?.desktopUrl || b?.mobileUrl || '',
            mobileUrl: b?.mobileUrl || b?.desktopUrl || '',
            redirectUrl: b?.redirectUrl || ''
        };
    });
};

const formatHomeLayoutBanners = (layout) => {
    if (!layout) return layout;
    const formatted = JSON.parse(JSON.stringify(layout));
    if (formatted.banners) {
        formatted.banners = formatBanners(formatted.banners);
    }
    return formatted;
};


const createHome = asyncHandler(async (req, res) => {
    let {
        categories,
        groups,
        active,
        banners
    } = req.body;

    if (
        !groups && !groups?.length
    ) {
        throw new ApiError(400, "Groups not found");
    }

    if (
        !categories && !categories?.length
    ) {
        throw new ApiError(400, "Categories not found");
    }

    //create new Home
    const newHomeLayout = await Home.create({
        active,
        banners: banners ? banners : []
    });
    if (!newHomeLayout) {
        throw new ApiError(409, "Could not create home layout");
    }

    const homeLayout = await Home.findByIdAndUpdate(
        newHomeLayout?._id,
        {
            $push: {
                groups: groups,
                categories: categories
            }
        },
        { new: true }
    )
        .populate('groups')
        .populate([
            {
                path: 'groups',
                populate: {
                    path: 'products',
                    model: 'Product',
                    populate: {
                        path: 'category',
                        model: 'SubCategory'
                    }
                }
            },
            {
                path: 'categories',
                model: 'SubCategory'
            }
        ])
        .populate("categories")
        .exec();

    // Trigger silent route reload notifications in background
    sendRouteReloadNotification("/home");
    sendRouteReloadNotification("/home/website");
    sendRouteReloadNotification("/home/categories");

    //return response
    return res.status(201).json(
        new ApiResponse(201, formatHomeLayoutBanners(homeLayout), "Home layout created Successfully")
    )
});

const editHomeLayout = asyncHandler(async (req, res) => {
    // let {
    //     categories,
    //     groups,
    //     active,
    //     banners
    // } = req.body;

    let updates = req?.body;

    const homeId = req.params?._id;

    if (
        !homeId
    ) {
        throw new ApiError(400, "Home Layout Id not found");
    }

    // if (
    //     groups && !groups?.length
    // ) {
    //     throw new ApiError(400, "No groups sent");
    // }

    // if (
    //     categories && !categories?.length
    // ) {
    //     throw new ApiError(400, "No categories sent");
    // }

    // if (
    //     !categories && !categories?.length
    // ) {
    //     throw new ApiError(400, "Categories not found");
    // }

    // check if home layout exist
    const foundHomeLayout = await Home.findById(homeId)

    if (!foundHomeLayout) {
        throw new ApiError(400, "Home Layout does not exit");
    }

    //create new Home
    const updatedHomeLayout = await Home.findByIdAndUpdate(
        homeId,
        {
            // active: active ? active : foundHomeLayout?.active,
            // banners: banners ? banners : foundHomeLayout?.banners,
            // groups: groups || foundHomeLayout?.groups || [],
            // categories: categories || foundHomeLayout?.categories || []
            ...updates
        },
        { new: true }
    )
        .populate('groups')
        .populate([
            {
                path: 'groups',
                populate: {
                    path: 'products',
                    model: 'Product',
                    populate: {
                        path: 'category',
                        model: 'SubCategory'
                    }
                }
            },
            {
                path: 'categories',
                model: 'SubCategory'
            }
        ])
        .populate("categories")
        .exec();

    if (!updatedHomeLayout) {
        throw new ApiError(409, "Could not update home layout");
    }

    // Trigger silent route reload notifications in background
    sendRouteReloadNotification("/home");
    sendRouteReloadNotification("/home/website");
    sendRouteReloadNotification("/home/categories");

    //return response
    return res.status(200).json(
        new ApiResponse(200, formatHomeLayoutBanners(updatedHomeLayout), "Home layout updated Successfully")
    )
});

const getHomeLayout = asyncHandler(async (req, res) => {
    const latestLayout = await Home.findOne({
        active: true
    }).sort({ createdAt: -1 })
        .populate('groups')
        .populate({
            path: 'groups',
            populate: {
                path: 'categories',
                model: 'SubCategory',
                select: '_id name'
            }
        })
        .populate({
            path: 'groups',
            populate: {
                path: 'products',
                model: 'Product',
                select: '-orders -stock -groups -category'
            }
        })
        .populate({
            path: 'groups',
            populate: {
                path: 'parentCategories',
                model: 'Category',
                select: 'name _id image slug'
            }
        })
        .populate({
            path: "categories",
            model: "SubCategory",
            select: "-tags -photos -parentCategory -products"
        })
        .exec();

    if (!latestLayout) {
        throw new ApiError(400, "No layout Found");
    }

    return res.status(200).json(
        new ApiResponse(200, formatHomeLayoutBanners(latestLayout), "Home Layout fetched successfully")
    );
})

const getHomeCategories = asyncHandler(async (req, res) => {
    const latestLayout = await Home.findOne({ active: true })
        .sort({ createdAt: -1 })
        .populate({
            path: "categories",
            model: "SubCategory",
            select: "-parentCategory -products"
        })
        .select("categories")
        .exec();

    if (!latestLayout) {
        throw new ApiError(400, "No layout found");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            latestLayout.categories,
            "Home categories fetched successfully"
        )
    );
});

const getGroupsByCategory = asyncHandler(async (req, res) => {

    const { categoryId } = req.params;

    const latestLayout = await Home.findOne({ active: true })
        .sort({ createdAt: -1 })
        .populate({
            path: "groups",
            match: { categories: categoryId },
            populate: [
                {
                    path: "categories",
                    model: "SubCategory",
                    select: "_id name"
                },
                {
                    path: "products",
                    model: "Product",
                    select: "-orders -stock -groups -category"
                },
                {
                    path: "parentCategories",
                    model: "Category",
                    select: "name _id image slug"
                }
            ]
        })
        .exec();

    if (!latestLayout) {
        throw new ApiError(400, "No layout found");
    }

    const groups = latestLayout.groups.filter(g => g !== null);

    return res.status(200).json(
        new ApiResponse(200, groups, "Groups fetched successfully")
    );
});

const getGroupsByCategoryPaginated = asyncHandler(async (req, res) => {
    const { categoryId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    // limit capped at 2 groups per page
    const limit = Math.min(2, parseInt(req.query.limit, 10) || 2);
    const skip = (page - 1) * limit;

    // Retrieve active home layout with only the groups array of ObjectIds (lean)
    const latestLayout = await Home.findOne({ active: true })
        .sort({ createdAt: -1 })
        .select("groups")
        .lean()
        .exec();

    if (!latestLayout) {
        throw new ApiError(400, "No layout found");
    }

    const homeGroups = latestLayout.groups || [];
    if (homeGroups.length === 0) {
        return res.status(200).json(
            new ApiResponse(200, {
                groups: [],
                pagination: {
                    totalGroups: 0,
                    page,
                    limit,
                    totalPages: 0
                }
            }, "No groups found in home layout")
        );
    }

    // First Pass: Find all active matching group IDs that belong to the categories list.
    const matchingGroups = await Group.find({
        _id: { $in: homeGroups },
        categories: categoryId,
        active: true
    })
        .select("_id")
        .lean()
        .exec();

    const matchingIdsStrings = matchingGroups.map(g => g._id.toString());

    // Sort matching Group IDs to preserve the original Home Layout array order
    const sortedMatchingIds = homeGroups
        .filter(id => id && matchingIdsStrings.includes(id.toString()));

    const totalGroups = sortedMatchingIds.length;

    // Slice the IDs for database pagination
    const paginatedIds = sortedMatchingIds.slice(skip, skip + limit);

    if (paginatedIds.length === 0) {
        return res.status(200).json(
            new ApiResponse(200, {
                groups: [],
                pagination: {
                    totalGroups,
                    page,
                    limit,
                    totalPages: Math.ceil(totalGroups / limit)
                }
            }, "Groups fetched successfully (empty page)")
        );
    }

    // Second Pass: Fetch the full details only for the paginated group IDs
    const groupsRaw = await Group.find({
        _id: { $in: paginatedIds }
    })
        .populate({
            path: "categories",
            model: "SubCategory",
            select: "_id name"
        })
        .populate({
            path: "parentCategories",
            model: "Category",
            select: "name _id image slug"
        })
        .lean()
        .exec();

    // Sort the detailed groups to match paginatedIds order
    const paginatedIdsStrings = paginatedIds.map(id => id.toString());
    const groups = groupsRaw.sort((a, b) => {
        return paginatedIdsStrings.indexOf(a._id.toString()) - paginatedIdsStrings.indexOf(b._id.toString());
    });

    // Fetch up to 6 products for each group (in parallel using Promise.all)
    const groupsWithProducts = await Promise.all(
        groups.map(async (group) => {
            const productIds = group.products || [];

            const [products, totalProducts] = await Promise.all([
                Product.find({
                    _id: { $in: productIds },
                    active: true,
                    totalStock: { $gt: 0 }
                })
                    .select("-orders -stock -groups -category")
                    .limit(6)
                    .lean()
                    .exec(),

                Product.countDocuments({
                    _id: { $in: productIds },
                    active: true,
                    totalStock: { $gt: 0 }
                }).exec()
            ]);

            return {
                ...group,
                products,
                pagination: {
                    totalProducts,
                    limit: 6,
                    totalPages: Math.ceil(totalProducts / 6)
                }
            };
        })
    );

    return res.status(200).json(
        new ApiResponse(200, {
            groups: groupsWithProducts,
            pagination: {
                totalGroups,
                page,
                limit,
                totalPages: Math.ceil(totalGroups / limit)
            }
        }, "Groups with paginated products fetched successfully")
    );
});

const getGroupsByCategoryAdmin = asyncHandler(async (req, res) => {
    const { categoryId } = req.params;

    const latestLayout = await Home.findOne({ active: true })
        .sort({ createdAt: -1 })
        .select("groups")
        .lean();

    if (!latestLayout) {
        throw new ApiError(400, "No layout found");
    }

    const groupIds = latestLayout.groups || [];

    // Query groups collection directly using indexed lookup
    const groups = await Group.find({
        _id: { $in: groupIds },
        categories: categoryId
    })
        .populate({
            path: "categories",
            model: "SubCategory",
            select: "_id name"
        })
        .populate({
            path: "products",
            model: "Product",
            select: "_id fullName images regularPrice basePrice sellingPrice totalStock" // Only select essential fields to avoid huge payload overhead
        })
        .populate({
            path: "parentCategories",
            model: "Category",
            select: "name _id image slug"
        })
        .lean();

    // Sort the fetched groups to match the exact order defined in latestLayout.groups
    const groupOrderMap = new Map();
    groupIds.forEach((id, index) => {
        groupOrderMap.set(id.toString(), index);
    });

    groups.sort((a, b) => {
        const orderA = groupOrderMap.get(a._id.toString()) ?? 9999;
        const orderB = groupOrderMap.get(b._id.toString()) ?? 9999;
        return orderA - orderB;
    });

    return res.status(200).json(
        new ApiResponse(200, groups, "Groups fetched successfully")
    );
});

/**
 * GET /api/home-layout
 * Query params:
 *  - lastIndex (number) : last returned index on client, default -1 (start)
 *  - limit (number) : how many groups to return per request (page size)
 *  - productLimit (number) : how many products to return per group
 */
const getHomeLayoutWebsite = asyncHandler(async (req, res) => {
    const lastIndex = Math.max(-1, parseInt(req.query.lastIndex, 10) || -1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 5));
    const productLimit = Math.min(100, Math.max(0, parseInt(req.query.productLimit, 10) || 14));

    // get latest Home doc
    const latestHome = await Home.findOne({ active: true }).sort({ createdAt: -1 }).select('groups banners createdAt').lean();
    if (!latestHome) throw new ApiError(400, 'No layout Found');

    const allGroupIds = Array.isArray(latestHome.groups) ? latestHome.groups : [];
    const totalGroups = allGroupIds.length;

    const start = lastIndex + 1;
    if (start >= totalGroups) {
        return res.status(200).json(new ApiResponse(200, {
            banners: latestHome.banners || [],
            groups: [],
            pagination: {
                lastIndex,
                limit,
                productLimit,
                total: totalGroups,
                returned: 0,
                hasMore: false
            }
        }, 'Home Layout fetched successfully'));
    }

    // ensure we pass an ObjectId into the aggregation $match
    // latestHome._id from .lean() is normally already an ObjectId; if it's a string, convert with new
    const homeObjectId = mongoose.isValidObjectId(latestHome._id)
        ? (typeof latestHome._id === 'string' ? new mongoose.Types.ObjectId(latestHome._id) : latestHome._id)
        : latestHome._id;

    const pipeline = [
        { $match: { _id: homeObjectId } }, // <-- fixed: pass an ObjectId instance (or the original)
        {
            $project: {
                banners: 1, active: 1,
                groups: { $slice: ['$groups', start, limit] }
            }
        },
        {
            $lookup: {
                from: 'groups',
                let: { groupIds: '$groups' },
                pipeline: [
                    { $match: { $expr: { $in: ['$_id', '$$groupIds'] } } },
                    { $addFields: { __order: { $indexOfArray: ['$$groupIds', '$_id'] } } },
                    { $sort: { __order: 1 } },
                    {
                        $lookup: {
                            from: 'categories',
                            localField: 'parentCategories',
                            foreignField: '_id',
                            as: 'parentCategories'
                        }
                    },
                    {
                        $lookup: {
                            from: 'products',
                            let: { prodIds: '$products' },
                            pipeline: [
                                { $match: { $expr: { $in: ['$_id', '$$prodIds'] } } },
                                { $addFields: { __order: { $indexOfArray: ['$$prodIds', '$_id'] } } },
                                { $sort: { __order: 1 } },
                                { $limit: productLimit },
                                { $project: { orders: 0, stock: 0, groups: 0, category: 0 } }
                            ],
                            as: 'products'
                        }
                    },
                    {
                        $project: {
                            name: 1, banner: 1, bannerLink: 1,
                            isBannerLinkActive: 1, isBannerVisble: 1,
                            backgroundColor: 1, isBackgroundColorVisible: 1,
                            active: 1, parentCategories: 1, products: 1,
                            //   __order: 0
                        }
                    }
                ],
                as: 'groups'
            }
        },
        { $project: { banners: 1, groups: 1 } }
    ];

    const [aggResult = null] = await Home.aggregate(pipeline).exec();
    const groups = (aggResult && Array.isArray(aggResult.groups)) ? aggResult.groups : [];

    const returned = groups.length;
    const newLastIndex = start + returned - 1;
    const hasMore = (start + returned) < totalGroups;

    const banners = aggResult ? (aggResult.banners || latestHome.banners || []) : (latestHome.banners || []);

    return res.status(200).json(new ApiResponse(200, {
        banners: formatBanners(banners),
        groups,
        pagination: {
            lastIndex: newLastIndex,
            limit,
            productLimit,
            total: totalGroups,
            returned,
            hasMore
        }
    }, 'Home Layout fetched successfully'));
});

const getHomeLayoutAdmin = asyncHandler(async (req, res) => {
    const latestLayout = await Home.findOne({
        active: true
    }).sort({ createdAt: -1 })
        .populate({
            path: 'groups',
            populate: {
                path: 'categories',
                model: 'SubCategory',
                select: '_id name slug'
            },
            select: "-parentCategories"
        })
        .populate({
            path: "categories",
            model: "SubCategory",
            select: "_id name slug icon upperBanner lowerBanner theme products"
        })
        .exec();

    if (!latestLayout) {
        throw new ApiError(400, "No layout Found");
    }

    return res.status(200).json(
        new ApiResponse(200, formatHomeLayoutBanners(latestLayout), "Home Layout fetched successfully")
    );
})

const getAllHomeLayout = asyncHandler(async (req, res) => {
    const allLayouts = await Home.find({}).sort({ createdAt: -1 })
        .populate('groups')
        .populate([
            {
                path: 'groups',
                populate: {
                    path: 'products',
                    model: 'Product',
                    populate: {
                        path: 'category',
                        model: 'SubCategory'
                    }
                }
            },
            {
                path: 'categories',
                model: 'SubCategory'
            }
        ])
        .populate("categories")
        .exec();

    if (!allLayouts) {
        throw new ApiError(400, "No layouts Found");
    }

    const formattedLayouts = allLayouts.map(layout => formatHomeLayoutBanners(layout));
    return res.status(200).json(
        new ApiResponse(200, formattedLayouts, "Home Layouts fetched successfully")
    );
})

export {
    createHome,
    editHomeLayout,
    getHomeLayout,
    getHomeCategories,
    getGroupsByCategory,
    getGroupsByCategoryAdmin,
    getGroupsByCategoryPaginated,
    getHomeLayoutWebsite,
    getHomeLayoutAdmin,
    getAllHomeLayout
}