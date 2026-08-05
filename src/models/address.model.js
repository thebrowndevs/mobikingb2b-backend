import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    label: {
        type: String,
        required: true,
        // unique: [true, "Label already assigned"]
    },
    street: {
        type: String,
        required: true,
    },
    street2: {
        type: String,
    },
    city: {
        type: String,
        required: true,
    },
    state: {
        type: String,
        required: true,
    },
    country: {
        type: String,
        required: true,
        default: "India"
    },
    pinCode: {
        type: String,
        required: true,
    },
    latitude: {
        type: Number,
    },
    longitude: {
        type: Number,
    }
}, { timestamps: true });

export const Address = mongoose.model('Address', addressSchema);