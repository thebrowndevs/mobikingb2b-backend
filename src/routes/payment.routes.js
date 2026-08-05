import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { generatePaymentLink, getAllPaymentLinks } from "../controllers/paymentLink.controller.js";

const router = Router()

//Product Routes
router.route("/generateLink").post(verifyJWT, generatePaymentLink);
router.route("/links").get(verifyJWT, getAllPaymentLinks);

export default router