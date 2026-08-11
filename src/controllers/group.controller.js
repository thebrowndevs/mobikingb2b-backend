import mongoose from "mongoose";
import { Group } from "../models/group.model.js";
import { Product } from "../models/product.model.js";
import { sendRouteReloadNotification } from "../services/firebase.service.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Home } from "../models/home.model.js";

const createGroup = asyncHandler(async (req, res) => {
    const {
        name, slug, groupType, heading,
        webBanner, isWebBannerVisible, webBackgroundColor, isWebBgColorVisible,
        appBanner, isAppBannerVisible, appBackgroundColor, isAppBgColorVisible,
        bannerLink, placement, active,
        products, categories, parentCategories
    } = req.body;

    const groupHeading = heading || name;
    const groupName = name || groupHeading;
    const groupSlug = slug || groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    if (!groupName || !groupType || !groupHeading || !groupSlug) {
        throw new ApiError(400, "Required details (name/heading, groupType, slug) not found");
    }

    const newGroup = await Group.create({
        name: groupName,
        slug: groupSlug,
        groupType,
        heading: groupHeading,
        webBanner: webBanner || "",
        isWebBannerVisible: !!isWebBannerVisible,
        webBackgroundColor: webBackgroundColor || "",
        isWebBgColorVisible: !!isWebBgColorVisible,
        appBanner: appBanner || "",
        isAppBannerVisible: !!isAppBannerVisible,
        appBackgroundColor: appBackgroundColor || "",
        isAppBgColorVisible: !!isAppBgColorVisible,
        bannerLink: bannerLink || "",
        placement: placement || "scroll",
        active: active ?? true,
        products: products || [],
        categories: categories || [],
        parentCategories: parentCategories || []
    });

    if (!newGroup) {
        throw new ApiError(500, "Could not create group");
    }

    return res.status(201).json(
        new ApiResponse(201, newGroup, "Group created Successfully")
    );
});

const editGroup = asyncHandler(async (req, res) => {
    const {
        name, slug, groupType, heading,
        webBanner, isWebBannerVisible, webBackgroundColor, isWebBgColorVisible,
        appBanner, isAppBannerVisible, appBackgroundColor, isAppBgColorVisible,
        bannerLink, placement, active,
        products, categories, parentCategories
    } = req.body;

    if (!req?.params?._id) {
        throw new ApiError(400, "Details not found");
    }

    const foundGroup = await Group.findById(req?.params?._id);
    if (!foundGroup) {
        throw new ApiError(409, `Group not found`);
    }

    const groupHeading = heading || name || foundGroup.heading;
    const groupName = name || heading || foundGroup.name;
    const groupSlug = slug || foundGroup.slug || groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const updatedGroup = await Group.findByIdAndUpdate(
        req?.params?._id,
        {
            name: groupName,
            slug: groupSlug,
            groupType: groupType || foundGroup.groupType,
            heading: groupHeading,
            webBanner: webBanner !== undefined ? webBanner : foundGroup.webBanner,
            isWebBannerVisible: isWebBannerVisible !== undefined ? !!isWebBannerVisible : foundGroup.isWebBannerVisible,
            webBackgroundColor: webBackgroundColor !== undefined ? webBackgroundColor : foundGroup.webBackgroundColor,
            isWebBgColorVisible: isWebBgColorVisible !== undefined ? !!isWebBgColorVisible : foundGroup.isWebBgColorVisible,
            appBanner: appBanner !== undefined ? appBanner : foundGroup.appBanner,
            isAppBannerVisible: isAppBannerVisible !== undefined ? !!isAppBannerVisible : foundGroup.isAppBannerVisible,
            appBackgroundColor: appBackgroundColor !== undefined ? appBackgroundColor : foundGroup.appBackgroundColor,
            isAppBgColorVisible: isAppBgColorVisible !== undefined ? !!isAppBgColorVisible : foundGroup.isAppBgColorVisible,
            bannerLink: bannerLink !== undefined ? bannerLink : foundGroup.bannerLink,
            placement: placement || foundGroup.placement || "scroll",
            active: active !== undefined ? active : foundGroup.active,
            products: products !== undefined ? products : foundGroup.products,
            categories: categories !== undefined ? categories : foundGroup.categories,
            parentCategories: parentCategories !== undefined ? parentCategories : foundGroup.parentCategories
        },
        { new: true }
    );

    if (!updatedGroup) {
        throw new ApiError(500, "Could not edit group");
    }

    // Trigger silent route reload notifications in background
    sendRouteReloadNotification("/home/website");
    if (updatedGroup.categories && Array.isArray(updatedGroup.categories)) {
        updatedGroup.categories.forEach(catId => {
            if (catId) {
                sendRouteReloadNotification(`/home/groups/category/paginated/${catId.toString()}`);
            }
        });
    }

    return res.status(201).json(
        new ApiResponse(201, updatedGroup, "Group edited Successfully")
    );
});

const deleteGroup = asyncHandler(async (req, res) => {
    // const {
    //     name, sequenceNo, active, isBannerLinkActive,
    //     banner, bannerLink, isBannerVisble, isSpecial,
    //     backgroundColor, isBackgroundColorVisible,
    //     categories, parentCategories
    // } = req.body;

    //Validate details
    if (
        !req?.params?._id
    ) {
        throw new ApiError(400, "Group Id not found");
    }

    const foundGroup = await Group.findById(req?.params?._id);
    if (!foundGroup) {
        throw new ApiError(409, `Group not found`);
    }

    for (let p of foundGroup.products) {
        await Product.findByIdAndUpdate(
            p,
            {
                $pull: {
                    groups: foundGroup?._id
                }
            },
            { new: true }
        );
    }

    const allLayouts = await Home.find({})


    for (let home of allLayouts) {
        await Home.findByIdAndUpdate(
            home?._id,
            {
                $pull: {
                    groups: foundGroup?._id
                }
            },
            { new: true }
        );
    }

    const deletedGroup = await Group.findByIdAndDelete(foundGroup?._id);

    //edit group
    // const updatedGroup = await Group.findByIdAndUpdate(
    //     req?.params?._id,
    //     {
    //         name: name || foundGroup?.name,
    //         sequenceNo: sequenceNo ? sequenceNo : foundGroup?.sequenceNo || 0,
    //         active: active != undefined ? active : foundGroup?.active,
    //         isBannerLinkActive: isBannerLinkActive != undefined ? isBannerLinkActive : foundGroup?.isBannerLinkActive,
    //         isBannerVisble: isBannerVisble != undefined ? isBannerVisble : foundGroup?.isBannerVisble,
    //         isSpecial: isSpecial != undefined ? isSpecial : foundGroup?.isSpecial,
    //         banner: banner ? banner : foundGroup?.banner,
    //         bannerLink: bannerLink ? bannerLink : foundGroup?.bannerLink,
    //         categories: categories ? categories : foundGroup?.categories,
    //         parentCategories: parentCategories ? parentCategories : foundGroup?.parentCategories,
    //         backgroundColor: backgroundColor || foundGroup?.backgroundColor || "",
    //         isBackgroundColorVisible: isBackgroundColorVisible != undefined ? isBackgroundColorVisible : foundGroup?.isBackgroundColorVisible,
    //     },
    //     { new: true }
    // );
    // if (!updatedGroup) {
    //     throw new ApiError(500, "Could not edit group");
    // }

    // Trigger silent route reload notifications in background
    sendRouteReloadNotification("/home/website");
    if (foundGroup.categories && Array.isArray(foundGroup.categories)) {
        foundGroup.categories.forEach(catId => {
            if (catId) {
                sendRouteReloadNotification(`/home/groups/category/paginated/${catId.toString()}`);
            }
        });
    }

    //return response
    return res.status(201).json(
        new ApiResponse(200, deletedGroup, "Group deleted Successfully")
    )
});

const addProductInGroup = asyncHandler(async (req, res) => {
    const {
        productId, groupId
    } = req.body;

    //Validate details
    if (
        !productId || !groupId
    ) {
        throw new ApiError(400, "Details not found");
    }

    //Check if group and product exist
    const foundGroup = await Group.findById(groupId);
    if (!foundGroup) {
        throw new ApiError(409, `Group not found`);
    }

    const foundProduct = await Product.findById(productId);
    if (!foundProduct) {
        throw new ApiError(409, `Product not found`);
    }

    //check if product is already there in group
    if (foundProduct?.groups.some(gr => gr == groupId)) {
        throw new ApiError(409, `Product already present in group`);
    }

    //add product in group
    const updatedGroup = await Group.findByIdAndUpdate(
        groupId,
        {
            $push: {
                products: foundProduct?._id
            }
        },
        { new: true }
    ).populate("products").exec();
    if (!updatedGroup) {
        throw new ApiError(500, `Could not update group`);
    }

    //add group Id in product
    const updatedProduct = await Product.findByIdAndUpdate(
        productId,
        {
            $push: {
                groups: foundGroup?._id
            }
        },
        { new: true }
    ).populate("groups").exec(); //populate orders also
    if (!updatedProduct) {
        throw new ApiError(500, `Could not update group id in product`);
    }

    //return response
    return res.status(200).json(
        new ApiResponse(200, updatedGroup, "Product added in group successfully")
    )
});

const removeProductFromGroup = asyncHandler(async (req, res) => {
    const {
        productId, groupId
    } = req.body;

    //Validate details
    if (
        !productId || !groupId
    ) {
        throw new ApiError(400, "Details not found");
    }

    //Check if group and product exist
    const foundGroup = await Group.findById(groupId);
    if (!foundGroup) {
        throw new ApiError(409, `Group not found`);
    }

    const foundProduct = await Product.findById(productId);
    if (!foundProduct) {
        throw new ApiError(409, `Product not found`);
    }

    //check if product is already removed from group
    if (!foundProduct?.groups.some(gr => gr == groupId)) {
        throw new ApiError(409, `Product is not present in group`);
    }

    //add product in group
    const updatedGroup = await Group.findByIdAndUpdate(
        groupId,
        {
            $pull: {
                products: foundProduct?._id
            }
        },
        { new: true }
    ).populate("products").exec();
    if (!updatedGroup) {
        throw new ApiError(500, `Could not update group`);
    }

    //add group Id in product
    const updatedProduct = await Product.findByIdAndUpdate(
        productId,
        {
            $pull: {
                groups: foundGroup?._id
            }
        },
        { new: true }
    ).populate("groups").exec(); //populate orders also
    if (!updatedProduct) {
        throw new ApiError(500, `Could not update group id in product`);
    }

    //return response
    return res.status(200).json(
        new ApiResponse(200, updatedGroup, "Product removed from group successfully")
    )
});

// Controller for bulk updating products in group at group module
const syncGroupProducts = asyncHandler(async (req, res) => {
    const { groupId, products } = req.body;

    /* ------------------------------ 1. validation ----------------------------- */
    if (!groupId || !Array.isArray(products)) {
        throw new ApiError(400, "groupId and productIds[] are required");
    }

    // normalise IDs → ObjectIds & dedupe
    const desired = [
        ...new Set(products?.map(id => new mongoose.Types.ObjectId(id)))
    ];

    /* ------------------------------ 2. look‑ups ------------------------------- */
    const group = await Group.findById(groupId);
    if (!group) throw new ApiError(404, "Group not found");

    const current = group?.products?.map(id => id.toString());

    /* ------------------------------ 3. diff sets ------------------------------ */
    const desiredSet = new Set(desired.map(id => id.toString()));
    const currentSet = new Set(current);

    const productsToAdd = desired.filter(id => !currentSet.has(id.toString()));
    const productsToRemove = current.filter(id => !desiredSet.has(id));

    /* ------------------------ 4. verify product existence --------------------- */
    const count = await Product.countDocuments({ _id: { $in: desired } });
    if (count !== desired.length) {
        throw new ApiError(400, "One or more productIds are invalid");
    }

    /* ----------------------- 5. transactional bulk ops ----------------------- */
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            // 5a. update Group
            group.products = desired;          // overwrite to exact list
            await group.save({ session });

            // 5b. add groupId to each new Product
            if (productsToAdd.length) {
                await Product.updateMany(
                    { _id: { $in: productsToAdd } },
                    { $addToSet: { groups: group._id } },
                    { session }
                );
            }

            // 5c. pull groupId from removed Products
            if (productsToRemove.length) {
                await Product.updateMany(
                    { _id: { $in: productsToRemove } },
                    { $pull: { groups: group._id } },
                    { session }
                );
            }
        });
    } finally {
        await session.endSession();
    }

    /* ------------------------------ 6. response ------------------------------- */
    const populatedGroup = await Group.findById(groupId)
        .populate("products")
        .exec();

    return res
        .status(200)
        .json(new ApiResponse(200, populatedGroup, "Group products synced"));
});

const getAllGroups = asyncHandler(async (req, res) => {
    const allGroups = await Group.find({})
        .populate("categories")
        .populate({
            path: 'parentCategories',
            model: 'Category',
            select: 'name _id slug image'
        })
        .populate({
            path: 'products',
            model: 'Product',
            select: '-orders -stock'
        })
        .exec();

    if (!allGroups) {
        throw new ApiError(409, "Could not find groups");
    }

    return res.status(200).json(
        new ApiResponse(200, allGroups, "Groups fetched Successfully")
    );
});

const getAllGroupsAdmin = asyncHandler(async (req, res) => {
    let { page = 1, limit = 10, searchQuery = "" } = req.query;

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    const query = {};
    if (searchQuery) {
        query.$or = [
            { name: { $regex: searchQuery, $options: "i" } },
            { heading: { $regex: searchQuery, $options: "i" } }
        ];
    }

    const totalGroups = await Group.countDocuments(query);
    const totalPages = Math.ceil(totalGroups / limit);
    const skip = (page - 1) * limit;

    const groups = await Group.find(query)
        .populate({
            path: "categories",
            model: "SubCategory",
            select: "name slug"
        })
        .populate({
            path: 'parentCategories',
            model: 'Category',
            select: 'name slug'
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

    return res.status(200).json(
        new ApiResponse(200, {
            groups,
            pagination: {
                totalGroups,
                totalPages,
                currentPage: page,
                limit,
                hasMore: page < totalPages
            }
        }, "Groups fetched successfully")
    );
});

const getSpecialGroups = asyncHandler(async (req, res) => {
    const allGroups = await Group.find({ isSpecial: true })
        .populate("categories")
        .populate({
            path: 'parentCategories',
            model: 'Category',
            select: 'name _id slug image'
        })
        .populate({
            path: 'products',
            model: 'Product',
            select: '-orders -stock'
        })
        .exec();

    if (!allGroups) {
        throw new ApiError(409, "Could not find groups");
    }

    return res.status(200).json(
        new ApiResponse(200, allGroups, "Groups fetched Successfully")
    )
});

const getGroupsByCategories = asyncHandler(async (req, res) => {

    const { category } = req?.params;
    if (!category) {
        throw new ApiError("Category Id not found");
    }

    const allGroups = await Group.find({
        categories: { $in: category }
    }
    ).populate("categories")
        .populate({
            path: 'parentCategories',
            model: 'Category',
            select: 'name _id slug image'
        })
        .populate({
            path: 'products',
            model: 'Product',
            select: '-orders -stock'
        })
        .exec();

    if (!allGroups) {
        throw new ApiError(409, "Could not find groups");
    }

    return res.status(200).json(
        new ApiResponse(200, allGroups, "Groups fetched Successfully")
    )
});

const getGroupProductsById = asyncHandler(async (req, res) => {
    const { _id } = req?.params ?? {};
    if (!_id) {
        throw new ApiError(400, 'Valid Group Id not found');
    }

    // parse cursor params
    const lastIndex = Math.max(-1, parseInt(req.query.lastIndex, 10) || -1); // -1 => start
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 14)); // cap limit
    const start = lastIndex + 1;

    // ensure _id is an ObjectId instance
    const groupObjectId = mongoose.isValidObjectId(_id)
        ? (typeof _id === 'string' ? new mongoose.Types.ObjectId(_id) : _id)
        : null;

    if (!groupObjectId) {
        throw new ApiError(400, 'Invalid Group Id');
    }

    // 1) load group metadata
    const groupDoc = await Group.findById(groupObjectId)
        .select('-categories -parentCategories')
        .lean();

    if (!groupDoc) {
        throw new ApiError(404, 'Group not found');
    }

    const productIds = groupDoc.products || [];

    // 2) count matching active products
    const totalProducts = await Product.countDocuments({
        _id: { $in: productIds },
        active: true
    });

    // if nothing to return
    if (start >= totalProducts) {
        return res.status(200).json(
            new ApiResponse(200, {
                group: {
                    _id: groupDoc?._id,
                    name: groupDoc?.name,
                    heading: groupDoc?.heading,
                    webBanner: groupDoc?.webBanner,
                    isWebBannerVisible: groupDoc?.isWebBannerVisible,
                    webBackgroundColor: groupDoc?.webBackgroundColor,
                    isWebBgColorVisible: groupDoc?.isWebBgColorVisible,
                    appBanner: groupDoc?.appBanner,
                    isAppBannerVisible: groupDoc?.isAppBannerVisible,
                    appBackgroundColor: groupDoc?.appBackgroundColor,
                    isAppBgColorVisible: groupDoc?.isAppBgColorVisible,
                    banner: groupDoc?.webBanner || groupDoc?.appBanner,
                    isBannerVisble: groupDoc?.isWebBannerVisible !== undefined ? groupDoc?.isWebBannerVisible : groupDoc?.isBannerVisble,
                    backgroundColor: groupDoc?.webBackgroundColor || groupDoc?.appBackgroundColor,
                    isBackgroundColorVisible: groupDoc?.isWebBgColorVisible !== undefined ? groupDoc?.isWebBgColorVisible : groupDoc?.isBackgroundColorVisible,
                    bannerLink: groupDoc?.bannerLink,
                    active: groupDoc?.active,
                },
                products: [],
                pagination: {
                    lastIndex,
                    limit,
                    total: totalProducts,
                    returned: 0,
                    hasMore: false
                }
            }, 'Group products fetched successfully')
        );
    }

    // 3) query products using standard Mongoose find sorted by totalStock descending default
    const products = await Product.find({
        _id: { $in: productIds },
        active: true
    })
        .select("-orders -stock -groups -category")
        .sort({ totalStock: -1, _id: 1 })
        .skip(start)
        .limit(limit)
        .lean()
        .exec();

    const returned = products.length;
    const newLastIndex = start + returned - 1;
    const hasMore = (start + returned) < totalProducts;

    return res.status(200).json(
        new ApiResponse(200, {
            group: {
                _id: groupDoc?._id,
                name: groupDoc?.name,
                heading: groupDoc?.heading,
                webBanner: groupDoc?.webBanner,
                isWebBannerVisible: groupDoc?.isWebBannerVisible,
                webBackgroundColor: groupDoc?.webBackgroundColor,
                isWebBgColorVisible: groupDoc?.isWebBgColorVisible,
                appBanner: groupDoc?.appBanner,
                isAppBannerVisible: groupDoc?.isAppBannerVisible,
                appBackgroundColor: groupDoc?.appBackgroundColor,
                isAppBgColorVisible: groupDoc?.isAppBgColorVisible,
                banner: groupDoc?.webBanner || groupDoc?.appBanner,
                isBannerVisble: groupDoc?.isWebBannerVisible !== undefined ? groupDoc?.isWebBannerVisible : groupDoc?.isBannerVisble,
                backgroundColor: groupDoc?.webBackgroundColor || groupDoc?.appBackgroundColor,
                isBackgroundColorVisible: groupDoc?.isWebBgColorVisible !== undefined ? groupDoc?.isWebBgColorVisible : groupDoc?.isBackgroundColorVisible,
                bannerLink: groupDoc?.bannerLink,
                active: groupDoc?.active,
            },
            products,
            pagination: {
                lastIndex: newLastIndex,
                limit,
                total: totalProducts,
                returned,
                hasMore
            }
        }, 'Group products fetched successfully')
    );
});

/*
// Original aggregation-based implementation:
const getGroupProductsById = asyncHandler(async (req, res) => {
    const { _id } = req?.params ?? {};
    if (!_id) {
        throw new ApiError(400, 'Valid Group Id not found');
    }

    // parse cursor params
    const lastIndex = Math.max(-1, parseInt(req.query.lastIndex, 10) || -1); // -1 => start
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 14)); // cap limit

    // ensure _id is an ObjectId instance for aggregation match
    const groupObjectId = mongoose.isValidObjectId(_id)
        ? (typeof _id === 'string' ? new mongoose.Types.ObjectId(_id) : _id)
        : null;

    if (!groupObjectId) {
        throw new ApiError(400, 'Invalid Group Id');
    }

    // 1) load group metadata and total products count
    const groupDoc = await Group.findById(groupObjectId)
        .select('-categories -parentCategories')
        .lean();

    if (!groupDoc) {
        throw new ApiError(404, 'Group not found');
    }

    const totalProducts = Array.isArray(groupDoc.products) ? groupDoc.products.length : 0;
    const start = lastIndex + 1;

    // if nothing to return
    if (start >= totalProducts) {
        return res.status(200).json(
            new ApiResponse(200, {
                group: {
                    _id: groupDoc?._id,
                    name: groupDoc?.name,
                    banner: groupDoc?.banner,
                    bannerLink: groupDoc?.bannerLink,
                    isBannerLinkActive: groupDoc?.isBannerLinkActive,
                    isBannerVisble: groupDoc?.isBannerVisble,
                    backgroundColor: groupDoc?.backgroundColor,
                    isBackgroundColorVisible: groupDoc?.isBackgroundColorVisible,
                    active: groupDoc?.active,
                },
                products: [],
                pagination: {
                    lastIndex,
                    limit,
                    total: totalProducts,
                    returned: 0,
                    hasMore: false
                }
            }, 'Group products fetched successfully')
        );
    }

    // 2) aggregation: slice group's products, lookup product docs in original order and exclude heavy fields
    const pipeline = [
        { $match: { _id: groupObjectId } },
        {
            $project: {
                products: { $slice: ['$products', start, limit] },
                name: 1, banner: 1, bannerLink: 1,
                isBannerLinkActive: 1, isBannerVisble: 1,
                backgroundColor: 1, isBackgroundColorVisible: 1,
                active: 1,
            }
        },

        // lookup product documents for sliced ids and preserve product order
        {
            $lookup: {
                from: 'products',
                let: { prodIds: '$products' },
                pipeline: [
                    { $match: { $expr: { $in: ['$_id', '$$prodIds'] } } },
                    { $addFields: { __order: { $indexOfArray: ['$$prodIds', '$_id'] } } },
                    { $sort: { __order: 1 } },
                    // limit also to `limit` just in case
                    { $limit: limit },
                    // exclude heavy/unwanted fields
                    { $project: { orders: 0, stock: 0, groups: 0, category: 0, categories: 0, __order: 0 } }
                ],
                as: 'products'
            }
        },

        // final projection: group metadata + products
        {
            $project: {
                name: 1, banner: 1, bannerLink: 1,
                isBannerLinkActive: 1, isBannerVisble: 1,
                backgroundColor: 1, isBackgroundColorVisible: 1,
                active: 1,
                products: 1
            }
        }
    ];

    const [aggResult = null] = await Group.aggregate(pipeline).exec();
    const products = (aggResult && Array.isArray(aggResult.products)) ? aggResult.products : [];

    const returned = products.length;
    const newLastIndex = start + returned - 1;
    const hasMore = (start + returned) < totalProducts;

    return res.status(200).json(
        new ApiResponse(200, {
            group: {
                _id: groupDoc?._id,
                name: groupDoc?.name,
                banner: groupDoc?.banner,
                bannerLink: groupDoc?.bannerLink,
                isBannerLinkActive: groupDoc?.isBannerLinkActive,
                isBannerVisble: groupDoc?.isBannerVisble,
                backgroundColor: groupDoc?.backgroundColor,
                isBackgroundColorVisible: groupDoc?.isBackgroundColorVisible,
                active: groupDoc?.active,
            },
            products,
            pagination: {
                lastIndex: newLastIndex,
                limit,
                total: totalProducts,
                returned,
                hasMore
            }
        }, 'Group products fetched successfully')
    );
});
*/

export {
    createGroup,
    editGroup,
    deleteGroup,
    addProductInGroup,
    removeProductFromGroup,
    syncGroupProducts,
    getAllGroups,
    getAllGroupsAdmin,
    getSpecialGroups,
    getGroupsByCategories,
    getGroupProductsById
}