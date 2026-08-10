import { Router } from "express";
import { verifyJWT } from "../../middlewares/auth.middlewares.js";
import {
    createPosOrder,
    createOnlineOrderV2,
    phonepeCallbackV2,
    initiateOrderRefund
} from "../../controllers/v2/order.controller.js";
import { generatePaymentLinkV2 } from "../../controllers/v2/paymentLinkV2.controller.js";

const router = Router();

router.route("/pos/new").post(verifyJWT, createPosOrder);
router.route("/online/new").post(verifyJWT, createOnlineOrderV2);
router.route("/online/phonepe-callback").all(phonepeCallbackV2);
router.route("/online/payment-link").post(verifyJWT, generatePaymentLinkV2);
router.route("/refund").post(verifyJWT, initiateOrderRefund);

export default router;
