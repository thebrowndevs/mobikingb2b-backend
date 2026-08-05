import mongoose from "mongoose";

const faqSchema = new mongoose.Schema({
    question: {
        type: String,
        required: [true, "FAQ Question is required"]
    },
    answer: {
        type: String,
        required: [true, "FAQ Answer is required"]
    }
});

const seoSchema = new mongoose.Schema({
    metaTitle: {
        type: String,
        trim: true
    },
    metaDescription: {
        type: String,
        trim: true
    },
    metaKeywords: {
        type: [String],
        default: []
    },
    canonicalUrl: {
        type: String,
        trim: true
    }
});

const blogSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, "Blog Title is required"],
        trim: true
    },
    slug: {
        type: String,
        required: [true, "Blog Slug is required"],
        unique: true,
        lowercase: true,
        trim: true
    },
    content: {
        type: String, // Rich text or HTML content
        required: [true, "Blog Content is required"]
    },
    excerpt: {
        type: String, // Short preview description
        trim: true
    },
    image: {
        type: String, // Featured image URL
    },
    author: {
        type: String,
        default: "Admin"
    },
    status: {
        type: String,
        enum: ["draft", "published"],
        default: "draft"
    },
    featured: {
        type: Boolean,
        default: false
    },
    active: {
        type: Boolean,
        default: true
    },
    categories: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category'
    }],
    subCategories: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubCategory'
    }],
    promotedProducts: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
    }],
    faqs: [faqSchema],
    seo: seoSchema
}, { timestamps: true });

export const Blog = mongoose.model('Blog', blogSchema);
