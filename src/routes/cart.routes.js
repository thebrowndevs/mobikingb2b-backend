import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    addProductInCart,
    removeProductFromCart
} from "../controllers/cart.controller.js";

const router = Router()

//Product Routes
router.route("/add").post(verifyJWT, addProductInCart);
router.route("/remove").delete(verifyJWT, removeProductFromCart);

export default router