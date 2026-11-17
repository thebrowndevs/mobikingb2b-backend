import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { generatePaymentLink, getAllPaymentLinks } from "../controllers/paymentLink.controller.js";
import {
    getPendingPayments,
    createGatewayOrderForPayment,
    createRazorpayOrderForPayment,
    verifyRazorpayPayment,
    verifyPhonepeB2BPayment,
    verifyHdfcB2BPayment,
    getPaymentById
} from "../controllers/payment.controller.js";
import { phonepeCallbackV1, hdfcCallback } from "../controllers/order.controller.js";

const router = Router();

// Unauthenticated PhonePe / HDFC browser return callback
router.route("/phonepe-callback").all(phonepeCallbackV1);
router.route("/hdfc-callback").all(hdfcCallback);

// Admin / Public payment link routes
router.route("/link").post(verifyJWT, generatePaymentLink);
router.route("/links").get(verifyJWT, getAllPaymentLinks);

// B2B Pending Payment Request Routes
router.route("/pending").get(verifyJWT, getPendingPayments);
router.route("/:paymentId").get(verifyJWT, getPaymentById);

// Unified gateway order creation (gateway specified in body: 'razorpay' | 'phonepe')
router.route("/create-order").post(verifyJWT, createGatewayOrderForPayment);
// Backward-compatible alias — existing apps sending to /create-razorpay-order still work
router.route("/create-razorpay-order").post(verifyJWT, createRazorpayOrderForPayment);

// Payment verification
router.route("/verify").post(verifyJWT, verifyRazorpayPayment);
router.route("/verify-phonepe").post(verifyJWT, verifyPhonepeB2BPayment);
router.route("/verify-hdfc").post(verifyJWT, verifyHdfcB2BPayment);

export default router;