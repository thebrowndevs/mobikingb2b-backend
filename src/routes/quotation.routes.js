import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createQuotation,
    updateQuotationStatus,
    bookQuotation,
    getMyQuotations,
    getAllQuotations,
    updateQuotation,
    addItemQuantityInQuotation,
    removeItemQuantityInQuotation
} from "../controllers/quotation.controller.js";
import { getPaginatedQuotations } from "../controllers/pagination.controller.js";

const router = Router();

router.route("/new").post(verifyJWT, createQuotation);
router.route("/my").get(verifyJWT, getMyQuotations);
router.route("/all").get(verifyJWT, getAllQuotations);
router.route("/paginated").get(verifyJWT, getPaginatedQuotations);
router.route("/status").post(verifyJWT, updateQuotationStatus);
router.route("/book").post(verifyJWT, bookQuotation);
router.route("/update").put(verifyJWT, updateQuotation);
router.route("/items/add").post(verifyJWT, addItemQuantityInQuotation);
router.route("/items/remove").post(verifyJWT, removeItemQuantityInQuotation);

export default router;
