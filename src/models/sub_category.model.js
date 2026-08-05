import mongoose from "mongoose";

const subCatgeorySchema = new mongoose.Schema({

    name: {
        type: String,
        required: true,
        unique: [true, "Name already exist"]
    },
    slug: {
        type: String,
        lowercase: true,
        required: true,
        unique: [true, "Slug already exist"]
    },
    tags: {
        type: [String],
        default: []
    },
    sequenceNo: {
        type: Number,
        default: 0
        // required: [true, "Sequence Number already exist"],
        // unique: [true, "Sequence Number must be Unique"]
    },
    icon: {
        type: String
    },
    upperBanner: {
        type: String,
        // keep it required - commented temporarily
        // required: [true, "Upper Banner already exist"]
    },
    lowerBanner: {
        type: String,
        // keep it required - commented temporarily
        // required: [true, "Lower Banner already exist"]
    },
    active: {
        type: Boolean,
        default: true
    },
    theme: {
        type: String,
        enum: ["light", "dark"],
        default: "light"
    },
    featured: {
        type: Boolean,
        default: false
    },
    deliveryCharge: {
        type: Number,
        default: 0
    },
    minOrderAmount: {
        type: Number,
        default: 0
    },
    minFreeDeliveryOrderAmount: {
        type: Number,
        default: 0
    },
    photos: [{
        type: String,
    }],
    parentCategory: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category',
        required: true
    },
    products: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    }]
}, { timestamps: true });

export const SubCategory = mongoose.model('SubCategory', subCatgeorySchema);