import express from "express";
import {
  createPolicy,
  updatePolicy,
  getPolicies,
  getPolicyByIdOrSlug,
  getLatestCompanyDetails,
  updateCompanyDetails,
  getCompanyLimits,
} from "../controllers/policy.controller.js";

const router = express.Router();

router.post("/", createPolicy);
router.put("/:id", updatePolicy);

// ✅ GET routes
router.get("/", getPolicies);                   // Get all policies
router.get("/company-details", getLatestCompanyDetails);                   // Get company details
router.get("/limits", getCompanyLimits);                   // Get minOrderLimit + minQuotationLimit (public)
router.post("/company-details", updateCompanyDetails);                     // Update company details
router.get("/:idOrSlug", getPolicyByIdOrSlug);  // Get one policy by ID or slug

export default router;