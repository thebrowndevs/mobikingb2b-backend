import { Group } from "../models/group.model.js";
import { Product } from "../models/product.model.js";
import { WebsiteHome } from "../models/websiteHome.model.js";
import { Home } from "../models/home.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import mongoose from "mongoose";

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

const getWebsiteBanners = asyncHandler(async (req, res) => {
    const layout = await WebsiteHome.findOne({ active: true }).select("banners").lean();
    if (!layout) {
        return res.status(200).json(new ApiResponse(200, [], "No active website layout found"));
    }
    return res.status(200).json(new ApiResponse(200, layout.banners || [], "Website banners fetched successfully"));
});

const getWebsiteCategories = asyncHandler(async (req, res) => {
    const layout = await WebsiteHome.findOne({ active: true })
        .populate({
            path: "movingCategories",
            model: "SubCategory",
            select: "name slug photos"
        })
        .select("movingCategories")
        .lean();
    if (!layout) {
        return res.status(200).json(new ApiResponse(200, [], "No active website layout found"));
    }
    return res.status(200).json(new ApiResponse(200, layout.movingCategories || [], "Website moving categories fetched successfully"));
});

const getWebsiteGroups = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 2;
    const skip = (page - 1) * limit;

    const layout = await WebsiteHome.findOne({ active: true }).select("groups").lean();
    if (!layout || !layout.groups || layout.groups.length === 0) {
        return res.status(200).json(new ApiResponse(200, { groups: [], pagination: { totalGroups: 0, page, limit, totalPages: 0 } }, "No groups found"));
    }

    const groupIds = layout.groups;
    const totalGroups = groupIds.length;
    const paginatedIds = groupIds.slice(skip, skip + limit);

    if (paginatedIds.length === 0) {
        return res.status(200).json(new ApiResponse(200, { groups: [], pagination: { totalGroups, page, limit, totalPages: Math.ceil(totalGroups / limit) } }, "Groups fetched successfully (empty page)"));
    }

    const groupsRaw = await Group.find({ _id: { $in: paginatedIds }, active: true }).lean();

    const idStrings = paginatedIds.map(id => id.toString());
    const groups = groupsRaw.sort((a, b) => idStrings.indexOf(a._id.toString()) - idStrings.indexOf(b._id.toString()));

    const groupsWithProducts = await Promise.all(
        groups.map(async (group) => {
            if (group.groupType === 'subcategories') {
                const subcategoryIds = group.categories || [];
                const subcategories = await SubCategory.find({ _id: { $in: subcategoryIds }, active: true })
                    .select("name slug photos")
                    .lean();
                // sort to match input sequence
                const idStrings = subcategoryIds.map(id => id.toString());
                const sortedSubcategories = subcategories.sort((a, b) => idStrings.indexOf(a._id.toString()) - idStrings.indexOf(b._id.toString()));
                return {
                    ...group,
                    subcategories: sortedSubcategories,
                    totalItems: sortedSubcategories.length
                };
            } else if (group.groupType === 'categories') {
                const categoryIds = group.parentCategories || [];
                const categories = await Category.find({ _id: { $in: categoryIds }, active: true })
                    .select("name slug image")
                    .lean();
                // sort to match input sequence
                const idStrings = categoryIds.map(id => id.toString());
                const sortedCategories = categories.sort((a, b) => idStrings.indexOf(a._id.toString()) - idStrings.indexOf(b._id.toString()));
                return {
                    ...group,
                    categories: sortedCategories,
                    totalItems: sortedCategories.length
                };
            } else {
                const productIds = group.products || [];
                const [products, totalProducts] = await Promise.all([
                    Product.find({ _id: { $in: productIds }, active: true })
                        .select("-orders -stock -groups -category")
                        .limit(10)
                        .lean(),
                    Product.countDocuments({ _id: { $in: productIds }, active: true })
                ]);
                const idStrings = productIds.map(id => id.toString());
                const sortedProducts = products.sort((a, b) => idStrings.indexOf(a._id.toString()) - idStrings.indexOf(b._id.toString()));
                return {
                    ...group,
                    products: sortedProducts,
                    totalProducts
                };
            }
        })
    );

    return res.status(200).json(new ApiResponse(200, {
        groups: groupsWithProducts,
        pagination: {
            totalGroups,
            page,
            limit,
            totalPages: Math.ceil(totalGroups / limit)
        }
    }, "Website groups fetched successfully"));
});

const getWebGroupProductsPaginated = asyncHandler(async (req, res) => {
    const { groupId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 12;
    const skip = (page - 1) * limit;

    const group = await Group.findById(groupId).lean();
    if (!group || !group.active) {
        throw new ApiError(404, "Group not found or is inactive");
    }

    const productIds = group.products || [];
    const totalProducts = productIds.length;

    const paginatedIds = productIds.slice(skip, skip + limit);

    if (paginatedIds.length === 0) {
        return res.status(200).json(new ApiResponse(200, { products: [], pagination: { totalProducts, page, limit, totalPages: Math.ceil(totalProducts / limit) } }, "Products fetched successfully (empty page)"));
    }

    const products = await Product.find({ _id: { $in: paginatedIds }, active: true })
        .select("-orders -stock -groups -category")
        .lean();

    const idStrings = paginatedIds.map(id => id.toString());
    const sortedProducts = products.sort((a, b) => idStrings.indexOf(a._id.toString()) - idStrings.indexOf(b._id.toString()));

    return res.status(200).json(new ApiResponse(200, {
        groupInfo: {
            _id: group._id,
            name: group.name,
            heading: group.heading,
            placement: group.placement,
            color: group.color,
            desktopBanner: group.desktopBanner,
            mobileBanner: group.mobileBanner,
            bannerLink: group.bannerLink
        },
        products: sortedProducts,
        pagination: {
            totalProducts,
            page,
            limit,
            totalPages: Math.ceil(totalProducts / limit)
        }
    }, "Group products fetched successfully"));
});

import { sendRouteReloadNotification } from "../services/firebase.service.js";
import { Category } from "../models/category.model.js";
import { SubCategory } from "../models/sub_category.model.js";

// Legacy support for website layout API
const getHomeLayoutWebsite = asyncHandler(async (req, res) => {
    const lastIndex = Math.max(-1, parseInt(req.query.lastIndex, 10) || -1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 5));
    const productLimit = Math.min(100, Math.max(0, parseInt(req.query.productLimit, 10) || 14));

    const latestHome = await Home.findOne({ active: true }).sort({ createdAt: -1 }).select('groups banners createdAt').lean();
    if (!latestHome) throw new ApiError(400, 'No layout Found');

    const allGroupIds = Array.isArray(latestHome.groups) ? latestHome.groups : [];
    const totalGroups = allGroupIds.length;

    const start = lastIndex + 1;
    if (start >= totalGroups) {
        return res.status(200).json(new ApiResponse(200, {
            banners: latestHome.banners || [],
            groups: [],
            pagination: { lastIndex, limit, productLimit, total: totalGroups, returned: 0, hasMore: false }
        }, 'Home Layout fetched successfully'));
    }

    const homeObjectId = mongoose.isValidObjectId(latestHome._id)
        ? (typeof latestHome._id === 'string' ? new mongoose.Types.ObjectId(latestHome._id) : latestHome._id)
        : latestHome._id;

    const pipeline = [
        { $match: { _id: homeObjectId } },
        { $project: { banners: 1, active: 1, groups: { $slice: ['$groups', start, limit] } } },
        {
            $lookup: {
                from: 'groups',
                let: { groupIds: '$groups' },
                pipeline: [
                    { $match: { $expr: { $in: ['$_id', '$$groupIds'] } } },
                    { $addFields: { __order: { $indexOfArray: ['$$groupIds', '$_id'] } } },
                    { $sort: { __order: 1 } },
                    { $lookup: { from: 'categories', localField: 'parentCategories', foreignField: '_id', as: 'parentCategories' } },
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
                            active: 1, parentCategories: 1, products: 1
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
        pagination: { lastIndex: newLastIndex, limit, productLimit, total: totalGroups, returned, hasMore }
    }, 'Home Layout fetched successfully'));
});

const getWebsiteHomeLayoutAdmin = asyncHandler(async (req, res) => {
    let latestLayout = await WebsiteHome.findOne({ active: true })
        .populate({
            path: 'movingCategories',
            model: 'SubCategory',
            select: '_id name slug photos image'
        })
        .populate({
            path: 'groups',
            model: 'Group'
        })
        .exec();

    if (!latestLayout) {
        latestLayout = await WebsiteHome.create({
            active: true,
            banners: [],
            movingCategories: [],
            groups: []
        });
    }

    return res.status(200).json(
        new ApiResponse(200, latestLayout, "Website Home Layout fetched successfully")
    );
});

const updateWebsiteHomeLayoutAdmin = asyncHandler(async (req, res) => {
    const { banners, movingCategories, groups } = req.body;

    let latestLayout = await WebsiteHome.findOne({ active: true });
    if (!latestLayout) {
        latestLayout = await WebsiteHome.create({ active: true });
    }

    const updated = await WebsiteHome.findByIdAndUpdate(
        latestLayout._id,
        {
            banners: banners !== undefined ? banners : latestLayout.banners,
            movingCategories: movingCategories !== undefined ? movingCategories : latestLayout.movingCategories,
            groups: groups !== undefined ? groups : latestLayout.groups
        },
        { new: true }
    )
        .populate({
            path: 'movingCategories',
            model: 'SubCategory',
            select: '_id name slug photos image'
        })
        .populate({
            path: 'groups',
            model: 'Group'
        });

    sendRouteReloadNotification("/home/website");

    return res.status(200).json(
        new ApiResponse(200, updated, "Website Home Layout updated successfully")
    );
});

export {
    getWebsiteBanners,
    getWebsiteCategories,
    getWebsiteGroups,
    getWebGroupProductsPaginated,
    getHomeLayoutWebsite,
    getWebsiteHomeLayoutAdmin,
    updateWebsiteHomeLayoutAdmin
};
