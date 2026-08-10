import mongoose from 'mongoose';

export const itemsSchema = new mongoose.Schema({
    index: Number,
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    product_id: String,
    variantId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Variant'
    },
    sku: {
        type: String,
    },
    fullName: {
        type: String,
    },
    basePrice: {
        type: String,
    },
    variantName: {
        type: String,
        required: true,
    },
    quantity: {
        type: Number,
        required: true,
        default: 1
    },
    purchasePrice: {
        type: Number
    },
    purchaseSetId: {
        type: String
    },
    discount: {
        type: Number,
        default: 0
    },
    discountPercent: {
        type: Number,
        default: 0
    },
    appliedSlab: {
        quantity: Number,
        price: Number
    },
    gst: {
        type: Number,
        default: 0
    },
    returnQuantity: {
        type: Number,
    },
    isScratchy: {
        type: Boolean,
        default: false,
    },
    price: {
        type: Number,
        required: true
    },
    isReturned: {
        type: Boolean
    },
    returnOrderRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order'
    },
    partialReturnRequest: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PartialRequest'
    },
    returnStatus: {
        type: String
    }
}, { _id: true }, { timestamps: true });

const cartSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    totalCartValue: {
        type: Number,
        required: true,
        default: 0
    },
    deliveryCharge: {
        type: Number,
        default: 0
    },
    discount: {
        type: Number,
        default: 0
    },
    items: [itemsSchema]
}, { timestamps: true });

export const Cart = mongoose.model('Cart', cartSchema);