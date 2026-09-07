import crypto from 'crypto';
import mongoose from 'mongoose';
import { Order } from '../../models/order.model.js';
import { PaymentLink } from '../../models/payment_link.model.js';
import { Payment } from '../../models/payment.model.js';
import { confirmPaymentRecordPaidLogic } from '../../services/payment.service.js';
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
        const foundPaymentLink = await PaymentLink.findOneAndUpdate(
            { paymentLink_id: paymentLinkId },
            { status },
            { new: true }
        );

        if (foundPaymentLink && foundPaymentLink.referenceId) {
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    await confirmPaymentRecordPaidLogic(foundPaymentLink.referenceId, payment?.id, session);
                });
                console.log(`Successfully confirmed B2B payment request via payment_link.paid: ${foundPaymentLink.referenceId}`);
                return res.status(200).json({ status: "Payment request confirmed successfully" });
            } catch (err) {
                console.error("Webhook processing error in confirmPaymentRecordPaidLogic:", err);
                return res.status(500).json({ error: err.message });
            } finally {
                session.endSession();
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

        const searchCriteria = [];
        if (razorpayOrderId) searchCriteria.push({ razorpayOrderId });
        if (paymentLinkId) searchCriteria.push({ paymentLinkId }, { razorpayOrderId: paymentLinkId });

        let paymentRecord = searchCriteria.length > 0 ? await Payment.findOne({ $or: searchCriteria }) : null;
        const order = razorpayOrderId ? await Order.findOne({ razorpayOrderId }) : null;

        if (!paymentRecord && order) {
            paymentRecord = await Payment.findOne({
                $or: [{ orderRef: order._id, status: "Pending" }, { orderRef: order._id }]
            });
        }

        if (paymentRecord) {
            if (paymentRecord.status === "Paid") {
                console.log(`Payment record ${paymentRecord._id} is already paid. Skipping webhook confirmation.`);
                return res.status(200).json({ status: "Already fulfilled" });
            }

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
        } else if (order) {
            if (order.paymentStatus === 'Paid') {
                console.log(`Order ${order._id} is already paid. Skipping webhook confirmation.`);
                return res.status(200).json({ status: "Already fulfilled" });
            }

            let isLinked = false;
            if (paymentLinkId) {
                const linkedPayment = await PaymentLink.findOneAndUpdate(
                    { paymentLink_id: paymentLinkId },
                    { status: "paid" },
                    { new: true }
                );
                if (linkedPayment) isLinked = true;
            }

            if (isLinked) {
                const paymentDate = new Date();
                order.abondonedOrder = false;
                order.paymentStatus = 'Paid';
                order.razorpayOrderId = razorpayOrderId;
                order.razorpayPaymentId = razorpayPaymentId;
                order.paymentDate = paymentDate;
                await order.save();
            }
        } else {
            console.warn(`Order or Payment record not found for razorpayOrderId: ${razorpayOrderId}`);
        }
    }
    else if (event === "refund.processed" || event === "refund.speed_processed") {
        const refund = payload?.refund?.entity;
        const paymentId = refund?.payment_id;
        const refundId = refund?.id;
        const refundAmount = refund?.amount ? refund.amount / 100 : 0;

        console.log(`Processing refund success webhook for payment: ${paymentId}, refundId: ${refundId}`);

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
    else if (event === "payment.failed") {
        const failedPayment = payload?.payment?.entity;
        const razorpayOrderId = failedPayment?.order_id;
        const razorpayPaymentId = failedPayment?.id;
        const errorCode = failedPayment?.error_code;
        const errorDesc = failedPayment?.error_description;
        const errorSource = failedPayment?.error_source;

        console.warn(
            `payment.failed: razorpayOrderId=${razorpayOrderId}, ` +
            `paymentId=${razorpayPaymentId}, error=${errorCode} — ${errorDesc}`
        );

        if (razorpayOrderId) {
            await Payment.findOneAndUpdate(
                { razorpayOrderId, status: "Pending" },
                {
                    $set: {
                        notes: `Payment failed: [${errorCode}] ${errorDesc} (source: ${errorSource || "unknown"}). ` +
                            `Razorpay payment ID: ${razorpayPaymentId || "N/A"}.`
                    }
                }
            );
        }
    }

    return res.status(200).json({ status: "Webhook verified and processed" });
});

/**
 * Universal PhonePe Webhook V2
 * Verifies base64 payload, checks signature checksum, and completes transaction.
 */
export const phonepeWebhookV2 = asyncHandler(async (req, res) => {
    console.log("phonepeWebhookV2 called");
    console.log("Body received:", req.body);

    const xVerify = req.headers["x-phonepe-checksum-signature"];

    if (!req.body || !xVerify) {
        console.error("Missing PhonePe webhook signature or response payload");
        return res.status(400).send("Invalid request structure");
    }

    const saltKey = process.env.PHONEPE_WEBHOOK_SECRET || process.env.PHONEPE_SALT_KEY || "099eb0cd-02cf-4e2a-8aca-3e6c6a4d20a4";

    // Calculate expected HMAC signature over raw/JSON stringified body
    const stringifiedBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const expectedHex = crypto
        .createHmac("sha256", saltKey)
        .update(stringifiedBody)
        .digest("hex");
    const expectedBase64 = crypto
        .createHmac("sha256", saltKey)
        .update(stringifiedBody)
        .digest("base64");

    if (expectedHex !== xVerify && expectedBase64 !== xVerify) {
        console.error("PhonePe Webhook signature mismatch. Expected Base64:", expectedBase64, "Received:", xVerify);
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
                    let paymentRecord = null;
                    if (isLinked) {
                        order = await Order.findById(isLinked.orderId).session(session);
                        if (isLinked.referenceId) {
                            paymentRecord = await Payment.findById(isLinked.referenceId).session(session);
                        }
                    } else {
                        order = await Order.findOne({ phonepeOrderId: merchantTransactionId }).session(session);
                        paymentRecord = await Payment.findOne({
                            $or: [
                                { phonepeOrderId: merchantTransactionId },
                                { paymentLinkId: merchantTransactionId }
                            ]
                        }).session(session);

                        if (!order && paymentRecord) {
                            order = await Order.findById(paymentRecord.orderRef).session(session);
                        }
                    }

                    if (order) {
                        order.phonepePaymentId = phonepePaymentId;
                        order.phonepeRawResponse = decoded;
                        order.phonepeUtr = utr;
                        order.phonepePaymentMode = paymentMode;
                        await order.save({ session });

                        if (!paymentRecord) {
                            paymentRecord = await Payment.findOne({
                                $or: [{ orderRef: order._id, status: "Pending" }, { orderRef: order._id }]
                            }).session(session);
                        }

                        if (paymentRecord) {
                            await confirmPaymentRecordPaidLogic(paymentRecord._id, phonepePaymentId, session);
                        } else if (isLinked) {
                            // Payment Link minimal confirmation
                            console.log(`Payment link match found for PhonePe webhook. Executing minimal confirmation.`);
                            order.abondonedOrder = false;
                            order.paymentStatus = 'Paid';
                            order.paymentDate = new Date();
                            await order.save({ session });
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
