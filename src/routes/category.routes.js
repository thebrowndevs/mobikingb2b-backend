import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createCategory, createSubCategory, deleteCategory,
    deleteSubCategory, editCategory, editSubCategory,
    getAllCategories, getAllCategorySlugs, getAllFeaturedSubCategories, getAllSubCategories,
    getProductsBySubCategory,
    getAllSubCategoryNames,
    getAllSubCategorySlugs,
    getCategoryById, getCategoryBySlug,
    getSubCategoryById, getSubCategoryBySlug,
    getSubCategoryProductsBySlugPaginated,
    updateSubCategoryStatus
} from "../controllers/category.controller.js";
import { upload } from "../middlewares/multer.middlewares.js";

const router = Router()

//Category Routes
router.route("/createCategory").post(verifyJWT, createCategory);
router.route("/:_id").put(verifyJWT, editCategory);
router.route("/:_id").delete(verifyJWT, deleteCategory);
router.route("/slugs").get(getAllCategorySlugs);
router.route("/").get(getAllCategories);
router.route("/view/:_id").get(verifyJWT, getCategoryById);
router.route("/details/:slug").get(getCategoryBySlug);

//Sub Category Routes
router.route("/createSubCategory").post(verifyJWT, createSubCategory);
router.route("/subCategories/status/:_id").put(verifyJWT, updateSubCategoryStatus);
router.route("/subCategories/:_id").put(verifyJWT, editSubCategory);
router.route("/subCategories/:_id").delete(verifyJWT, deleteSubCategory);
router.route("/subCategories/slugs").get(getAllSubCategorySlugs);
router.route("/subCategories").get(getAllSubCategories);
router.route("/subCategories/products/:_id").get(getProductsBySubCategory);
router.route("/subCategories/names").get(getAllSubCategoryNames);
router.route("/subCategories/featured").get(getAllFeaturedSubCategories);
router.route("/subCategories/view/:_id").get(verifyJWT, getSubCategoryById);
router.route("/subCategories/details/:slug").get(getSubCategoryBySlug);
router.route("/subCategories/details/paginated/:slug").get(getSubCategoryProductsBySlugPaginated);

export default router