import mongoose from "mongoose";

const sellingPriceSchema = new mongoose.Schema({
    price: {
        type: Number,
        min: 0,
        set: v => parseFloat(Number(v).toFixed(3)), // Auto-round to 3 decimal places
        validate: {
            validator: function (v) {
                return /^\d+(\.\d{3})?$/.test(v.toFixed(3)); // Ensure exactly 3 decimal places
            },
            message: props => `${props.value} is not valid. Must have exactly 3 decimal places.`
        }
    }
}, { timestamps: true });

const productSchema = new mongoose.Schema({
    product_id: {
        type: Number,
    },
    sku: {
        type: String,
    },
    hsn: {
        type: String,
    },
    name: {
        type: String,
        // required: true,
    },
    fullName: {
        type: String,
        // required: true,
    },
    slug: {
        type: String,
        lowercase: true,
        // required: true,
        unique: [true, 'Slug must be unique']
    },
    description: {
        type: String,
        // required: true,
    },
    descriptionPoints: {
        type: [String],
    },
    keyInformation: {
        type: mongoose.Schema.Types.Mixed,
        default: []
    },
    tags: {
        type: [String],
        default: []
    },
    isChecked: {
        type: Boolean,
        default: false
    },
    stockCorrected: {
        type: Boolean,
        default: false
    },
    stockCorrected2: {
        type: Boolean,
        default: false
    },
    active: {
        type: Boolean,
        default: true
    },
    newArrival: {
        type: Boolean,
        default: false
    },
    liked: {
        type: Boolean,
        default: false
    },
    bestSeller: {
        type: Boolean,
        default: false
    },
    recommended: {
        type: Boolean,
        default: false
    },
    sellingPrice: [sellingPriceSchema],
    gst: {
        type: Number,
        default: 18
    },
    basePrice: {
        type: Number,
        min: 0,
        set: v => parseFloat(Number(v).toFixed(3)), // Auto-round to 3 decimal places
        validate: {
            validator: function (v) {
                return /^\d+(\.\d{3})?$/.test(v.toFixed(3)); // Ensure exactly 3 decimal places
            },
            message: props => `${props.value} is not valid. Must have exactly 3 decimal places.`
        }
    },
    regularPrice: {
        type: Number,
        min: 0,
        set: v => parseFloat(Number(v).toFixed(3)), // Auto-round to 3 decimal places
        validate: {
            validator: function (v) {
                return /^\d+(\.\d{3})?$/.test(v.toFixed(3)); // Ensure exactly 3 decimal places
            },
            message: props => `${props.value} is not valid. Must have exactly 3 decimal places.`
        }
    },
    rating: {
        type: Number,
        min: 0,
        max: 5,
        default: () => (Math.random() * (4.9 - 3.8) + 3.8).toFixed(1) // random between 3.8 - 4.9
    },
    reviewCount: {
        type: Number,
        default: () => Math.floor(Math.random() * (1000 - 100 + 1) + 100) // random between 100 - 1000
    },
    brand: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Brand',
    },
    category: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubCategory',
        required: [true, 'Category is required']
    },
    // variant array
    variants: {
        type: Map,
        of: Number,
        default: () => new Map()
    },
    // scratchy variant array
    scratchyVariants: {
        type: Map,
        of: Number,
        default: () => new Map()
    },
    images: [{
        type: String,
    }],
    totalStock: {
        type: Number,
        default: 0
    },
    scratchyStock: {
        type: Number,
        default: 0
    },
    stock: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Stock',
    }],
    orders: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
    }],
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
    }],

}, { timestamps: true });

export const Product = mongoose.model('Product', productSchema);