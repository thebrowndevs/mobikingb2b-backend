import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema({
    mobile: {
        type: String,
        required: true,
        // unique: true,
    },
    code: {
        type: String,
        required: true,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
    verified: {
        type: Boolean,
        default: false,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 300 //auto delete after 5 mins of creation
    }
}, { timestamps: true });

export const OTP = mongoose.model('Otp', otpSchema);