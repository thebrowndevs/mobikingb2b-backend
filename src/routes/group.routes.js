import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    addProductInGroup,
    createGroup,
    deleteGroup,
    editGroup,
    getAllGroups,
    getAllGroupsAdmin,
    getGroupProductsById,
    getGroupsByCategories,
    getSpecialGroups,
    removeProductFromGroup,
    syncGroupProducts
} from "../controllers/group.controller.js";
import { upload } from "../middlewares/multer.middlewares.js";

const router = Router()

//Product Routes
router.route("/createGroup").post(verifyJWT, createGroup);
router.route("/admin/list").get(getAllGroupsAdmin);
router.route("/:_id").put(verifyJWT, editGroup);
router.route("/:_id").delete(verifyJWT, deleteGroup);
router.route("/addProduct").post(verifyJWT, addProductInGroup);
router.route("/removeProduct").post(verifyJWT, removeProductFromGroup);
router.route("/updateProducts").post(verifyJWT, syncGroupProducts);
router.route("/").get(getAllGroups);
router.route("/products/:_id").get(getGroupProductsById);
router.route("/special").get(getSpecialGroups);
router.route("/category/:category").get(getGroupsByCategories);

export default router