import { Notification } from "../models/notification.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/* Create Notification */
export const createNotification = asyncHandler(async (req, res) => {
  const { title, message, image, redirect } = req.body;

  if (!title || !message) {
    throw new ApiError(400, "Title and message are required.");
  }

  const newNotification = await Notification.create({
    title,
    message,
    image: image || null,
    redirect: redirect || null,
    sentBy: req?.user?._id || null, // Optional, if auth is used
  });

  return res
    .status(201)
    .json(new ApiResponse(201, newNotification, "Notification sent successfully"));
});

/* Get All Notifications */
export const getAllNotifications = asyncHandler(async (req, res) => {
  const notifications = await Notification.find()
    .sort({ createdAt: -1 })
  // .limit(100); // Optional limit

  return res
    .status(200)
    .json(new ApiResponse(200, notifications, "Notifications fetched"));
});

/* Delete Notification by ID */
export const deleteNotification = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const deleted = await Notification.findByIdAndDelete(id);

  if (!deleted) {
    throw new ApiError(404, "Notification not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, deleted, "Notification deleted successfully"));
});

/* Subscribe Token to FCM Topic */
export const subscribeToFCMTopic = asyncHandler(async (req, res) => {
  const { token, topic = "b2bUsers" } = req.body;

  if (!token) {
    throw new ApiError(400, "Device token is required.");
  }

  // Import dynamically/inline or at top
  const { subscribeTokenToTopic } = await import("../services/firebase.service.js");
  await subscribeTokenToTopic(token, topic);

  return res
    .status(200)
    .json(new ApiResponse(200, null, `Device subscribed to ${topic} topic successfully`));
});
