import mongoose from "mongoose";
import crypto from "crypto";
import { Payment } from "../models/payment.model.js";
import { Coupon } from "../models/coupon.model.js";
import { Order } from "../models/order.model.js";
import { initiateRazorpayPayment, razorpayConfig } from "../services/razorpay.service.js";
import { confirmPaymentRecordPaidLogic } from "../services/payment.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

/* Get user's pending payments */
export const getPendingPayments = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) {
        throw new ApiError(401, "Unauthorized request.");
    }

    const matched = await Payment.aggregate([
        {
            $match: {
                userId: new mongoose.Types.ObjectId(userId),
                status: "Pending",
                method: {
                    $nin: [
                        "Cash", "COD", "Mixed",
                        "cash", "cod", "mixed"
                    ]
                }
            }
        },
        {
            $lookup: {
                from: "orders",
                localField: "orderRef",
                foreignField: "_id",
                as: "orderRef"
            }
        },
        {
            $unwind: "$orderRef"
        },
        {
            $match: {
                "orderRef.abondonedOrder": { $ne: true }
            }
        },
        {
            $project: {
                _id: 1
            }
        }
    ]);

    const validIds = matched.map(m => m._id);

    const pending = await Payment.find({ _id: { $in: validIds } })
        .populate({
            path: "orderRef",
            select: "orderId name phoneNo items orderAmount amountPaid remainingAmount paymentStatus subtotal discount deliveryCharge",
            // populate: {
            //     path: "items.productId",
            //     select: "name images"
            // }
        })
        .sort({ createdAt: -1 });

    const result = pending.map(p => ({
        paymentId: p._id,
        amount: p.amount,
        subtotal: p.subtotal,
        discount: p.discount,
        coupon: p.coupon,
        couponId: p.couponId,
        orderId: p.orderRef?._id,
        orderIdString: p.orderRef?.orderId,
        // items: p.orderRef?.items?.map(item => ({
        //     name: item.name || item.fullName || item.productId?.name || "Product Item",
        //     price: item.price || 0,
        //     quantity: item.quantity || 1,
        //     discount: item.discount || 0,
        //     imageUrl: item.productId?.images?.[0] || ""
        // })) || [],
        createdAt: p.createdAt,
        orderAmount: p.orderRef?.orderAmount || 0,
        amountPaid: p.orderRef?.amountPaid || 0,
        remainingAmount: p.orderRef?.remainingAmount || 0,
        paymentStatus: p.orderRef?.paymentStatus || "Pending",
        orderSubtotal: p.orderRef?.subtotal || 0,
        orderDiscount: p.orderRef?.discount || 0,
        orderDeliveryCharge: p.orderRef?.deliveryCharge || 0
    }));

    return res.status(200).json(
        new ApiResponse(200, result, "Pending payments fetched successfully.")
    );
});

/* Get single B2B payment by ID with populated order/product details */
export const getPaymentById = asyncHandler(async (req, res) => {
    const { paymentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(paymentId)) {
        throw new ApiError(400, "Invalid payment ID.");
    }

    const p = await Payment.findById(paymentId)
        .populate({
            path: "orderRef",
            select: "orderId name phoneNo items orderAmount amountPaid remainingAmount paymentStatus subtotal discount deliveryCharge",
            populate: {
                path: "items.productId",
                select: "name images"
            }
        });

    if (!p) {
        throw new ApiError(404, "Payment record not found.");
    }

    // Verify ownership
    if (p.userId?.toString() !== req.user?._id?.toString()) {
        throw new ApiError(403, "You do not have permission to access this payment.");
    }

    const result = {
        paymentId: p._id,
        amount: p.amount,
        subtotal: p.subtotal,
        discount: p.discount,
        coupon: p.coupon,
        couponId: p.couponId,
        orderId: p.orderRef?._id,
        orderIdString: p.orderRef?.orderId,
        items: p.orderRef?.items?.map(item => ({
            name: item.name || item.fullName || item.productId?.name || "Product Item",
            price: item.price || 0,
            quantity: item.quantity || 1,
            discount: item.discount || 0,
            imageUrl: item.productId?.images?.[0] || ""
        })) || [],
        createdAt: p.createdAt,
        orderAmount: p.orderRef?.orderAmount || 0,
        amountPaid: p.orderRef?.amountPaid || 0,
        remainingAmount: p.orderRef?.remainingAmount || 0,
        paymentStatus: p.orderRef?.paymentStatus || "Pending",
        orderSubtotal: p.orderRef?.subtotal || 0,
        orderDiscount: p.orderRef?.discount || 0,
        orderDeliveryCharge: p.orderRef?.deliveryCharge || 0,
        status: p.status,
        paidAt: p.paidAt,
        transactionId: p.paymentId || p.razorpayPaymentId
    };

    return res.status(200).json(
        new ApiResponse(200, result, "Payment details fetched successfully.")
    );
});

/* Create Razorpay order for B2B payment request */
export const createRazorpayOrderForPayment = asyncHandler(async (req, res) => {
    const { paymentId, couponCode } = req.body;

    if (!paymentId) {
        throw new ApiError(400, "Payment ID is required.");
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) {
        throw new ApiError(404, "Payment record not found.");
    }

    if (payment.status === "Paid") {
        throw new ApiError(400, "Payment has already been paid.");
    }

    let finalAmount = payment.amount;
    let couponDiscount = 0;
    let couponDoc = null;

    if (couponCode) {
        // Validate coupon code
        const coupon = await Coupon.findOne({ code: couponCode, active: true });
        if (!coupon) {
            throw new ApiError(404, "Coupon not found or inactive.");
        }

        // Run checks
        if (coupon.type === "oneTime" && coupon.appliedBy?.some(c => c.user?.toString() === req.user?._id?.toString())) {
            throw new ApiError(400, "Coupon already redeemed once.");
        }
        if (coupon.type === "oneTimeUser" && coupon.userId?.toString() !== req.user?._id?.toString()) {
            throw new ApiError(400, "Invalid coupon for this user.");
        }

        // Calculate discount
        if (coupon.percent) {
            couponDiscount = payment.amount * (parseFloat(coupon.percent) * 0.01);
            if (coupon.value && couponDiscount > coupon.value) {
                couponDiscount = coupon.value;
            }
        } else {
            couponDiscount = coupon.value || 0;
        }

        couponDiscount = Math.min(couponDiscount, finalAmount);
        finalAmount -= couponDiscount;
        couponDoc = coupon;
    }

    // Initiate Razorpay Order
    const razorpayOrder = await initiateRazorpayPayment(payment._id, finalAmount);

    // Save pending coupon/order details in payment doc
    payment.razorpayOrderId = razorpayOrder.id;
    if (couponDoc) {
        payment.coupon = couponDiscount;
        payment.couponId = couponDoc._id;
    }
    await payment.save();

    // Notes for verification/webhook: we must store paymentId, orderId, userId
    try {
        const razorpay = razorpayConfig();
        await razorpay.orders.edit(razorpayOrder.id, {
            notes: {
                paymentId: String(payment._id),
                orderId: String(payment.orderRef),
                userId: String(payment.userId)
            }
        });
    } catch (notesErr) {
        console.error("Failed to append Razorpay order notes:", notesErr);
    }

    return res.status(200).json(
        new ApiResponse(200, {
            gateway: "razorpay",
            razorpayOrderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            key: process.env.RAZORPAY_KEY_ID,
            couponDiscount
        }, "Razorpay order created for B2B payment request successfully.")
    );
});

/* Verify Razorpay Payment for Payment request */
export const verifyRazorpayPayment = asyncHandler(async (req, res) => {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
        throw new ApiError(400, "razorpay_payment_id, razorpay_order_id, and razorpay_signature are required.");
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    const generated_signature = crypto
        .createHmac("sha256", secret)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

    if (generated_signature !== razorpay_signature) {
        throw new ApiError(400, "Payment verification signature mismatch.");
    }

    // Find the associated payment record
    const payment = await Payment.findOne({ razorpayOrderId: razorpay_order_id });
    if (!payment) {
        throw new ApiError(404, "Associated payment record not found.");
    }

    const session = await mongoose.startSession();
    try {
        let updatedResult;
        await session.withTransaction(async () => {
            updatedResult = await confirmPaymentRecordPaidLogic(payment._id, razorpay_payment_id, session);
        });

        return res.status(200).json(
            new ApiResponse(200, updatedResult, "Payment verified and recorded successfully.")
        );
    } catch (err) {
        console.error("Verification error:", err);
        throw err;
    } finally {
        session.endSession();
    }
});
