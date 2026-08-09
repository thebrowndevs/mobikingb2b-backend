import mongoose from "mongoose";
import { itemsSchema } from "./cart.model.js";
import { Counter } from "./counter.model.js";

const quotationSchema = new mongoose.Schema(
    {
        status: {
            type: String,
            enum: ["Accepted", "Rejected", "New", "Cancelled", "Hold", "Booked"],
            default: "New"
        },
        reservedStockRestored: {
            type: Boolean,
            default: false
        },
        isAppOrder: {
            type: Boolean,
            default: false
        },
        type: {
            type: String,
            enum: ["Regular", "Pos", "Manual"],
            default: "Regular"
        },
        method: {
            type: String,
            enum: ["COD", "Online", "UPI", "Cash", "Mixed"]
        },
        paymentMode: {
            type: String,
            enum: ["complete", "parcel"]
        },
        latitude: {
            type: Number
        },
        longitude: {
            type: Number
        },
        reason: { type: String },
        comments: { type: String },

        quotationId: {
            type: String,
            required: true,
            unique: true
        },

        // Pricing
        coupon: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Coupon",
        },
        couponCode: { type: String },
        couponType: { type: String },
        orderAmount: { type: Number, required: true },
        deliveryCharge: { type: Number, default: 0 },
        discount: { type: Number, default: 0 },
        gst: { type: String },
        subtotal: Number,

        // Customer Info
        name: String,
        email: String,
        phoneNo: String,

        // Address
        address: String,
        address2: String,
        city: String,
        state: String,
        pincode: String,
        country: String,
        addressId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Address"
        },

        // Relations
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        query: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Query"
        },

        // Order reference (populated when booked)
        orderRef: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order"
        },
        orderId: {
            type: String
        },

        // Product Items Details
        items: [itemsSchema],
        length: {
            type: Number,
            default: 19
        },
        breadth: {
            type: Number,
            default: 16
        },
        height: {
            type: Number,
            default: 6
        },
        weight: {
            type: Number,
            default: 0.5
        }
    },
    { timestamps: true }
);

quotationSchema.index({ createdAt: -1 });

quotationSchema.pre("validate", async function () {
    if (this.isNew && !this.quotationId) {
        const counter = await Counter.findOneAndUpdate(
            { _id: "quotationId" },
            { $inc: { seq: 1 } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();
        this.quotationId = `QT_${counter.seq}`;
        console.log("Quotation Id generated: ", this.quotationId);
    }
});

export const Quotation = mongoose.model("Quotation", quotationSchema);
