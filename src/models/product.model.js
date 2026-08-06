import mongoose from "mongoose";

const sellingPriceSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["fixed", "variable"],
        required: true
    },
    slabs: [{
        quantity: {
            type: Number,
            required: true
        },
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
        }
    }]
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
    },
    fullName: {
        type: String,
    },
    slug: {
        type: String,
        lowercase: true,
        unique: [true, 'Slug must be unique']
    },
    description: {
        type: String,
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
    sellingPrice: {
        type: sellingPriceSchema,
        // required: true
    },
    minPrice: {
        type: Number,
        default: 0,
        set: v => parseFloat(Number(v).toFixed(3)),
        validate: {
            validator: function (v) {
                return /^\d+(\.\d{3})?$/.test(v.toFixed(3));
            },
            message: props => `${props.value} is not valid. Must have exactly 3 decimal places.`
        }
    },
    maxPrice: {
        type: Number,
        default: 0,
        set: v => parseFloat(Number(v).toFixed(3)),
        validate: {
            validator: function (v) {
                return /^\d+(\.\d{3})?$/.test(v.toFixed(3));
            },
            message: props => `${props.value} is not valid. Must have exactly 3 decimal places.`
        }
    },
    webVisibility: {
        type: Boolean,
        default: true
    },
    appVisibility: {
        type: Boolean,
        default: true
    },
    orderCount: {
        type: Number,
        default: 0
    },
    gst: {
        type: Number,
        default: 18
    },
    basePrice: {
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
    regularPrice: {
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
    rating: {
        type: Number,
        min: 0,
        max: 5,
        default: () => (Math.random() * (4.9 - 3.8) + 3.8).toFixed(1)
    },
    reviewCount: {
        type: Number,
        default: () => Math.floor(Math.random() * (1000 - 100 + 1) + 100)
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
    variants: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Variant'
    }],
    scratchyVariants: {
        type: Map,
        of: Number,
        default: () => new Map()
    },
    images: [{
        type: String,
    }],
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
    // --- NEW BULK WHOLESALE B2B PROPERTIES ---
    moq: {
        type: Number,
        required: [true, 'Minimum Order Quantity (MOQ) is required for B2B'],
        default: 10,
        min: [1, 'MOQ must be at least 1']
    },
    totalStock: {
        type: Number,
        default: 0,
        min: [0, 'Total stock cannot be negative']
    },
    availableStock: {
        type: Number,
        default: 0,
        min: [0, 'Available stock cannot be negative']
    },
    inventory: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Inventory'
    }
}, { timestamps: true });

export const Product = mongoose.model('Product', productSchema);
