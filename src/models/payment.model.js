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
        amount: { // total orderalue after the discount applied on subtotal, this will get updated if coupon/discount is applied on payment record
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
        couponCode: {
            type: String
        },
        method: {
            type: String,
            required: true
        },
        gateway: {
            type: String,
            enum: ["razorpay", "phonepe", "hdfc"],
            // default: "razorpay"
        },
        status: {
            type: String,
            enum: ["Pending", "Paid", "Cancelled"],
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
        phonepeOrderId: {
            type: String
        },
        phonepePaymentId: {
            type: String
        },
        phonepeRedirectUrl: {
            type: String
        },
        hdfcOrderId: {
            type: String
        },
        hdfcSessionId: {
            type: String
        },
        hdfcPaymentId: {
            type: String
        },
        hdfcRedirectUrl: {
            type: String
        },
        notes: {
            type: String
        },
        paidAt: {
            type: Date
        },
        refundId: {
            type: String
        },
        refundAmount: {
            type: Number,
            default: 0
        },
        refundStatus: {
            type: String,
            enum: ["None", "Pending", "Success", "Failed"],
            default: "None"
        },
        refundedAt: {
            type: Date
        },
        refundedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        },
        refundNotes: {
            type: String
        }
    },
    { timestamps: true }
);

paymentSchema.index({ orderId: 1 });
paymentSchema.index({ createdAt: -1 });

export const Payment = mongoose.model("Payment", paymentSchema);
