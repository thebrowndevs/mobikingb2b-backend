import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createBrand,
    getBrands,
    updateBrand
} from "../controllers/brand.controller.js";
import { getPaginatedBrands } from "../controllers/pagination.controller.js";

const router = Router()

//Brand Routes
router.route("/add").post(verifyJWT, createBrand);
router.route("/update").put(verifyJWT, updateBrand);
router.route("/paginated").get(getPaginatedBrands);
router.route("/").get(getBrands);

export default router