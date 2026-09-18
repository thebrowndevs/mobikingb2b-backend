import mongoose from 'mongoose';

const appCategoryPageSchema = new mongoose.Schema({
    active: {
        type: Boolean,
        default: true
    },
    // banners: [{
    //     desktopUrl: {
    //         type: String
    //     },
    //     mobileUrl: {
    //         type: String
    //     },
    //     redirectUrl: {
    //         type: String
    //     }
    // }],
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
    }],
}, { timestamps: true });

export const AppCategoryPage = mongoose.model('AppCategoryPage', appCategoryPageSchema);