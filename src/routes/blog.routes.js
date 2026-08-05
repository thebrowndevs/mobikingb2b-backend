import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createBlog,
    updateBlog,
    deleteBlog,
    getBlogBySlug,
    getBlogById,
    getAllBlogSlugs,
    getBlogsPaged
} from "../controllers/blog.controller.js";

const router = Router();

// Blog routes
router.route("/create").post(verifyJWT, createBlog);
router.route("/:_id").put(verifyJWT, updateBlog);
router.route("/:_id").delete(verifyJWT, deleteBlog);
router.route("/slugs").get(getAllBlogSlugs);
router.route("/slug/:slug").get(getBlogBySlug);
router.route("/view/:_id").get(getBlogById);
router.route("/").get(getBlogsPaged);

export default router;
