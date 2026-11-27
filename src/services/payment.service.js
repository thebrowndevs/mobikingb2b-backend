import mongoose from 'mongoose';
import { Order } from "../models/order.model.js";
import { Coupon } from "../models/coupon.model.js";
import { Stock } from "../models/stock.model.js";
import { Product } from "../models/product.model.js";
import { Cart } from "../models/cart.model.js";
import { User } from "../models/user.model.js";
import { Payment } from "../models/payment.model.js";
import { PaymentLink } from "../models/payment_link.model.js";
import { ApiError } from "../utils/ApiError.js";
import { STOCK_TYPES } from "../constants.js";

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

    // 3. Process Coupon usages — record appliedBy for ALL coupon types via array / flat field
    const legacyCouponIds = [];
    if (order?.couponsApplied && order.couponsApplied.length > 0) {
        order.couponsApplied.forEach(c => {
            if (c.couponId) legacyCouponIds.push(c.couponId);
        });
    } else if (order?.coupon) {
        legacyCouponIds.push(order.coupon);
    }

    for (const cId of legacyCouponIds) {
        let foundCoupon = await Coupon.findById(cId).session(session);
        if (foundCoupon) {
            // Idempotency guard: don't double-record the same user+order pair
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

export const confirmPaymentRecordPaidLogic =
    async (
        paymentId,
        razorpayPaymentId,
        session
    ) => {
        if (!paymentId) {
            throw new ApiError(
                400,
                "Payment ID is required."
            );
        }

        /*
         * Load exact internal Payment record.
         */
        const payment =
            await Payment.findById(
                paymentId
            ).session(session);

        if (!payment) {
            throw new ApiError(
                404,
                `Payment record not found: ${paymentId}`
            );
        }

        /*
         * Already Paid:
         * only allow an idempotent retry using the same
         * Razorpay payment ID.
         */
        if (
            payment.status ===
            "Paid"
        ) {
            if (
                razorpayPaymentId &&
                payment.razorpayPaymentId &&
                String(
                    payment.razorpayPaymentId
                ) !==
                String(
                    razorpayPaymentId
                )
            ) {
                throw new ApiError(
                    409,
                    "Payment is already Paid with a different Razorpay payment ID."
                );
            }

            const order =
                await Order.findById(
                    payment.orderRef
                ).session(
                    session
                );

            if (!order) {
                throw new ApiError(
                    404,
                    "Order not found for payment."
                );
            }

            return {
                payment,
                order,
                alreadyPaid:
                    true
            };
        }

        if (
            payment.status !==
            "Pending"
        ) {
            throw new ApiError(
                409,
                `Payment cannot be confirmed from status "${payment.status}".`
            );
        }

        /*
         * Atomic Pending -> Paid claim.
         */
        const lockedPayment =
            await Payment.findOneAndUpdate(
                {
                    _id:
                        payment._id,

                    status:
                        "Pending"
                },
                {
                    $set: {
                        status:
                            "Paid",

                        paidAt:
                            new Date(),

                        ...(razorpayPaymentId && {
                            paymentId: razorpayPaymentId,
                            ...(payment.gateway === "phonepe" || payment.phonepeOrderId ? { phonepePaymentId: razorpayPaymentId } : { razorpayPaymentId: razorpayPaymentId })
                        })
                    }
                },
                {
                    new:
                        true,
                    session
                }
            );

        if (!lockedPayment) {
            throw new ApiError(
                409,
                "Payment was already processed by another request."
            );
        }

        const order =
            await Order.findById(
                lockedPayment.orderRef
            ).session(
                session
            );

        if (!order) {
            throw new ApiError(
                404,
                "Order not found for payment."
            );
        }

        /*
         * Confirm Razorpay order mapping.
         */
        if (
            order.razorpayOrderId &&
            lockedPayment.razorpayOrderId &&
            String(
                order.razorpayOrderId
            ) !==
            String(
                lockedPayment.razorpayOrderId
            )
        ) {
            throw new ApiError(
                400,
                "Payment and order Razorpay order IDs do not match."
            );
        }

        if (
            [
                "Cancelled",
                "Rejected",
                "Returned"
            ].includes(
                order.status
            )
        ) {
            throw new ApiError(
                409,
                `Cannot confirm payment for order in ${order.status} status.`
            );
        }

        /*
         * Recalculate amount actually paid.
         */
        const paidPayments =
            await Payment.find({
                orderRef:
                    order._id,
                status:
                    "Paid"
            }).session(
                session
            );

        const totalPaid =
            paidPayments.reduce(
                (sum, p) =>
                    sum +
                    Number(
                        p.amount || 0
                    ),
                0
            );

        const normalizedTotalPaid =
            Number(
                totalPaid.toFixed(2)
            );

        const orderAmount =
            Number(
                order.orderAmount ||
                0
            );

        if (
            normalizedTotalPaid >
            orderAmount
        ) {
            throw new ApiError(
                400,
                `Total paid amount ₹${normalizedTotalPaid} exceeds order amount ₹${orderAmount}.`
            );
        }

        order.amountPaid =
            normalizedTotalPaid;

        order.remainingAmount =
            Math.max(
                0,
                Number(
                    (
                        orderAmount -
                        normalizedTotalPaid
                    ).toFixed(2)
                )
            );

        /*
         * Partial payment:
         * Payment is Paid, but order remains reserved.
         */
        if (
            order.remainingAmount >
            0
        ) {
            order.paymentStatus =
                "Pending";

            await order.save({
                session
            });

            return {
                payment:
                    lockedPayment,
                order,
                fullyPaid:
                    false
            };
        }

        /*
         * FULLY PAID
         *
         * There is intentionally NO stock adjustment here.
         *
         * The stock was already physically removed when the
         * online order was created.
         */

        order.abondonedOrder =
            false;

        order.paymentStatus =
            "Paid";

        order.paymentDate =
            order.paymentDate ||
            new Date();

        order.orderState =
            "Confirmed";

        order.remainingAmount =
            0;

        if (razorpayPaymentId) {
            order.razorpayPaymentId =
                razorpayPaymentId;
        }

        const nextOrderId = await Order.generateNextOrderId();
        order.orderId = nextOrderId;

        /*
         * RESERVED -> PURCHASE
         */
        if (
            order.stockIds?.length >
            0
        ) {
            await Stock.updateMany(
                {
                    _id: {
                        $in:
                            order.stockIds
                    },

                    orderRef:
                        order._id,

                    type:
                        STOCK_TYPES.RESERVED
                },
                {
                    $set: {
                        type:
                            STOCK_TYPES.PURCHASE,

                        orderId:
                            order.orderId
                    }
                },
                {
                    session
                }
            );
        }

        /*
         * COUPON: Record appliedBy for ALL coupon types on full payment.
         * This MUST run only on the fully-paid path to prevent recording
         * redemptions for abandoned / failed payments. Supports array & flat field.
         */
        const checkoutCouponIds = [];
        if (order.couponsApplied && order.couponsApplied.length > 0) {
            order.couponsApplied.forEach(c => {
                if (c.couponId) checkoutCouponIds.push(c.couponId);
            });
        } else if (order.coupon) {
            checkoutCouponIds.push(order.coupon);
        }

        for (const cId of checkoutCouponIds) {
            const couponDoc = await Coupon.findById(cId).session(session);
            if (couponDoc) {
                const alreadyLogged = couponDoc.appliedBy?.some(
                    c =>
                        c?.user?.toString() === order.userId?.toString() &&
                        c?.order?.toString() === order._id?.toString()
                );
                if (!alreadyLogged) {
                    couponDoc.appliedBy = [
                        ...(couponDoc.appliedBy || []),
                        { user: order.userId, order: order._id }
                    ];
                    await couponDoc.save({ session });
                }
            }
        }

        /*
         * Link Products -> Order.
         */
        const uniqueProductIds =
            [
                ...new Set(
                    order.items.map(
                        item =>
                            String(
                                item
                                    .productId
                                    ?._id ||
                                item.productId
                            )
                    )
                )
            ];

        if (
            uniqueProductIds.length >
            0
        ) {
            await Product.updateMany(
                {
                    _id: {
                        $in:
                            uniqueProductIds
                    }
                },
                {
                    $addToSet: {
                        orders:
                            order._id
                    }
                },
                {
                    session
                }
            );
        }

        /*
         * User -> Order.
         */
        await User.findByIdAndUpdate(
            order.userId,
            {
                $addToSet: {
                    orders:
                        order._id
                }
            },
            {
                session
            }
        );

        /*
         * Clear active user cart.
         */
        const userObj = await User.findById(order.userId).session(session);
        if (userObj?.cart) {
            const activeCart = await Cart.findById(userObj.cart).session(session);
            if (activeCart) {
                activeCart.items = [];
                activeCart.totalCartValue = 0;
                await activeCart.save({ session });
            }
        }

        await order.save({
            session
        });

        return {
            payment:
                lockedPayment,
            order,
            fullyPaid:
                true
        };
    };


// export const confirmPaymentRecordPaidLogic = async (paymentId, razorpayPaymentId, session) => {
//     let payment = await Payment.findById(paymentId).session(session);
//     if (!payment) {
//         throw new Error(`Payment record not found: ${paymentId}`);
//     }

//     if (payment.status === "Paid") {
//         console.log(`Payment record ${paymentId} already marked Paid.`);
//         const order = await Order.findById(payment.orderRef).session(session);
//         return { payment, order };
//     }

//     payment.status = "Paid";
//     payment.paidAt = new Date();
//     if (razorpayPaymentId) {
//         payment.paymentId = razorpayPaymentId;
//         payment.razorpayPaymentId = razorpayPaymentId;
//     }
//     await payment.save({ session });

//     const order = await Order.findById(payment.orderRef).session(session);
//     if (!order) {
//         throw new Error(`Order not found for payment: ${payment.orderRef}`);
//     }

//     const allPayments = await Payment.find({ orderRef: order._id, status: "Paid" }).session(session);
//     const totalPaid = allPayments.reduce((sum, p) => sum + p.amount, 0);

//     order.amountPaid = totalPaid;
//     order.remainingAmount = Math.max(0, order.orderAmount - totalPaid);

//     if (order.remainingAmount <= 0) {
//         order.paymentStatus = "Paid";
//         order.paymentDate = new Date();
//     } else {
//         order.paymentStatus = "Pending";
//     }

//     await order.save({ session });

//     console.log(`Payment record ${paymentId} successfully confirmed Paid. Order ${order._id} totals recalculated.`);
//     return { payment, order };
// };

/**
 * Marks all active Pending Payment and PaymentLink records for an order as Cancelled.
 */
export const cancelPendingPaymentsForOrder = async (order, session = null) => {
    if (!order?._id) return;

    const paymentFilter = {
        status: "Pending",
        $or: [
            { orderRef: order._id },
            ...(order.orderId ? [{ orderId: String(order.orderId) }] : [])
        ]
    };
    const opts = session ? { session } : {};

    await Payment.updateMany(paymentFilter, { $set: { status: "Cancelled" } }, opts);
    await PaymentLink.updateMany(
        { orderId: order._id, status: "Pending" },
        { $set: { status: "Cancelled" } },
        opts
    );
};

/**
 * Recalculates aggregate refundAmount and refundStatus on an Order from its Paid Payment records.
 */
export const recalculateOrderRefundTotals = async (order, latestRefundId = null, session = null) => {
    if (!order?._id) return order;
    const opts = session ? { session } : {};

    const allPaidPayments = await Payment.find({
        status: "Paid",
        $or: [
            { orderRef: order._id },
            ...(order.orderId ? [{ orderId: String(order.orderId) }] : [])
        ]
    }, null, opts).lean();

    const totalRefunded = parseFloat(
        allPaidPayments
            .filter(p => p.refundStatus !== "Failed")
            .reduce((sum, p) => sum + Number(p.refundAmount || 0), 0)
            .toFixed(2)
    );
    const totalPaid = Number(order.amountPaid || 0) ||
        parseFloat(allPaidPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0).toFixed(2));

    const anyPending = allPaidPayments.some(p => p.refundStatus === "Pending");
    const anyFailed = allPaidPayments.some(p => p.refundStatus === "Failed");

    order.refundAmount = totalRefunded;
    if (latestRefundId) {
        order.refundId = latestRefundId;
    }

    if (anyPending) {
        order.refundStatus = "Pending";
    } else if (totalRefunded <= 0 && anyFailed) {
        order.refundStatus = "Failed";
    } else if (totalRefunded >= totalPaid && totalPaid > 0) {
        order.refundStatus = "Success";
    } else if (totalRefunded > 0) {
        order.refundStatus = "Partial";
    }

    await order.save(opts);
    return order;
};

/**
 * Syncs a gateway refund webhook (Success or Failed) onto the matching Payment record and Order.
 */
export const syncRefundWebhookResult = async ({
    paymentFilter,
    orderFilter,
    refundId,
    refundAmount = 0,
    isSuccess
}) => {
    let payment = null;
    if (refundId) {
        payment = await Payment.findOne({ refundId });
    }
    if (!payment && paymentFilter) {
        payment = await Payment.findOne({ ...paymentFilter, status: "Paid" });
    }

    let order = null;
    if (payment?.orderRef) {
        order = await Order.findById(payment.orderRef);
    }
    if (!order && orderFilter) {
        order = await Order.findOne(orderFilter);
    }

    if (payment) {
        if (isSuccess) {
            // If already initiated as Pending with this refundId, don't double-add refundAmount
            if (payment.refundStatus === "Pending" && payment.refundId === refundId) {
                payment.refundStatus = "Success";
                payment.refundedAt = new Date();
            } else if (payment.refundId !== refundId) {
                const addAmt = Number(refundAmount || 0);
                payment.refundAmount = parseFloat((Number(payment.refundAmount || 0) + addAmt).toFixed(2));
                payment.refundId = refundId || payment.refundId;
                payment.refundStatus = "Success";
                payment.refundedAt = new Date();
            } else {
                payment.refundStatus = "Success";
            }
        } else {
            const failAmt = Number(refundAmount || 0);
            if (payment.refundStatus === "Pending" && failAmt > 0) {
                payment.refundAmount = Math.max(0, parseFloat((Number(payment.refundAmount || 0) - failAmt).toFixed(2)));
            }
            if (refundId) payment.refundId = refundId;
            payment.refundStatus = "Failed";
        }
        await payment.save();
    }

    if (order) {
        if (payment) {
            await recalculateOrderRefundTotals(order, refundId);
        } else {
            if (isSuccess) {
                if (order.refundStatus === "Pending" && order.refundId === refundId) {
                    order.refundStatus = Number(order.refundAmount || 0) >= Number(order.amountPaid || order.orderAmount || 0) ? "Success" : "Partial";
                } else if (order.refundId !== refundId) {
                    order.refundAmount = parseFloat((Number(order.refundAmount || 0) + Number(refundAmount || 0)).toFixed(2));
                    order.refundId = refundId || order.refundId;
                    order.refundStatus = order.refundAmount >= (order.amountPaid || order.orderAmount) ? "Success" : "Partial";
                }
                order.refundedAt = new Date();
            } else {
                if (order.refundStatus === "Pending" && Number(refundAmount || 0) > 0) {
                    order.refundAmount = Math.max(0, parseFloat((Number(order.refundAmount || 0) - Number(refundAmount || 0)).toFixed(2)));
                }
                if (refundId) order.refundId = refundId;
                order.refundStatus = "Failed";
            }
            await order.save();
        }
    }

    return { payment, order };
};
