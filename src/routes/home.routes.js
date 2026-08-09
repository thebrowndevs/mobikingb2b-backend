import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createHome, editHomeLayout,
    getAllHomeLayout,
    getGroupsByCategoryAdmin,
    getHomeLayout, getHomeLayoutAdmin
} from "../controllers/home.controller.js";

import {
    getWebsiteBanners,
    getWebsiteCategories,
    getWebsiteGroups,
    getWebGroupProductsPaginated,
    getHomeLayoutWebsite,
    getWebsiteHomeLayoutAdmin,
    updateWebsiteHomeLayoutAdmin
} from "../controllers/home.web.controller.js";

import {
    getAppTabs,
    getAppTabGroups,
    getAppGroupProductsPaginated,
    getGroupsByCategory,
    getGroupsByCategoryPaginated,
    getHomeCategories,
    getAppTabsAdmin,
    createAppTabAdmin,
    updateAppTabAdmin,
    deleteAppTabAdmin,
    reorderAppTabsAdmin
} from "../controllers/home.app.controller.js";

const router = Router();

// Website Layout Endpoints
router.route("/website/banners").get(getWebsiteBanners);
router.route("/website/categories").get(getWebsiteCategories);
router.route("/website/groups").get(getWebsiteGroups);
router.route("/website/groups/:groupId").get(getWebGroupProductsPaginated);
router.route("/website/admin").get(verifyJWT, getWebsiteHomeLayoutAdmin).put(verifyJWT, updateWebsiteHomeLayoutAdmin);

// Mobile App Layout Endpoints
router.route("/app/tabs").get(getAppTabs);
router.route("/app/tabs/admin").get(verifyJWT, getAppTabsAdmin).post(verifyJWT, createAppTabAdmin);
router.route("/app/tabs/reorder").put(verifyJWT, reorderAppTabsAdmin);
router.route("/app/tabs/:tabId").put(verifyJWT, updateAppTabAdmin).delete(verifyJWT, deleteAppTabAdmin);
router.route("/app/tabs/:tabId/groups").get(getAppTabGroups);
router.route("/app/groups/:groupId").get(getAppGroupProductsPaginated);

// Admin / Legacy routes
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

export default router;