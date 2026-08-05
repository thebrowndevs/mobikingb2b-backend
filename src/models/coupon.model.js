import mongoose from "mongoose";

const couponSchema = new mongoose.Schema({
    active: {
        type: Boolean,
        default: true
    },
    code: {
        type: String,
        unique: true
    },
    value: {
        type: String,
    },
    percent: {
        type: String,
    },
    startDate: {
        type: Date,
    },
    endDate: {
        type: Date,
    },
    type: {
        type: String,
        enum: ['general', 'online', 'oneTime', 'firstTime', 'oneTimeUser']
    },
    phoneNumber: {
        type: String,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    isAdminOnly: {
        type: Boolean,
        default: false
    },
    appliedBy: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        order: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order'
        }
    }],
}, { timestamps: true });

export const Coupon = mongoose.model("Coupon", couponSchema);