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

    sendRouteReloadNotification("/home");
    sendRouteReloadNotification("/home/website");
    sendRouteReloadNotification("/home/categories");

    return res.status(201).json(
        new ApiResponse(201, formatHomeLayoutBanners(homeLayout), "Home layout created Successfully")
    );
});

const editHomeLayout = asyncHandler(async (req, res) => {
    let updates = req?.body;
    const homeId = req.params?._id;

    if (!homeId) {
        throw new ApiError(400, "Home Layout Id not found");
    }

    const foundHomeLayout = await Home.findById(homeId);

    if (!foundHomeLayout) {
        throw new ApiError(400, "Home Layout does not exist");
    }

    const updatedHomeLayout = await Home.findByIdAndUpdate(
        homeId,
        {
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

    sendRouteReloadNotification("/home");
    sendRouteReloadNotification("/home/website");
    sendRouteReloadNotification("/home/categories");

    return res.status(200).json(
        new ApiResponse(200, formatHomeLayoutBanners(updatedHomeLayout), "Home layout updated Successfully")
    );
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
            select: "_id fullName images regularPrice basePrice sellingPrice totalStock"
        })
        .populate({
            path: "parentCategories",
            model: "Category",
            select: "name _id image slug"
        })
        .lean();

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
});

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
});

export {
    createHome,
    editHomeLayout,
    getHomeLayout,
    getGroupsByCategoryAdmin,
    getHomeLayoutAdmin,
    getAllHomeLayout
};