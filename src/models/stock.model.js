import mongoose from "mongoose";

const stockSchema = new mongoose.Schema({
    vendor: {
        type: String,
        // required: true,
    },
    type: {
        type: String,
        enum: ["stock-in", "add-item", "remove-item", "return", "cancel", "reject", "purchase", "purchase-restore"]
    },
    orderId: {
        type: String,
    },
    isScratchy: {
        type: Boolean,
        default: false,
    },
    variantName: {
        type: String,
        required: true,
    },
    purchasePrice: {
        type: Number,
        // required: true,
    },
    quantity: {
        type: Number,
        required: true,
    },
    previousStock: {
        type: Number,
        // required: true,
    },
    updatedStock: {
        type: Number,
        // required: true,
    },
    orderRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
    },
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    }
}, { timestamps: true });

export const Stock = mongoose.model('Stock', stockSchema);