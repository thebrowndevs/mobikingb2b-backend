import mongoose from 'mongoose';

const websiteHomeSchema = new mongoose.Schema({
    active: {
        type: Boolean,
        default: true
    },
    banners: [{
        desktopUrl: {
            type: String,
            required: true
        },
        mobileUrl: {
            type: String,
            required: true
        },
        redirectUrl: {
            type: String
        }
    }],
    movingCategories: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubCategory'
    }],
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group'
    }]
}, { timestamps: true });

export const WebsiteHome = mongoose.model('WebsiteHome', websiteHomeSchema);
