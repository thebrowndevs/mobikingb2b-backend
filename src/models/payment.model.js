import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
    {
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order",
            required: true
        },
        amount: {
            type: Number,
            required: true
        },
        method: {
            type: String,
            enum: ["COD", "Online"],
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
