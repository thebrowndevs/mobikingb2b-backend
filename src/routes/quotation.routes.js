import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    createQuotation,
    updateQuotationStatus,
    bookQuotation,
    getMyQuotations,
    getAllQuotations
} from "../controllers/quotation.controller.js";

const router = Router();

router.route("/new").post(verifyJWT, createQuotation);
router.route("/my").get(verifyJWT, getMyQuotations);
router.route("/all").get(verifyJWT, getAllQuotations);
router.route("/status").post(verifyJWT, updateQuotationStatus);
router.route("/book").post(verifyJWT, bookQuotation);

export default router;
