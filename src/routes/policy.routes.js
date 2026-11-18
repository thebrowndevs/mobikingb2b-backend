import express from "express";
import {
  createPolicy,
  updatePolicy,
  getPolicies,
  getPolicyByIdOrSlug,
  getLatestCompanyDetails,
  updateCompanyDetails,
  getCompanyLimits,
  streamDeliverySettingsMigration,
  rollbackDeliverySettings,
  migrateDeliverySettingsBatch,
} from "../controllers/policy.controller.js";
import { verifyJWT } from "../middlewares/auth.middlewares.js";

const router = express.Router();

router.post("/", createPolicy);
router.put("/:id", updatePolicy);

// ✅ GET & POST routes
router.get("/", getPolicies);                   // Get all policies
router.get("/company-details", getLatestCompanyDetails);                   // Get company details
router.get("/limits", getCompanyLimits);                   // Get minOrderLimit + minQuotationLimit (public)
router.get("/delivery-settings/migrate-stream", streamDeliverySettingsMigration); // Smart migration SSE stream
router.post("/delivery-settings/migrate-batch", migrateDeliverySettingsBatch);    // Fallback batch migration
router.post("/delivery-settings/rollback", rollbackDeliverySettings);             // Rollback settings on error
router.post("/company-details", updateCompanyDetails);                     // Update company details
router.get("/:idOrSlug", getPolicyByIdOrSlug);  // Get one policy by ID or slug

export default router;