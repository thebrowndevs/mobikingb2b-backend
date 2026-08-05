import mongoose from "mongoose";
import { Order } from "../models/order.model.js";
import { restoreOrderStockLogic } from "../controllers/order.controller.js";
import { confirmOrderPaymentLogic } from "../services/payment.service.js";
import { checkRazorpayOrderStatus } from "../services/razorpay.service.js";
import { checkPhonepeOrderStatus } from "../services/phonepe.service.js";
import { PaymentLink } from "../models/payment_link.model.js";

/**
 * Job to find orders in 'Reserved' state for more than 15 minutes
 * with 'Pending' payment status, restore their stock, and mark them as 'Abandoned'.
 * If payment is found to have been completed on Razorpay or PhonePe, confirms the order instead.
 */
export const restoreReservedOrders = async () => {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    // const fifteenMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    console.log("🔍 Checking for reserved orders older than:", fifteenMinutesAgo.toISOString());

    const session = await mongoose.startSession();

    try {
        // Find orders: Reserved, Pending payment, Created > 15m ago, and stock not yet restored
        const ordersToRestore = await Order.find({
            orderState: "Reserved",
            paymentStatus: "Pending",
            createdAt: { $lt: fifteenMinutesAgo },
            _restockDone: { $ne: true }
        });

        console.log(`📦 Found ${ordersToRestore.length} orders to inspect.`);

        for (const order of ordersToRestore) {
            try {
                let isPaid = false;
                let paymentId = null;
                let rawResponse = null;
                let activeGateway = order.gateway;

                // Legacy fallback if gateway is not explicitly set
                if (!activeGateway) {
                    if (order.phonepeOrderId) {
                        activeGateway = "phonepe";
                    } else if (order.razorpayOrderId) {
                        activeGateway = "razorpay";
                    }
                }

                let utr = "";
                let paymentMode = "";

                if (activeGateway === "phonepe" && order.phonepeOrderId) {
                    console.log(`Checking PhonePe payment status for order: ${order.orderId} (PP ID: ${order.phonepeOrderId})`);
                    const ppStatus = await checkPhonepeOrderStatus(order.phonepeOrderId);
                    if (ppStatus.isPaid) {
                        isPaid = true;
                        paymentId = ppStatus.paymentId;
                        rawResponse = ppStatus.rawResponse;
                        utr = ppStatus.utr || "N/A";
                        paymentMode = ppStatus.paymentMode || "N/A";
                    }
                } else if (activeGateway === "razorpay" && order.razorpayOrderId) {
                    console.log(`Checking Razorpay payment status for order: ${order.orderId} (RP ID: ${order.razorpayOrderId})`);
                    const rzpStatus = await checkRazorpayOrderStatus(order.razorpayOrderId);
                    if (rzpStatus.isPaid) {
                        isPaid = true;
                        paymentId = rzpStatus.paymentId;
                    }
                }

                if (isPaid) {
                    console.log(`💰 Order ${order.orderId} was paid on ${activeGateway}! Confirming order...`);
                    await session.withTransaction(async () => {
                        // Check if this is a payment link order
                        const isLinked = await PaymentLink.findOne({ orderId: order._id }).session(session);

                        if (isLinked) {
                            console.log(`Order ${order.orderId} is linked to a PaymentLink. Executing minimal confirmation.`);
                            const paymentDate = new Date();
                            order.abondonedOrder = false;
                            order.paymentStatus = 'Paid';
                            order.paymentDate = paymentDate;
                            if (activeGateway === "phonepe") {
                                order.phonepePaymentId = paymentId;
                                order.phonepeRawResponse = rawResponse;
                                order.phonepeUtr = utr;
                                order.phonepePaymentMode = paymentMode;
                            } else {
                                order.razorpayPaymentId = paymentId;
                            }
                            await order.save({ session });
                        } else {
                            if (activeGateway === "phonepe") {
                                order.phonepePaymentId = paymentId;
                                order.phonepeRawResponse = rawResponse;
                                order.phonepeUtr = utr;
                                order.phonepePaymentMode = paymentMode;
                                await order.save({ session });
                                await confirmOrderPaymentLogic(
                                    order._id,
                                    null,
                                    null,
                                    session,
                                    order.userId
                                );
                            } else {
                                await confirmOrderPaymentLogic(
                                    order._id,
                                    order.razorpayOrderId,
                                    paymentId,
                                    session,
                                    order.userId
                                );
                            }
                        }
                    });
                    console.log(`✅ Order ${order.orderId} confirmed successfully via cron job.`);
                    continue; // Skip restocking/abandoning
                }

                // If not paid (or no Razorpay ID), proceed with restocking and abandoning
                console.log(`⏳ Restoring stock and abandoning order: ${order.orderId} (${order._id})`);
                await session.withTransaction(async () => {
                    // Restore stock using the logic extracted in the controller
                    await restoreOrderStockLogic(order._id, session);

                    // Update order state to Abandoned and mark as such
                    await Order.findByIdAndUpdate(
                        order._id,
                        {
                            orderState: "Abandoned",
                            abondonedOrder: true
                        },
                        { session }
                    );
                });
                console.log(`✅ Successfully restored and abandoned order: ${order.orderId}`);
            } catch (error) {
                console.error(`❌ Failed to process order ${order._id}:`, error.message);
            }
        }
    } catch (error) {
        console.error("❌ Error in restoreReservedOrders job:", error.message);
    } finally {
        session.endSession();
    }
};
