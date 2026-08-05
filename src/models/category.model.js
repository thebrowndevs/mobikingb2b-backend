import mongoose from "mongoose";

const catgeorySchema = new mongoose.Schema({

    name: {
        type: String,
        required: true,
        unique: [true, "Name already exist"]
    },
    image: {
        type: String,
        // required: true,
    },
    slug: {
        type: String,
        lowercase: true,
        required: true,
        unique: [true, "Slug already exist"]
    },
    active: {
        type: Boolean,
        default: true
    },
    subCategories: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubCategory',
        required: true
    }]

}, { timestamps: true });

export const Category = mongoose.model('Category', catgeorySchema);