import mongoose from "mongoose";

const brandSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "Brand name is required"],
        unique: [true, "Brand name already exist"]
    },
    active: {
        type: Boolean,
        default: true
    },
    image: {
        type: String,
    }
});

export const Brand = mongoose.model("Brand", brandSchema);