import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    getCategoryPageLayout,
    getCategoryPageLayoutAdmin,
    editCategoryPageLayout
} from "../controllers/category_page.controller.js";

const router = Router();

router.route("/").get(getCategoryPageLayout);
router.route("/admin").get(verifyJWT, getCategoryPageLayoutAdmin).put(verifyJWT, editCategoryPageLayout);

export default router;
