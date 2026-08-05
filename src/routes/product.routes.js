import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createProduct, deleteProduct, editProduct,
    getAllActiveInstockProducts,
    getAllProducts, getAllProductSlugs, getProductById, getProductBySlug,
    getProductsByCategory, getProductsByGroup,
    getRelatedProducts,
    getStockHistoryByProduct,
    markProductChecked,
    updateProductStatus,
    updateProductStock,
    getProductOrders
} from "../controllers/product.controller.js";
import { upload } from "../middlewares/multer.middlewares.js";
import { getPaginatedProducts, getPaginatedProductsForAdmin } from "../controllers/pagination.controller.js";
import { getSearchSuggestions, searchProducts, searchProductsPaginated } from "../controllers/search.controller.js";

const router = Router()

//Product Routes
router.route("/createProduct").post(verifyJWT, createProduct);
router.route("/status/:_id").put(verifyJWT, updateProductStatus);
router.route("/check/:_id").put(verifyJWT, markProductChecked);
router.route("/:_id").put(verifyJWT, editProduct);
router.route("/:_id").delete(verifyJWT, deleteProduct);
router.route("/available").get(getAllActiveInstockProducts);
router.route("/related/:slug").get(getRelatedProducts);
router.route("/slugs").get(getAllProductSlugs);
router.route("/").get(getAllProducts);
router.route("/category/:categoryId").get(getProductsByCategory);
router.route("/group/:groupId").get(getProductsByGroup);
router.route("/stock/:_id").get(verifyJWT, getStockHistoryByProduct);
router.route("/orders/:_id").get(verifyJWT, getProductOrders);
router.route("/:_id").get(verifyJWT, getProductById);
router.route("/details/:slug").get(getProductBySlug);
//Paginated Products
router.route("/all/paginated").get(getPaginatedProducts);
router.route("/admin/paginated").get(getPaginatedProductsForAdmin);
router.route("/all/search").get(searchProducts);
router.route("/all/paginated/search").get(searchProductsPaginated);
router.route("/suggestions/search").get(getSearchSuggestions);

//Stock Routes
router.route("/addProductStock").post(verifyJWT, updateProductStock);

export default router