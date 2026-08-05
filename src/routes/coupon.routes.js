import express from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    checkCouponValid,
    createCoupon,
    deleteCoupon,
    getCouponByCode,
    getCoupons,
    updateCoupon,
    getAdminCoupons
} from "../controllers/coupon.controller.js";
import { getPaginatedCoupons } from "../controllers/pagination.controller.js";

const router = express.Router();

router.post("/", verifyJWT, createCoupon);
router.put("/", verifyJWT, updateCoupon);
router.get("/", verifyJWT, getCoupons);
router.get("/admin/all", verifyJWT, getAdminCoupons);
router.get("/paginated", verifyJWT, getPaginatedCoupons);
router.get("/code/:code", verifyJWT, getCouponByCode);
router.get("/code/validate/:code/:paymentMethod", verifyJWT, checkCouponValid);
router.delete("/:id", verifyJWT, deleteCoupon);

export default router;