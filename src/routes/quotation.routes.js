import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createQuotation,
    updateQuotationStatus,
    bookQuotation,
    getMyQuotations,
    getAllQuotations,
    updateQuotation,
    updateQuotationItems,
    addItemQuantityInQuotation,
    removeItemQuantityInQuotation,
    recordQuotationCallAttempt,
    getQuotationById,
    getQuotationActivity
} from "../controllers/quotation.controller.js";
import { getPaginatedQuotations } from "../controllers/pagination.controller.js";

const router = Router();

router.route("/new").post(verifyJWT, createQuotation);
router.route("/my").get(verifyJWT, getMyQuotations);
router.route("/all").get(verifyJWT, getAllQuotations);
router.route("/paginated").get(verifyJWT, getPaginatedQuotations);
router.route("/status").post(verifyJWT, updateQuotationStatus);
router.route("/book").post(verifyJWT, bookQuotation);
router.route("/:id/update-items").put(verifyJWT, updateQuotationItems);
router.route("/:id/activity").get(verifyJWT, getQuotationActivity);
router.route("/update").put(verifyJWT, updateQuotation);
router.route("/items/add").post(verifyJWT, addItemQuantityInQuotation);
router.route("/items/remove").post(verifyJWT, removeItemQuantityInQuotation);
router.route("/call-attempt/:_id").post(verifyJWT, recordQuotationCallAttempt);
router.route("/details/:_id").get(verifyJWT, getQuotationById);

export default router;
