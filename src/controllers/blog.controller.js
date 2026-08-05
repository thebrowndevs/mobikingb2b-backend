import mongoose from "mongoose";
import { Blog } from "../models/blog.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// @desc    Create a new blog
// @route   POST /api/v1/blogs/create
// @access  Private (Admin)
const createBlog = asyncHandler(async (req, res) => {
    const {
        title,
        slug,
        content,
        excerpt,
        image,
        author,
        status,
        featured,
        categories,
        subCategories,
        promotedProducts,
        faqs,
        seo
    } = req.body;

    if (!title || !slug || !content) {
        throw new ApiError(400, "Title, Slug, and Content are required fields");
    }

    // Check if slug is unique
    const existingBlog = await Blog.findOne({ slug: slug.toLowerCase() });
    if (existingBlog) {
        throw new ApiError(400, "A blog with this slug already exists");
    }

    const newBlog = await Blog.create({
        title,
        slug: slug.toLowerCase(),
        content,
        excerpt: excerpt || "",
        image: image || "",
        author: author || "Admin",
        status: status || "draft",
        featured: featured || false,
        categories: categories || [],
        subCategories: subCategories || [],
        promotedProducts: promotedProducts || [],
        faqs: faqs || [],
        seo: seo || {}
    });

    if (!newBlog) {
        throw new ApiError(500, "Failed to create blog post");
    }

    return res.status(201).json(
        new ApiResponse(201, newBlog, "Blog created successfully")
    );
});

// @desc    Update a blog post
// @route   PUT /api/v1/blogs/:_id
// @access  Private (Admin)
const updateBlog = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const {
        title,
        slug,
        content,
        excerpt,
        image,
        author,
        status,
        featured,
        active,
        categories,
        subCategories,
        promotedProducts,
        faqs,
        seo
    } = req.body;

    if (!_id) {
        throw new ApiError(400, "Blog ID is required");
    }

    const blog = await Blog.findById(_id);
    if (!blog) {
        throw new ApiError(404, "Blog post not found");
    }

    // Check slug uniqueness if it's changing
    if (slug && slug.toLowerCase() !== blog.slug) {
        const existingBlog = await Blog.findOne({ slug: slug.toLowerCase() });
        if (existingBlog) {
            throw new ApiError(400, "A blog with this slug already exists");
        }
    }

    const updatedBlog = await Blog.findByIdAndUpdate(
        _id,
        {
            $set: {
                title: title || blog.title,
                slug: slug ? slug.toLowerCase() : blog.slug,
                content: content || blog.content,
                excerpt: excerpt !== undefined ? excerpt : blog.excerpt,
                image: image !== undefined ? image : blog.image,
                author: author || blog.author,
                status: status || blog.status,
                featured: featured !== undefined ? featured : blog.featured,
                active: active !== undefined ? active : blog.active,
                categories: categories || blog.categories,
                subCategories: subCategories || blog.subCategories,
                promotedProducts: promotedProducts || blog.promotedProducts,
                faqs: faqs || blog.faqs,
                seo: seo || blog.seo
            }
        },
        { new: true }
    );

    if (!updatedBlog) {
        throw new ApiError(500, "Failed to update blog post");
    }

    return res.status(200).json(
        new ApiResponse(200, updatedBlog, "Blog updated successfully")
    );
});

// @desc    Delete a blog post
// @route   DELETE /api/v1/blogs/:_id
// @access  Private (Admin)
const deleteBlog = asyncHandler(async (req, res) => {
    const { _id } = req.params;

    if (!_id) {
        throw new ApiError(400, "Blog ID is required");
    }

    const deletedBlog = await Blog.findByIdAndDelete(_id);
    if (!deletedBlog) {
        throw new ApiError(404, "Blog post not found or already deleted");
    }

    return res.status(200).json(
        new ApiResponse(200, deletedBlog, "Blog deleted successfully")
    );
});

// @desc    Get a single blog by slug (SEO friendly)
// @route   GET /api/v1/blogs/slug/:slug
// @access  Public
const getBlogBySlug = asyncHandler(async (req, res) => {
    const { slug } = req.params;

    if (!slug) {
        throw new ApiError(400, "Slug is required");
    }

    const blog = await Blog.findOne({ slug: slug.toLowerCase() })
        .populate("categories", "name slug image active")
        .populate("subCategories", "name slug active parentCategory")
        .populate({
            path: "promotedProducts",
            select: "name fullName slug description images basePrice regularPrice active sellingPrice rating reviewCount variants totalStock",
            match: { active: true } // only load active promoted products
        });

    if (!blog) {
        throw new ApiError(404, "Blog post not found");
    }

    return res.status(200).json(
        new ApiResponse(200, blog, "Blog fetched successfully")
    );
});

// @desc    Get a single blog by ID (Admin panel preview/edit)
// @route   GET /api/v1/blogs/view/:_id
// @access  Public/Private
const getBlogById = asyncHandler(async (req, res) => {
    const { _id } = req.params;

    if (!_id) {
        throw new ApiError(400, "Blog ID is required");
    }

    const blog = await Blog.findById(_id)
        .populate("categories")
        .populate("subCategories")
        .populate("promotedProducts");

    if (!blog) {
        throw new ApiError(404, "Blog post not found");
    }

    return res.status(200).json(
        new ApiResponse(200, blog, "Blog details fetched successfully")
    );
});

// @desc    Get all blog slugs (Next.js build optimization)
// @route   GET /api/v1/blogs/slugs
// @access  Public
const getAllBlogSlugs = asyncHandler(async (req, res) => {
    // We only need published blogs for Next.js build-time generation
    const slugs = await Blog.find({ status: "published" })
        .select("slug updatedAt")
        .exec();

    return res.status(200).json(
        new ApiResponse(200, slugs, "Blog slugs fetched successfully")
    );
});

// @desc    Get blogs with infinite scroll pagination (page 1: 30 blogs, page > 1: 10 blogs)
// @route   GET /api/v1/blogs
// @access  Public
const getBlogsPaged = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const { search, category, subCategory, status, featured, active, author, startDate, endDate } = req.query;

    // Build filter query
    const filter = {};

    if (status) {
        if (status !== "all") {
            filter.status = status;
        }
    } else {
        filter.status = "published";
    }

    if (active !== undefined) {
        filter.active = active === "true";
    } else if (status !== "all") {
        // public default is only active blogs
        filter.active = true;
    }

    if (featured !== undefined) {
        filter.featured = featured === "true";
    }

    if (author) {
        filter.author = { $regex: author, $options: "i" };
    }

    if (startDate || endDate) {
        const dateFilter = {};
        if (startDate && !isNaN(Date.parse(startDate))) {
            dateFilter.$gte = new Date(startDate);
        }
        if (endDate && !isNaN(Date.parse(endDate))) {
            dateFilter.$lte = new Date(endDate);
        }
        if (Object.keys(dateFilter).length > 0) {
            filter.createdAt = dateFilter;
        }
    }

    if (category && mongoose.Types.ObjectId.isValid(category)) {
        filter.categories = category;
    }

    if (subCategory && mongoose.Types.ObjectId.isValid(subCategory)) {
        filter.subCategories = subCategory;
    }

    if (search) {
        filter.$or = [
            { title: { $regex: search, $options: "i" } },
            { excerpt: { $regex: search, $options: "i" } }
        ];
    }

    // Determine pagination limit and skip values
    let limit = 30;
    let skip = 0;

    if (page > 1) {
        limit = 10;
        skip = 30 + (page - 2) * 10;
    }

    const totalCount = await Blog.countDocuments(filter);
    
    const blogs = await Blog.find(filter)
        .populate("categories", "name slug")
        .populate("subCategories", "name slug")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec();

    const hasMore = totalCount > (skip + blogs.length);

    return res.status(200).json(
        new ApiResponse(
            200, 
            {
                blogs,
                pagination: {
                    page,
                    limit,
                    totalCount,
                    hasMore
                }
            }, 
            "Blogs paginated list fetched successfully"
        )
    );
});

export {
    createBlog,
    updateBlog,
    deleteBlog,
    getBlogBySlug,
    getBlogById,
    getAllBlogSlugs,
    getBlogsPaged
};
