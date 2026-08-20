import crypto from 'crypto';
import mongoose from 'mongoose';
import { Order } from '../../models/order.model.js';
import { PaymentLink } from '../../models/payment_link.model.js';
import { Payment } from '../../models/payment.model.js';
import { confirmOrderPaymentLogic } from '../../services/payment.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { logToFile } from '../../utils/logger.js';

/**
 * Universal Razorpay Webhook V2
 * Handles order.paid, payment.captured, and payment_link.paid events with idempotency checks.
 */
export const paymentWebhookV2 = asyncHandler(async (req, res) => {
    console.log("paymentWebhookV2 called");
    const secret = process.env.RAZORPAY_KEY_SECRET;

    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(JSON.stringify(req.body))
        .digest("hex");

    const signature = req.headers["x-razorpay-signature"];

    if (expectedSignature !== signature) {
        console.error("Webhook signature verification failed");
        return res.status(400).json({ error: "Invalid signature" });
    }

    const event = req.body.event;
    const payload = req.body.payload;

    if (event === "payment_link.paid") {
        const paymentLink = payload?.payment_link?.entity;
        const payment = payload?.payment?.entity;
        const paymentLinkId = paymentLink?.id;
        const status = paymentLink?.status;

        console.log("Processing payment_link.paid:", { paymentLinkId, status });

        // Update local PaymentLink status
        await PaymentLink.findOneAndUpdate(
            { paymentLink_id: paymentLinkId },
            { status },
            { new: true }
        );

        const orderId = paymentLink?.notes?.orderId;
        if (orderId) {
            const order = await Order.findById(orderId);
            if (order) {
                if (order.paymentStatus === 'Paid') {
                    console.log(`Order ${orderId} is already paid. Skipping webhook confirmation.`);
                    return res.status(200).json({ status: "Already fulfilled" });
                }

                // Perform minimal update only, as stock & coupons are pre-processed
                const paymentDate = new Date();
                await Order.findByIdAndUpdate(
                    order._id,
                    {
                        abondonedOrder: false,
                        razorpayOrderId: paymentLink?.order_id || order.razorpayOrderId,
                        razorpayPaymentId: payment?.id || order.razorpayPaymentId,
                        paymentStatus: "Paid",
                        paymentDate
                    },
                    { new: true }
                );
                console.log(`Successfully completed minimal confirmation for payment link order ${orderId}`);
            }
        }
    }
    else if (event === "order.paid" || event === "payment.captured") {
        let razorpayOrderId = null;
        let razorpayPaymentId = null;
        const paymentLinkId = payload?.payment?.entity?.payment_link_id;

        if (event === "order.paid") {
            razorpayOrderId = payload?.order?.entity?.id;
            razorpayPaymentId = payload?.payment?.entity?.id;
        } else {
            // payment.captured
            razorpayOrderId = payload?.payment?.entity?.order_id;
            razorpayPaymentId = payload?.payment?.entity?.id;
        }

        console.log(`Processing ${event}:`, { razorpayOrderId, razorpayPaymentId, paymentLinkId });

        if (razorpayOrderId) {
            const paymentRecord = await Payment.findOne({ razorpayOrderId });
            if (paymentRecord) {
                if (paymentRecord.status === "Paid") {
                    console.log(`Payment record ${paymentRecord._id} is already paid. Skipping webhook confirmation.`);
                    return res.status(200).json({ status: "Already fulfilled" });
                }

                const { confirmPaymentRecordPaidLogic } = await import("../../services/payment.service.js");
                const session = await mongoose.startSession();
                try {
                    await session.withTransaction(async () => {
                        await confirmPaymentRecordPaidLogic(paymentRecord._id, razorpayPaymentId, session);
                    });
                    console.log(`Webhook successfully confirmed B2B payment request: ${paymentRecord._id}`);
                    return res.status(200).json({ status: "Payment request confirmed successfully" });
                } catch (webhookErr) {
                    console.error("Webhook B2B payment confirmation failed:", webhookErr);
                    return res.status(500).json({ error: webhookErr.message });
                } finally {
                    session.endSession();
                }
            }

            const order = await Order.findOne({ razorpayOrderId });
            if (order) {
                if (order.paymentStatus === 'Paid') {
                    console.log(`Order ${order._id} is already paid. Skipping webhook confirmation.`);
                    return res.status(200).json({ status: "Already fulfilled" });
                }

                // Check if this payment was completed via a Payment Link
                let isLinked = false;
                if (paymentLinkId) {
                    const linkedPayment = await PaymentLink.findOneAndUpdate(
                        { paymentLink_id: paymentLinkId },
                        { status: "paid" },
                        { new: true }
                    );
                    if (linkedPayment) {
                        isLinked = true;
                        console.log(`Successfully mapped payment link ID: ${paymentLinkId} and updated status to paid.`);
                    }
                }

                // Fallback check if payment_link_id was not in the payload but link exists in DB
                if (!isLinked) {
                    const linkExists = await PaymentLink.findOne({ orderId: order._id });
                    if (linkExists) {
                        isLinked = true;
                        linkExists.status = "paid";
                        await linkExists.save();
                    }
                }

                if (isLinked) {
                    console.log(`Payment link match found. Executing minimal confirmation for order ${order._id}`);
                    const paymentDate = new Date();
                    order.abondonedOrder = false;
                    order.paymentStatus = 'Paid';
                    order.razorpayOrderId = razorpayOrderId;
                    order.razorpayPaymentId = razorpayPaymentId;
                    order.paymentDate = paymentDate;
                    await order.save();
                } else {
                    // Regular checkout order confirmation
                    const session = await mongoose.startSession();
                    try {
                        await session.withTransaction(async () => {
                            await confirmOrderPaymentLogic(
                                order._id,
                                razorpayOrderId,
                                razorpayPaymentId,
                                session,
                                order.userId
                            );
                        });
                        console.log(`Successfully confirmed checkout order ${order._id}`);
                    } catch (err) {
                        console.error(`Failed to confirm checkout order ${order._id}:`, err);
                        return res.status(500).json({ message: err.message });
                    } finally {
                        session.endSession();
                    }
                }
            } else {
                console.warn(`Order not found for razorpayOrderId: ${razorpayOrderId}`);
            }
        }
    }
    else if (event === "refund.processed" || event === "refund.speed_processed") {
        const refund = payload?.refund?.entity;
        const paymentId = refund?.payment_id;
        const refundId = refund?.id;
        const refundAmount = refund?.amount ? refund.amount / 100 : 0;

        console.log(`Processing refund success webhook for payment: ${paymentId}, refundId: ${refundId}`);
        // logToFile("refund_webhook.log", "RAZORPAY_REFUND_SUCCESS", {
        //     paymentId,
        //     refundId,
        //     refundAmount,
        //     event,
        //     payload: refund
        // });

        if (paymentId) {
            const order = await Order.findOne({ razorpayPaymentId: paymentId });
            if (order) {
                order.refundId = refundId;
                order.refundAmount = refundAmount;
                order.refundStatus = "Success";
                order.refundedAt = new Date();
                await order.save();
                console.log(`Updated refund status to Success for order: ${order.orderId}`);
            }
        }
    }
    else if (event === "refund.failed") {
        const refund = payload?.refund?.entity;
        const paymentId = refund?.payment_id;
        const refundId = refund?.id;

        console.log(`Processing refund failed webhook for payment: ${paymentId}, refundId: ${refundId}`);
        // logToFile("refund_webhook.log", "RAZORPAY_REFUND_FAILED", {
        //     paymentId,
        //     refundId,
        //     event,
        //     payload: refund
        // });

        if (paymentId) {
            const order = await Order.findOne({ razorpayPaymentId: paymentId });
            if (order) {
                order.refundId = refundId;
                order.refundStatus = "Failed";
                await order.save();
                console.log(`Updated refund status to Failed for order: ${order.orderId}`);
            }
        }
    }

    return res.status(200).json({ status: "Webhook verified and processed" });
});

/**
 * Universal PhonePe Webhook V2
 * Verifies base64 payload, checks signature checksum, and completes transaction.
 */
export const phonepeWebhookV2 = asyncHandler(async (req, res) => {
    // console.log("phonepeWebhookV2 called");
    // console.log("Headers received:", req.headers);
    // console.log("Body received:", req.body);

    const xVerify = req.headers["x-phonepe-checksum-signature"];

    if (!req.body || !xVerify) {
        console.error("Missing PhonePe webhook signature or response payload");
        return res.status(400).send("Invalid request structure");
    }

    const saltKey = process.env.PHONEPE_WEBHOOK_SECRET;

    // Calculate expected HMAC signature over raw/JSON stringified body
    const stringifiedBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const expectedSignature = crypto
        .createHmac("sha256", saltKey)
        .update(stringifiedBody)
        .digest("hex");

    if (expectedSignature !== xVerify) {
        console.error("PhonePe Webhook signature mismatch. Expected:", expectedSignature, "Received:", xVerify);
        return res.status(400).send("Invalid signature");
    }

    const decoded = req.body;
    logToFile("phonepe_webhook.log", `PHONEPE_EVENT_${decoded?.type || "UNKNOWN"}`, decoded);

    if (decoded.type === 'CHECKOUT_ORDER_COMPLETED' && decoded.payload?.state === 'COMPLETED') {
        const merchantTransactionId = decoded.payload?.merchantOrderId;
        const phonepePaymentId = decoded.payload?.orderId;
        const paymentInstrument = decoded.payload?.paymentDetails?.[0] || {};
        const utr = paymentInstrument.utr || "N/A";
        const paymentMode = paymentInstrument.paymentMode || paymentInstrument.type || "N/A";

        if (merchantTransactionId) {
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    // Check if it is a payment link
                    const isLinked = await PaymentLink.findOneAndUpdate(
                        { paymentLink_id: merchantTransactionId },
                        { status: "paid" },
                        { new: true, session }
                    );

                    let order = null;
                    if (isLinked) {
                        order = await Order.findById(isLinked.orderId).session(session);
                    } else {
                        order = await Order.findOne({ phonepeOrderId: merchantTransactionId }).session(session);
                    }

                    if (order) {
                        if (order.paymentStatus === 'Paid') {
                            console.log(`Order ${order._id} already marked Paid. Skipping webhook duplicate run.`);
                            return;
                        }

                        order.phonepePaymentId = phonepePaymentId;
                        order.phonepeRawResponse = decoded;
                        order.phonepeUtr = utr;
                        order.phonepePaymentMode = paymentMode;
                        await order.save({ session });

                        if (isLinked) {
                            // Payment Link minimal confirmation
                            console.log(`Payment link match found for PhonePe webhook. Executing minimal confirmation.`);
                            order.abondonedOrder = false;
                            order.paymentStatus = 'Paid';
                            order.paymentDate = new Date();
                            await order.save({ session });

                            if (isLinked.referenceId) {
                                await Payment.findByIdAndUpdate(
                                    isLinked.referenceId,
                                    {
                                        status: "Paid",
                                        paidAt: new Date(),
                                        notes: `Paid via PhonePe Link. Transaction ID: ${phonepePaymentId}`
                                    }
                                ).session(session);
                            }
                        } else {
                            // Standard checkout confirmation
                            await confirmOrderPaymentLogic(
                                order._id,
                                null,
                                null,
                                session,
                                order.userId
                            );
                        }
                    }
                });
            } finally {
                session.endSession();
            }
        }
    }
    else if (decoded.type === 'REFUND_COMPLETED' && decoded.payload?.state === 'COMPLETED') {
        const merchantTransactionId = decoded.payload?.originalMerchantOrderId || decoded.payload?.merchantOrderId;
        const refundId = decoded.payload?.refundId || decoded.payload?.transactionId;
        const refundAmount = decoded.payload?.amount ? decoded.payload.amount / 100 : 0;

        console.log(`Processing PhonePe refund success webhook: originalId=${merchantTransactionId}, refundId=${refundId}`);
        if (merchantTransactionId) {
            const order = await Order.findOne({ phonepeOrderId: merchantTransactionId });
            if (order) {
                order.refundId = refundId;
                order.refundAmount = refundAmount;
                order.refundStatus = "Success";
                order.refundedAt = new Date();
                await order.save();
                console.log(`Updated refund status to Success for PhonePe order: ${order.orderId}`);
            }
        }
    }
    else if (decoded.type === 'REFUND_FAILED') {
        const merchantTransactionId = decoded.payload?.originalMerchantOrderId || decoded.payload?.merchantOrderId;
        const refundId = decoded.payload?.refundId || decoded.payload?.transactionId;

        console.log(`Processing PhonePe refund failed webhook: originalId=${merchantTransactionId}, refundId=${refundId}`);
        if (merchantTransactionId) {
            const order = await Order.findOne({ phonepeOrderId: merchantTransactionId });
            if (order) {
                order.refundId = refundId;
                order.refundStatus = "Failed";
                await order.save();
                console.log(`Updated refund status to Failed for PhonePe order: ${order.orderId}`);
            }
        }
    }

    return res.status(200).json({ status: "Webhook received and verified" });
});
