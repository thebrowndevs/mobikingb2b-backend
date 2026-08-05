import { Coupon } from "../models/coupon.model.js"; // adjust path as needed
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Order } from "../models/order.model.js";

// CREATE COUPON
export const createCoupon = asyncHandler(async (req, res) => {
    let { code, type, value, percent, startDate, endDate, active, phoneNumber, userId, isAdminOnly } = req.body;

    if (!code || (!value && !percent)) {
        throw new ApiError(400, "Code and either value or percent are required");
    }

    const couponExists = await Coupon.findOne({ code });
    if (couponExists) {
        throw new ApiError(409, "Coupon code already exists");
    }

    if (type === "oneTimeUser") {
        isAdminOnly = true;
    }

    // Convert empty string userId to undefined to prevent Mongoose BSON casting errors
    const cleanedUserId = (userId && userId.trim() !== "") ? userId : undefined;

    const newCoupon = await Coupon.create({
        code, type, value, percent,
        startDate, endDate, active,
        phoneNumber, userId: cleanedUserId,
        isAdminOnly
    });

    return res
        .status(201)
        .json(new ApiResponse(201, newCoupon, "Coupon created successfully"));
});

// UPDATE COUPON
export const updateCoupon = asyncHandler(async (req, res) => {
    const { id, code, type, value, percent, startDate, endDate, active, phoneNumber, userId, isAdminOnly } = req.body;

    const coupon = await Coupon.findById(id);
    if (!coupon) throw new ApiError(404, "Coupon not found");

    coupon.code = code || coupon.code;
    coupon.active = (active != undefined && (active == true || active == false)) ? active : coupon.active;
    coupon.type = type || coupon.type;
    coupon.value = value || coupon.value;
    coupon.percent = percent || coupon.percent;
    coupon.startDate = startDate;
    coupon.endDate = endDate;
    coupon.phoneNumber = phoneNumber !== undefined ? phoneNumber : coupon.phoneNumber;

    // Convert empty string userId to undefined to prevent Mongoose BSON casting errors
    if (userId !== undefined) {
        coupon.userId = (userId && userId.trim() !== "") ? userId : undefined;
    }

    if (coupon.type === "oneTimeUser") {
        coupon.isAdminOnly = true;
    } else {
        coupon.isAdminOnly = isAdminOnly !== undefined ? isAdminOnly : coupon.isAdminOnly;
    }

    const updated = await coupon.save();

    return res
        .status(200)
        .json(new ApiResponse(200, updated, "Coupon updated successfully"));
});

export const deleteCoupon = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const deleted = await Coupon.findByIdAndDelete(id);

    if (!deleted) throw new ApiError(404, "Coupon not found");

    return res
        .status(200)
        .json(new ApiResponse(200, deleted, "Coupon deleted successfully"));
});

// GET COUPON BY CODE
export const getCouponByCode = asyncHandler(async (req, res) => {
    const { code } = req.params;

    if (!code) throw new ApiError(400, "Coupon code is required");

    const coupon = await Coupon.findOne({ code, active: true });
    if (!coupon) throw new ApiError(404, "Coupon not found");

    return res
        .status(200)
        .json(new ApiResponse(200, coupon, "Coupon fetched successfully"));
});

// GET COUPON BY CODE
export const checkCouponValid = asyncHandler(async (req, res) => {
    const { code, paymentMethod } = req.params;
    const userId = req?.user?._id;

    console.log("params", paymentMethod, code)

    if (!code) throw new ApiError(400, "Coupon code is required");

    const coupon = await Coupon.findOne({ code, active: true });
    if (!coupon) throw new ApiError(404, "Coupon not found");

    if (coupon?.type == "online" && paymentMethod != coupon?.type) {
        throw new ApiError(400, "Coupon can only be applied if you pay online");
    }

    if (coupon?.type == "oneTime" && coupon?.appliedBy?.some(c => c?.user?.toString() == userId?.toString())) {
        throw new ApiError(400, "Coupon already redeemed once");
    }

    if (coupon?.type == "oneTimeUser") {
        if (!coupon?.userId) {
            throw new ApiError(400, "Coupon configuration error: user reference not specified");
        }
        if (coupon.userId.toString() !== userId.toString()) {
            throw new ApiError(400, "Invalid Coupon");
        }
        if (coupon?.appliedBy?.some(c => c?.user?.toString() == userId?.toString())) {
            throw new ApiError(400, "Coupon already redeemed once");
        }
    }

    if (coupon?.type == "firstTime") {
        const orders = await Order.find({ userId: req?.user?._id, abondonedOrder: false });

        if (req?.user?.orders?.length || (orders && orders?.length)) {
            throw new ApiError(400, "Coupon only applicable for first Time Users");
        }
    }

    return res
        .status(200)
        .json(new ApiResponse(200, coupon, "Coupon Validated successfully"));
});

// GET ALL COUPONS
export const getCoupons = asyncHandler(async (req, res) => {
    const coupons = await Coupon.find({ active: true, isAdminOnly: { $ne: true } }).sort({ createdAt: -1 });
    return res
        .status(200)
        .json(new ApiResponse(200, coupons, "Coupons fetched successfully"));
});

// GET ALL COUPONS FOR ADMIN
export const getAdminCoupons = asyncHandler(async (req, res) => {
    const {
        page = 1,
        limit = 10,
        startDate,
        endDate,
    } = req.query;

    const searchQuery = req?.query?.searchQuery?.trim();

    const parsedPage = Math.max(1, parseInt(page));
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (parsedPage - 1) * parsedLimit;

    const filter = {};

    // Date range filter
    if (startDate && endDate) {
        filter.createdAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate),
        };
    }

    // Search filter (code only)
    if (searchQuery) {
        const regex = new RegExp(searchQuery, "i");
        filter.$or = [
            { code: regex }
        ];
        delete filter['createdAt'];
    }

    const [coupons, totalCount] = await Promise.all([
        Coupon.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parsedLimit)
            .lean(),
        Coupon.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(totalCount / parsedLimit);

    return res.status(200).json(
        new ApiResponse(200, {
            coupons,
            pagination: {
                totalCount,
                totalPages,
                currentPage: parsedPage,
                limit: parsedLimit,
                hasNextPage: parsedPage < totalPages,
                hasPrevPage: parsedPage > 1,
            },
        }, "Admin coupons fetched successfully")
    );
});