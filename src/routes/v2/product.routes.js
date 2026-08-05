import { Router } from "express";
import { verifyJWT } from "../../middlewares/auth.middlewares.js";
import { updateProductStock, bulkUpdateProductStock } from "../../controllers/v2/product.controller.js";

const router = Router();

router.route("/addProductStock").post(verifyJWT, updateProductStock);
router.route("/bulkUpdateProductStock").post(verifyJWT, bulkUpdateProductStock);

export default router;
