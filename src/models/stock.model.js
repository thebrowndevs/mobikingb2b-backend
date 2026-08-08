import mongoose from "mongoose";

const stockSchema = new mongoose.Schema({
    vendor: {
        type: String,
        // required: true,
    },
    type: {
        type: String,
        enum: ["stock-in", "add-item", "remove-item", "return", "cancel", "reject", "purchase", "purchase-restore", "reserved", "hold", "cancelled", "rejected"]
    },
    category: {
        type: String,
        enum: ["physical", "virtual"],
        default: "virtual"
    },
    orderId: {
        type: String,
    },
    quotationId: {
        type: String,
    },
    quotationRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Quotation',
    },
    isScratchy: {
        type: Boolean,
        default: false,
    },
    variantId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Variant'
    },
    variantName: {
        type: String,
        required: true,
    },
    purchasePrice: {
        type: Number,
        min: 0,
        set: v => parseFloat(Number(v).toFixed(3)),
        validate: {
            validator: function (v) {
                return /^\d+(\.\d{3})?$/.test(v.toFixed(3));
            },
            message: props => `${props.value} is not valid. Must have exactly 3 decimal places.`
        }
    },
    sellingPrice: {
        type: Number,
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