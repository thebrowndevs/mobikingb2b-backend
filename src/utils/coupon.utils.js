import { Order } from "../models/order.model.js";
import { Payment } from "../models/payment.model.js";
import { ApiError } from "./ApiError.js";
import mongoose from "mongoose";

/**
 * Validate coupon validity criteria.
 * Throws ApiError if any validation check fails.
 */
export const validateCoupon = async ({ coupon, userId, order, isAdmin = false }) => {
    if (!coupon) throw new ApiError(404, "Coupon not found");
    if (!coupon.active) throw new ApiError(400, "Coupon is not active");

    const now = new Date();
    if (coupon.startDate && now < new Date(coupon.startDate)) {
        throw new ApiError(400, "Coupon is not yet active");
    }
    if (coupon.endDate && now > new Date(coupon.endDate)) {
        throw new ApiError(400, "Coupon has expired");
    }

    if (coupon.minCartValue && Number(order.subtotal) < Number(coupon.minCartValue)) {
        throw new ApiError(400, `Minimum cart value of Rs. ${coupon.minCartValue} is required to apply this coupon`);
    }

    // coupon.type === "online": For admin apply, should the online type restriction be bypassed?
    // User requested to comment this check out. Let's keep it commented out.
    /*
    if (coupon.type === "online" && !isAdmin) {
        // checks payment method
    }
    */

    if (coupon.type === "oneTime" && coupon.appliedBy?.some(c => c.user?.toString() === userId?.toString())) {
        throw new ApiError(400, "Coupon already redeemed once");
    }

    if (coupon.type === "oneTimeUser") {
        if (!coupon.userId) {
            throw new ApiError(400, "Coupon configuration error: user reference not specified");
        }
        if (coupon.userId.toString() !== userId.toString()) {
            throw new ApiError(400, "Invalid Coupon");
        }
        if (coupon.appliedBy?.some(c => c.user?.toString() === userId?.toString())) {
            throw new ApiError(400, "Coupon already redeemed once");
        }
    }

    if (coupon.type === "firstTime") {
        // Query to check if the user has any previous completed/non-abandoned orders
        const orders = await Order.find({ userId, abondonedOrder: false });
        if (orders && orders.length > 0) {
            throw new ApiError(400, "Coupon is only applicable for first-time users");
        }
    }

    if (order.couponsApplied && order.couponsApplied.length > 0) {
        throw new ApiError(400, "An active coupon is already applied to this order. Please remove it first.");
    }

    if (order.discount > 0) {
        throw new ApiError(400, "A global discount has already been applied. Cannot apply a coupon on top of a global discount.");
    }
};

/**
 * Calculates the coupon value based on order's subtotal.
 */
export const calculateCouponValue = ({ coupon, order }) => {
    const subtotal = Number(order.subtotal || 0);
    let discountedAmount = subtotal * (parseFloat(coupon.percent || 0) * 0.01);
    discountedAmount = parseFloat(discountedAmount.toFixed(2));
    if (coupon.value && discountedAmount >= parseFloat(coupon.value)) {
        discountedAmount = parseFloat(coupon.value);
    }
    return discountedAmount;
};

/**
 * Transactional helper to apply a coupon on an order document and optionally update payment.
 */
export const applyCouponToOrder = async ({ order, coupon, discountedAmount, session }) => {
    // 1. Push coupon to order.couponsApplied
    order.couponsApplied = [{
        couponId: coupon._id,
        appliedValue: discountedAmount,
        code: coupon.code,
        minCartValue: coupon.minCartValue,
        value: coupon.value,
        percent: coupon.percent
    }];

    // 2. Set order discount details
    order.discount = discountedAmount;
    order.discountPercent = parseFloat(((discountedAmount / (order.subtotal || 1)) * 100).toFixed(2));

    // 3. Recalculate order amount and remaining amount
    order.orderAmount = parseFloat((order.orderAmount - discountedAmount).toFixed(2));
    order.remainingAmount = parseFloat((order.remainingAmount - discountedAmount).toFixed(2));

    // 4. Lock order items and pricing
    order.couponLocked = true;

    // 5. Save order inside transaction session
    await order.save({ session });

    // 6. Find pending payment record
    const payment = await Payment.findOne({
        orderRef: order._id, status: "Pending",
        method: { $nin: ["mixed", "cash", "cod", "Mixed", "Cash", "COD"] }
    }).session(session);

    let paymentUpdated = false;
    if (payment) {
        const m = (payment.method || "").toLowerCase().trim();
        const discountVal = Number(discountedAmount);
        const amountVal = Number(payment.amount);

        // Criteria: payment method is not cash, cod, or mixed, discount is less than payment amount, and leaves at least 1 rupee
        if (
            m !== "cash" && m !== "cod" && m !== "mixed" &&
            discountVal < amountVal &&
            (amountVal - discountVal) >= 1
        ) {
            const resolvedSubtotal = (payment.subtotal && payment.subtotal > 0) ? payment.subtotal : (payment.amount + (payment.discount || 0));
            payment.subtotal = resolvedSubtotal;
            payment.discount = (payment.discount || 0) + discountVal;
            payment.amount = parseFloat((resolvedSubtotal - payment.discount).toFixed(2));
            payment.coupon = discountVal;
            payment.couponId = coupon._id;
            payment.couponCode = coupon.code;

            await payment.save({ session });
            paymentUpdated = true;
        }
    }

    return { paymentUpdated, payment };
};

/**
 * Transactional helper to remove a coupon from an order document and optionally revert payment.
 */
export const removeCouponFromOrder = async ({ order, paymentId, session }) => {
    if (!order.couponsApplied || order.couponsApplied.length === 0) {
        throw new ApiError(400, "No coupon applied to this order");
    }

    const appliedCouponEntry = order.couponsApplied[0];
    const appliedValue = Number(appliedCouponEntry.appliedValue || 0);

    // 1. Revert order amount & discount
    order.discount = 0;
    order.discountPercent = 0;
    order.orderAmount = parseFloat((order.orderAmount + appliedValue).toFixed(2));
    order.remainingAmount = parseFloat((order.remainingAmount + appliedValue).toFixed(2));

    // 2. Clear applied coupon info and release lock
    order.couponsApplied = [];
    order.couponLocked = false;

    // 3. Save order
    await order.save({ session });

    // 4. Check if we need to restore payment
    let payment = null;
    if (paymentId) {
        payment = await Payment.findOne({
            _id: paymentId,
            orderRef: order._id,
            status: "Pending",
            couponId: appliedCouponEntry.couponId
        }).session(session);
    } else {
        payment = await Payment.findOne({
            orderRef: order._id,
            status: "Pending",
            couponId: appliedCouponEntry.couponId
        }).session(session);
    }

    let paymentRestored = false;
    if (payment && payment.couponId) {
        const resolvedSubtotal = (payment.subtotal && payment.subtotal > 0) ? payment.subtotal : (payment.amount + (payment.discount || 0));
        payment.subtotal = resolvedSubtotal;
        // Subtract from payment discount and recalculate amount
        payment.discount = Math.max(0, (payment.discount || 0) - appliedValue);
        payment.amount = parseFloat((resolvedSubtotal - payment.discount).toFixed(2));

        payment.coupon = 0;
        payment.couponId = undefined;
        payment.couponCode = undefined;

        await payment.save({ session });
        paymentRestored = true;
    }

    return { paymentRestored, payment };
};
