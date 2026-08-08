import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import multer from "multer"
import compression from "compression"
import { ApiError } from "./utils/ApiError.js"

const app = express()

app.use(cors(
    // {
    //     origin: process.env.CORS_ORIGIN,
    //     credentials: true
    // }
))

app.use(compression())

// app.use(express.json({ limit: "16kb" }))
// app.use(express.urlencoded({ extended: true, limit: "16kb" }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static("public"))
app.use(cookieParser())


//routes import
import userRouter from './routes/user.routes.js'
import categoryRouter from './routes/category.routes.js'
import productRouter from './routes/product.routes.js'
import brandRouter from './routes/brand.route.js'
import groupRouter from './routes/group.routes.js'
import homeRouter from './routes/home.routes.js'
import cartRouter from './routes/cart.routes.js'
import mediaRouter from './routes/media.routes.js'
import orderRouter from './routes/order.routes.js'
import queryRouter from './routes/query.routes.js'
import reportRouter from './routes/report.routes.js'
import notificationRouter from './routes/notification.routes.js'
import policyRouter from './routes/policy.routes.js'
import paymentRouter from './routes/payment.routes.js'
import couponRouter from './routes/coupon.routes.js'
import blogRouter from './routes/blog.routes.js'
import onboardingRouter from './routes/onboarding.routes.js'
import quotationRouter from './routes/quotation.routes.js'

// v2 routes import
import productRouterV2 from './routes/v2/product.routes.js'
import orderRouterV2 from './routes/v2/order.routes.js'
import paymentRouterV2 from './routes/v2/payment.routes.js'

// import { startAbandonedCartScheduler, startDeleteAbandonedOrderScheduler, startRestoreReservedOrdersScheduler } from './scheduler/abandonedCart.scheduler.js';
import { paymentLinkWebhook } from "./controllers/order.controller.js"
import { paymentWebhookV2, phonepeWebhookV2 } from "./controllers/v2/payment.controller.js"

//routes declaration
app.use("/api/v1/users", userRouter)
app.use("/api/v1/categories", categoryRouter)
app.use("/api/v1/brands", brandRouter)
app.use("/api/v1/products", productRouter)
app.use("/api/v1/groups", groupRouter)
app.use("/api/v1/home", homeRouter)
app.use("/api/v1/cart", cartRouter)
app.use("/api/v1/media", mediaRouter)
app.use("/api/v1/orders", orderRouter)

// v2 routes declaration
app.use("/api/v2/products", productRouterV2)
app.use("/api/v2/orders", orderRouterV2)
app.use("/api/v2/payment", paymentRouterV2)

app.use("/api/v1/queries", queryRouter)
app.use("/api/v1/reports", reportRouter)
app.use("/api/v1/notifications", notificationRouter)
app.use("/api/v1/policy", policyRouter)
app.use("/api/v1/payment", paymentRouter)
app.use("/api/v1/coupon", couponRouter)
app.use("/api/v1/blogs", blogRouter)
app.use("/api/v1/onboarding", onboardingRouter)
app.use("/api/v1/quotations", quotationRouter)
app.use("/api/v1/webhook/payment", paymentWebhookV2)
app.use("/api/v2/payment/phonepe-webhook", phonepeWebhookV2)

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: "Your server is up and running smoothly...."
    });
});

// startAbandonedCartScheduler();
// startDeleteAbandonedOrderScheduler();
// startRestoreReservedOrdersScheduler();

// Global error handler
app.use((err, req, res, next) => {
    // logger.error(err);
    console.log(err);
    if (err instanceof multer.MulterError) {
        // Multer-specific errors
        return res
            .status(400)
            .json({ message: "Multer error", error: err.message });
    }
    if (err.message && err.message.toLowerCase().includes("cloudinary")) {
        // Cloudinary-specific errors
        return res
            .status(500)
            .json({ message: "Cloudinary error", error: err.message });
    }
    if (err instanceof ApiError) {
        return res.status(err.statusCode).json({
            status: err.statusCode,
            message: err.message,
            errors: err.errors || [],
            success: false,
        });
    }

    return res.status(500).json({
        status: 500,
        message: err.message || "Internal Server Error",
        success: false,
    });
});

export { app }