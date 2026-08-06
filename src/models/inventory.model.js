import mongoose from "mongoose";

const inventorySchema = new mongoose.Schema({
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
        unique: true
    },
    // The literal units present within your physical warehouse walls
    physicalStock: {
        type: Number,
        required: true,
        min: [0, 'Physical stock cannot be negative'],
        default: 0
    },
    // Stock locked by customer submitted quotation requests (pending admin approval)
    reservedStock: {
        type: Number,
        required: true,
        min: [0, 'Reserved stock cannot be negative'],
        default: 0
    },
    // Version number for optimistic locking to safeguard against multi-admin override bugs
    version: {
        type: Number,
        required: true,
        default: 0
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Real-time computed property for backend validation layers
inventorySchema.virtual('calculatedAvailableStock').get(function () {
    const available = this.physicalStock - this.reservedStock;
    return available < 0 ? 0 : available;
});

export const Inventory = mongoose.model('Inventory', inventorySchema);