import mongoose from "mongoose";

const replySchema = new mongoose.Schema(
    {
        message: {
            type: String,
            required: true
        },
        messagedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User", // Or "Admin" if using separate models
            required: true
        },
        messagedAt: {
            type: Date,
            default: Date.now
        }
    },
    { _id: false }
);

const querySchema = new mongoose.Schema(
    {
        raisedAt: {
            type: Date,
            default: Date.now
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order",
            // required: true
        },
        raisedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        assignedTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User" // Or "Admin" depending on your system
        },
        assignedAt: {
            type: Date
        },
        title: {
            type: String,
            required: true
        },
        description: {
            type: String,
            required: true
        },
        resolvedAt: {
            type: Date
        },
        isResolved: {
            type: Boolean,
            default: false
        },
        rating: {
            type: Number
        },
        review: {
            type: String
        },
        replies: [replySchema]
    },
    { timestamps: true }
);

export const Query = mongoose.model('Query', querySchema);