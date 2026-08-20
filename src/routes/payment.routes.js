import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { generatePaymentLink, getAllPaymentLinks } from "../controllers/paymentLink.controller.js";
import {
    getPendingPayments,
    createRazorpayOrderForPayment,
    verifyRazorpayPayment,
    getPaymentById
} from "../controllers/payment.controller.js";

const router = Router()

//Product Routes
router.route("/generateLink").post(verifyJWT, generatePaymentLink);
router.route("/links").get(verifyJWT, getAllPaymentLinks);

// B2B Pending Payment Request Routes
router.route("/pending").get(verifyJWT, getPendingPayments);
router.route("/:paymentId").get(verifyJWT, getPaymentById);
router.route("/create-razorpay-order").post(verifyJWT, createRazorpayOrderForPayment);
router.route("/verify").post(verifyJWT, verifyRazorpayPayment);

export default router