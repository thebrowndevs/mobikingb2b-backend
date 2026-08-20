import express from "express";
import {
  createNotification,
  getAllNotifications,
  deleteNotification,
  subscribeToFCMTopic,
} from "../controllers/notification.controller.js";

const router = express.Router();

router.route("/subscribe").post(subscribeToFCMTopic);

router
  .route("/")
  .get(getAllNotifications)
  .post(createNotification);

router.delete("/:id", deleteNotification);

export default router;