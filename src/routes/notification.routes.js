import express from "express";
import {
  createNotification,
  getAllNotifications,
  deleteNotification,
} from "../controllers/notification.controller.js";

const router = express.Router();

router
  .route("/")
  .get(getAllNotifications)
  .post(createNotification);

router.delete("/:id", deleteNotification);

export default router;