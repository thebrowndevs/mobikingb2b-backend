import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
    {
        orderId: {
            type: String,
            required: true
        },
        orderRef: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order"
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        amount: {
            type: Number,
            required: true
        },
        subtotal: {
            type: Number,
            default: 0
        },
        discount: {
            type: Number,
            default: 0
        },
        coupon: {
            type: Number,
            default: 0
        },
        couponId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Coupon"
        },
        method: {
            type: String,
            required: true
        },
        status: {
            type: String,
            enum: ["Pending", "Paid"],
            default: "Pending"
        },
        paymentId: {
            type: String
        },
        paymentLinkId: {
            type: String
        },
        paymentLinkUrl: {
            type: String
        },
        razorpayOrderId: {
            type: String
        },
        razorpayPaymentId: {
            type: String
        },
        notes: {
            type: String
        },
        paidAt: {
            type: Date
        }
    },
    { timestamps: true }
);

paymentSchema.index({ orderId: 1 });
paymentSchema.index({ createdAt: -1 });

export const Payment = mongoose.model("Payment", paymentSchema);
