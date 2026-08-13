import mongoose from "mongoose";

const activityLogSchema = new mongoose.Schema({
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order"
    },
    quotationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Quotation"
    },
    action: {
        type: String,
        required: true
    },
    remarks: {
        type: String,
        default: ""
    },
    performedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    performedByName: {
        type: String,
        default: ""
    },
    performedByRole: {
        type: String,
        default: ""
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

activityLogSchema.index({ orderId: 1 });
activityLogSchema.index({ quotationId: 1 });
activityLogSchema.index({ createdAt: -1 });

export const ActivityLog = mongoose.model("ActivityLog", activityLogSchema);
