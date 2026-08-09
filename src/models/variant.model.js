import mongoose from "mongoose";

const purchaseSetSchema = new mongoose.Schema({
    price: {
        type: Number,
        required: true,
        min: 0,
        set: v => parseFloat(Number(v).toFixed(3)),
        validate: {
            validator: function (v) {
                return /^\d+(\.\d{3})?$/.test(v.toFixed(3));
            },
            message: props => `${props.value} is not valid. Must have exactly 3 decimal places.`
        }
    },
    quantity: {
        type: Number,
        required: true,
        default: 0
    },
    remainingStock: {
        type: Number,
        required: true,
        default: 0
    },
    availableStock: {
        type: Number,
        required: true,
        default: 0
    }
}, { timestamps: true });

const variantSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    name: {
        type: String,
        required: [true, "Variant name is required"]
    },
    images: [{
        type: String
    }],
    totalStock: {
        type: Number,
        default: 0
    },
    availableStock: {
        type: Number,
        default: 0
    },
    webVisibility: {
        type: Boolean,
        default: true
    },
    appVisibility: {
        type: Boolean,
        default: true
    },
    active: {
        type: Boolean,
        default: true
    },
    orderCount: {
        type: Number,
        default: 0
    },
    purchaseSets: [purchaseSetSchema]
}, { timestamps: true });

export const Variant = mongoose.model('Variant', variantSchema);
