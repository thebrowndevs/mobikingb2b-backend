import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { addImage, deleteImage, getImages } from './../controllers/media.controller.js';

const router = Router()

//Product Routes
router.route("/image").post(verifyJWT, addImage);
router.route("/image").delete(verifyJWT, deleteImage);
router.route("/image").get(verifyJWT, getImages);

export default router