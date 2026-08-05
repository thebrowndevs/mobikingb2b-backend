import { Router } from "express";
import { verifyJWT } from "../../middlewares/auth.middlewares.js";
import { generatePaymentLinkV2 } from "../../controllers/v2/paymentLinkV2.controller.js";

const router = Router();

router.route("/generateLink").post(verifyJWT, generatePaymentLinkV2);

export default router;
