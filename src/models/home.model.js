import mongoose from 'mongoose';

const homeSchema = new mongoose.Schema({
    active: {
        type: Boolean,
        default: true
    },
    banners: [{
        desktopUrl: {
            type: String
        },
        mobileUrl: {
            type: String
        },
        redirectUrl: {
            type: String
        }
    }],
    categories: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubCategory',
    }],
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
    }],
}, { timestamps: true });

export const Home = mongoose.model('Home', homeSchema);