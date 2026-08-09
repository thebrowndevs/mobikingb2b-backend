import mongoose from "mongoose";

const groupSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: [true, "Group name must be unique"]
    },
    slug: {
        type: String,
        required: true,
        unique: [true, "Group slug must be unique"]
    },
    groupType: {
        type: String,
        enum: ['categories', 'subcategories', 'products'],
        required: true
    },
    heading: {
        type: String,
        required: true
    },
    
    // Website specific styling
    webBanner: {
        type: String
    },
    isWebBannerVisible: {
        type: Boolean,
        default: false
    },
    webBackgroundColor: {
        type: String
    },
    isWebBgColorVisible: {
        type: Boolean,
        default: false
    },

    // Mobile App specific styling
    appBanner: {
        type: String
    },
    isAppBannerVisible: {
        type: Boolean,
        default: false
    },
    appBackgroundColor: {
        type: String
    },
    isAppBgColorVisible: {
        type: Boolean,
        default: false
    },

    bannerLink: {
        type: String
    },
    placement: {
        type: String,
        enum: ['grid', 'scroll'],
        default: 'scroll'
    },
    active: {
        type: Boolean,
        default: true
    },
    products: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
    }],
    categories: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubCategory'
    }],
    parentCategories: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category'
    }]
}, { timestamps: true });

export const Group = mongoose.model('Group', groupSchema);