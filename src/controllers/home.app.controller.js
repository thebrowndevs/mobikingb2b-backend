import { Group } from "../models/group.model.js";
import { Product } from "../models/product.model.js";
import { AppHomeTab } from "../models/appHomeTab.model.js";
import { Home } from "../models/home.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const getAppTabs = asyncHandler(async (req, res) => {
    const tabs = await AppHomeTab.find({ active: true })
        .sort({ sequenceNo: 1 })
        .select("name active sequenceNo header")
        .lean();

    return res.status(200).json(new ApiResponse(200, tabs || [], "App home tabs fetched successfully"));
});

const getAppTabGroups = asyncHandler(async (req, res) => {
    const { tabId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 2;
    const skip = (page - 1) * limit;

    const tab = await AppHomeTab.findById(tabId).select("groups").lean();
    if (!tab || !tab.groups || tab.groups.length === 0) {
        return res.status(200).json(new ApiResponse(200, { groups: [], pagination: { totalGroups: 0, page, limit, totalPages: 0 } }, "No groups found in this tab"));
    }

    const groupIds = tab.groups;
    const totalGroups = groupIds.length;
    const paginatedIds = groupIds.slice(skip, skip + limit);

    if (paginatedIds.length === 0) {
        return res.status(200).json(new ApiResponse(200, { groups: [], pagination: { totalGroups, page, limit, totalPages: Math.ceil(totalGroups / limit) } }, "Groups fetched successfully (empty page)"));
    }

    const groupsRaw = await Group.find({ _id: { $in: paginatedIds }, active: true })
        .select("name heading groupType placement bannerLink active appBanner isAppBannerVisible appBackgroundColor isAppBgColorVisible products")
        .lean();
    
    // Sort to match sequence order
    const idStrings = paginatedIds.map(id => id.toString());
    const groups = groupsRaw.sort((a, b) => idStrings.indexOf(a._id.toString()) - idStrings.indexOf(b._id.toString()));

    const groupsWithProducts = await Promise.all(
        groups.map(async (group) => {
            const productIds = group.products || [];
            const [products, totalProducts] = await Promise.all([
                Product.find({ _id: { $in: productIds }, active: true })
                    .select("fullName slug images minPrice maxPrice regularPrice basePrice sellingPrice totalStock moq")
                    .limit(6)
                    .lean(),
                Product.countDocuments({ _id: { $in: productIds }, active: true })
            ]);

            return {
                _id: group._id,
                name: group.name,
                heading: group.heading,
                groupType: group.groupType,
                placement: group.placement,
                bannerLink: group.bannerLink,
                appBanner: group.appBanner,
                isAppBannerVisible: group.isAppBannerVisible,
                appBackgroundColor: group.appBackgroundColor,
                isAppBgColorVisible: group.isAppBgColorVisible,
                products,
                totalProducts
            };
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
    }, "App tab groups fetched successfully"));
});

const getAppGroupProductsPaginated = asyncHandler(async (req, res) => {
    const { groupId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 12;
    const skip = (page - 1) * limit;

    const group = await Group.findById(groupId)
        .select("name heading placement active appBanner appBackgroundColor isAppBannerVisible isAppBgColorVisible bannerLink products")
        .lean();
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
        .select("fullName slug images minPrice maxPrice regularPrice basePrice sellingPrice totalStock moq")
        .lean();

    const idStrings = paginatedIds.map(id => id.toString());
    const sortedProducts = products.sort((a, b) => idStrings.indexOf(a._id.toString()) - idStrings.indexOf(b._id.toString()));

    return res.status(200).json(new ApiResponse(200, {
        groupInfo: {
            _id: group._id,
            name: group.name,
            heading: group.heading,
            placement: group.placement,
            appBanner: group.appBanner,
            isAppBannerVisible: group.isAppBannerVisible,
            appBackgroundColor: group.appBackgroundColor,
            isAppBgColorVisible: group.isAppBgColorVisible,
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

// Legacy App Categories endpoints supporting previous routes
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
    return res.status(200).json(new ApiResponse(200, groups, "Groups fetched successfully"));
});

const getGroupsByCategoryPaginated = asyncHandler(async (req, res) => {
    const { categoryId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(2, parseInt(req.query.limit, 10) || 2);
    const skip = (page - 1) * limit;

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
        return res.status(200).json(new ApiResponse(200, { groups: [], pagination: { totalGroups: 0, page, limit, totalPages: 0 } }, "No groups found"));
    }

    const matchingGroups = await Group.find({
        _id: { $in: homeGroups },
        categories: categoryId,
        active: true
    }).select("_id").lean().exec();

    const matchingIdsStrings = matchingGroups.map(g => g._id.toString());
    const sortedMatchingIds = homeGroups.filter(id => id && matchingIdsStrings.includes(id.toString()));
    const totalGroups = sortedMatchingIds.length;
    const paginatedIds = sortedMatchingIds.slice(skip, skip + limit);

    if (paginatedIds.length === 0) {
        return res.status(200).json(new ApiResponse(200, { groups: [], pagination: { totalGroups, page, limit, totalPages: Math.ceil(totalGroups / limit) } }, "Groups fetched successfully"));
    }

    const groupsRaw = await Group.find({ _id: { $in: paginatedIds } })
        .populate({ path: "categories", model: "SubCategory", select: "_id name" })
        .populate({ path: "parentCategories", model: "Category", select: "name _id image slug" })
        .lean().exec();

    const paginatedIdsStrings = paginatedIds.map(id => id.toString());
    const groups = groupsRaw.sort((a, b) => paginatedIdsStrings.indexOf(a._id.toString()) - paginatedIdsStrings.indexOf(b._id.toString()));

    const groupsWithProducts = await Promise.all(
        groups.map(async (group) => {
            const productIds = group.products || [];
            const [products, totalProducts] = await Promise.all([
                Product.find({ _id: { $in: productIds }, active: true, totalStock: { $gt: 0 } })
                    .select("-orders -stock -groups -category")
                    .limit(6).lean().exec(),
                Product.countDocuments({ _id: { $in: productIds }, active: true, totalStock: { $gt: 0 } }).exec()
            ]);

            return { ...group, products, pagination: { totalProducts, limit: 6, totalPages: Math.ceil(totalProducts / 6) } };
        })
    );

    return res.status(200).json(new ApiResponse(200, {
        groups: groupsWithProducts,
        pagination: { totalGroups, page, limit, totalPages: Math.ceil(totalGroups / limit) }
    }, "Groups fetched successfully"));
});

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

    return res.status(200).json(new ApiResponse(200, latestLayout.categories, "Home categories fetched successfully"));
});

const getAppTabsAdmin = asyncHandler(async (req, res) => {
    const tabs = await AppHomeTab.find({})
        .sort({ sequenceNo: 1 })
        .populate('groups')
        .exec();

    return res.status(200).json(new ApiResponse(200, tabs || [], "App home tabs fetched for admin successfully"));
});

const createAppTabAdmin = asyncHandler(async (req, res) => {
    const { name, active, header, groups } = req.body;
    if (!name) {
        throw new ApiError(400, "Tab name is required");
    }

    const count = await AppHomeTab.countDocuments({});
    const newTab = await AppHomeTab.create({
        name,
        active: active !== undefined ? active : true,
        sequenceNo: count,
        header: header || {},
        groups: groups || []
    });

    return res.status(201).json(new ApiResponse(201, newTab, "App Home Tab created successfully"));
});

const updateAppTabAdmin = asyncHandler(async (req, res) => {
    const { tabId } = req.params;
    const { name, active, sequenceNo, header, groups } = req.body;

    const tab = await AppHomeTab.findById(tabId);
    if (!tab) {
        throw new ApiError(404, "App Home Tab not found");
    }

    const updatedTab = await AppHomeTab.findByIdAndUpdate(
        tabId,
        {
            name: name !== undefined ? name : tab.name,
            active: active !== undefined ? active : tab.active,
            sequenceNo: sequenceNo !== undefined ? sequenceNo : tab.sequenceNo,
            header: header !== undefined ? header : tab.header,
            groups: groups !== undefined ? groups : tab.groups
        },
        { new: true }
    ).populate('groups');

    return res.status(200).json(new ApiResponse(200, updatedTab, "App Home Tab updated successfully"));
});

const deleteAppTabAdmin = asyncHandler(async (req, res) => {
    const { tabId } = req.params;
    
    const tab = await AppHomeTab.findById(tabId);
    if (!tab) {
        throw new ApiError(404, "App Home Tab not found");
    }

    await AppHomeTab.findByIdAndDelete(tabId);

    return res.status(200).json(new ApiResponse(200, null, "App Home Tab deleted successfully"));
});

const reorderAppTabsAdmin = asyncHandler(async (req, res) => {
    const { orderedIds } = req.body; // array of string IDs
    if (!orderedIds || !Array.isArray(orderedIds)) {
        throw new ApiError(400, "orderedIds array is required");
    }

    await Promise.all(
        orderedIds.map((id, index) => 
            AppHomeTab.findByIdAndUpdate(id, { sequenceNo: index })
        )
    );

    return res.status(200).json(new ApiResponse(200, null, "App Home Tabs reordered successfully"));
});

export {
    getAppTabs,
    getAppTabGroups,
    getAppGroupProductsPaginated,
    getGroupsByCategory,
    getGroupsByCategoryPaginated,
    getHomeCategories,
    getAppTabsAdmin,
    createAppTabAdmin,
    updateAppTabAdmin,
    deleteAppTabAdmin,
    reorderAppTabsAdmin
};
