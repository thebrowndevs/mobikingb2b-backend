import mongoose from "mongoose";
import { itemsSchema } from "./cart.model.js";

const replySchema = new mongoose.Schema({
    message: {
        type: String,
        required: true
    },
    messagedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    messagedAt: {
        type: Date,
        default: Date.now
    }
}, { _id: true });

const partialRequestSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: [
            "Partial Return"
        ]
    },
    isRaised: { type: Boolean, default: false },
    raisedAt: { type: String },
    isResolved: { type: Boolean, default: false },
    status: {
        type: String,
        enum: [
            "Pending",
            "Accepted",
            "Rejected",
            "Hold"
        ],
        default: "Pending"
    },
    resolvedAt: { type: String },
    resolvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    reopenedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    holdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    reopenedAt: { type: Date },
    holdAt: { type: Date },
    reason: { type: String },

    items: [itemsSchema],

    orderRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order'
    },
    returnOrderRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order'
    },
    cancelledReturnOrders: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order'
    }],
    replies: [replySchema]

}, { timestamps: true });

export const PartialRequests = mongoose.model("PartialRequest", partialRequestSchema);