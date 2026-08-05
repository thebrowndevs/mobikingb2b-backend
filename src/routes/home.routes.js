import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createHome, editHomeLayout,
    getAllHomeLayout,
    getGroupsByCategory,
    getGroupsByCategoryAdmin,
    getGroupsByCategoryPaginated,
    getHomeCategories,
    getHomeLayout, getHomeLayoutAdmin, getHomeLayoutWebsite
} from "../controllers/home.controller.js";

const router = Router()

//Product Routes
router.route("/createHomeLayout").post(verifyJWT, createHome);
router.route("/:_id").put(verifyJWT, editHomeLayout);
router.route("/").get(getHomeLayout);
router.route("/app/groups/admin/:categoryId").get(getGroupsByCategoryAdmin);
router.route("/app/groups/:categoryId").get(getGroupsByCategory);
router.route("/app/groups/paginated/:categoryId").get(getGroupsByCategoryPaginated);
router.route("/app/categories").get(getHomeCategories);
router.route("/website").get(getHomeLayoutWebsite);
router.route("/admin").get(getHomeLayoutAdmin);
router.route("/all").get(getAllHomeLayout);

export default router