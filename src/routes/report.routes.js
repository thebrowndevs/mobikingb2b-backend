import express from "express";
import {
    getTotalCustomers,
    getTotalOrders,
    getTotalSales,
    getSalesInRange,
    getDailyOrderCounts,
    getDailyOrderSourceCounts,
    getDailyCustomerSignupCounts,
    getDailySalesInRange,
    fetchModelColumns,
    getProductSalesReport,
} from "../controllers/reports.controller.js"; // adjust the path as needed
import { verifyJWT } from "../middlewares/auth.middlewares.js";

const router = express.Router();

// Total customers count
router.route("/customers/count").get(verifyJWT, getTotalCustomers);

//Chart API
router.route("/customers/").get(verifyJWT, getDailyCustomerSignupCounts);

router.route("/orders/count").get(verifyJWT, getTotalOrders);

// Chart API
router.route("/orders").get(verifyJWT, getDailyOrderCounts);
router.route("/orders/filtered").get(verifyJWT, getDailyOrderSourceCounts);
router.route("/sales").get(verifyJWT, getDailySalesInRange);

router.route("/sales/total").get(verifyJWT, getTotalSales);
router.route("/sales/custom").get(verifyJWT, getSalesInRange);

//Reports API
router.route("/modules").post(verifyJWT, fetchModelColumns);
router.route("/product-sales").post(verifyJWT, getProductSalesReport);

export default router;