import mongoose from 'mongoose';
import { Order } from "../models/order.model.js";
import { Coupon } from "../models/coupon.model.js";
import { Stock } from "../models/stock.model.js";
import { Product } from "../models/product.model.js";
import { Cart } from "../models/cart.model.js";
import { User } from "../models/user.model.js";

/**
 * Shared transaction logic to finalize and confirm a paid order.
 * Safe to call from verifyPayment, webhooks, or cron jobs.
 * Handles idempotency natively.
 */
export const confirmOrderPaymentLogic = async (orderId, razorpayOrderId, razorpayPaymentId, session, reqUserId) => {
    // 1. Fetch order populated with items
    let order = await Order.findById(orderId).session(session).populate('items.productId');
    if (!order) {
        throw new Error(`Order not found: ${orderId}`);
    }

    // 2. Atomic Lock / Idempotency Check: Mark order as Paid using findOneAndUpdate to prevent concurrent duplicate runs
    const lockedOrder = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: { $ne: 'Paid' } },
        { $set: { paymentStatus: 'Paid' } },
        { session, new: true }
    );

    if (!lockedOrder) {
        console.log(`Order ${order._id} already marked Paid. Skipping duplicate execution.`);
        return order;
    }

    order = lockedOrder;

    const userId = reqUserId || order.userId;

    // 3. Process Coupon usages
    if (order?.coupon) {
        let foundCoupon = await Coupon.findById(order?.coupon).session(session);
        if (foundCoupon?.type === "oneTime" || foundCoupon?.type === "oneTimeUser") {
            // Check if this user already applied the coupon to prevent double recording
            const alreadyLogged = foundCoupon.appliedBy?.some(
                c => c?.user?.toString() === userId?.toString() && c?.order?.toString() === order?._id?.toString()
            );
            if (!alreadyLogged) {
                foundCoupon.appliedBy = [
                    ...(foundCoupon?.appliedBy || []),
                    {
                        user: userId,
                        order: order?._id
                    }
                ];
                await foundCoupon.save({ session });
            }
        }
    }

    // 4. Update order state and transaction ids
    order.abondonedOrder = false;
    order.paymentStatus = 'Paid';
    if (razorpayOrderId) order.razorpayOrderId = razorpayOrderId;
    if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
    order.orderState = "Confirmed";

    // 5. Generate readable order ID
    const nextOrderId = await Order.generateNextOrderId();
    order.orderId = nextOrderId;

    // 6. Update associated stock logs
    const stockIds = order.stockIds || [];
    if (stockIds?.length > 0) {
        await Stock.updateMany(
            { _id: { $in: stockIds } },
            { $set: { orderId: order.orderId } },
            { session }
        );
    }

    // 7. Link products to order
    const uniqueProductIds = [
        ...new Set(order.items.map(it => it.productId?._id?.toString() || it.productId?.toString()))
    ].filter(Boolean);

    await Product.updateMany(
        { _id: { $in: uniqueProductIds } },
        { $push: { orders: order._id } },
        { session }
    );

    // 8. Clear user's cart
    const userObj = await User.findById(userId).session(session);
    if (userObj?.cart) {
        const cart = await Cart.findById(userObj.cart).session(session);
        if (cart) {
            cart.items = [];
            cart.totalCartValue = 0;
            await cart.save({ session });
        }
    }

    // 9. Save updated order status
    await order.save({ session });

    // 10. Update User orders array
    await User.findByIdAndUpdate(
        userId,
        { $addToSet: { orders: order._id } },
        { new: true, session }
    );

    return order;
};
