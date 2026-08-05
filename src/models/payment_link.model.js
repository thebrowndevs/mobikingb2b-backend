import mongoose from "mongoose";

const paymentLinkSchema = new mongoose.Schema({
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order"
    },
    name: {
        type: String,
    },
    email: {
        type: String,
    },
    phoneNo: {
        type: String,
    },
    amount: {
        type: Number
    },
    paymentLink_id: {
        type: String,
    },
    referenceId: {
        type: String,
    },
    status: {
        type: String,
        default: "Pending"
    },
    link: {
        type: String,
    },
    gateway: {
        type: String,
        enum: ["razorpay", "phonepe"],
        required: false
    }
}, { timestamps: true });

export const PaymentLink = mongoose.model("PaymentLink", paymentLinkSchema);