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
    active: {
        type: Boolean,
        default: true
    },
    deliveryCharge: {
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