import mongoose from 'mongoose';

const appHomeTabSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    active: {
        type: Boolean,
        default: true
    },
    sequenceNo: {
        type: Number,
        default: 0
    },
    header: {
        upperBanner: { type: String },
        lowerBanner: { type: String },
        icon: { type: String },
        iconColor: { type: String },
        redirectUrl: { type: String }
    },
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group'
    }]
}, { timestamps: true });

export const AppHomeTab = mongoose.model('AppHomeTab', appHomeTabSchema);
