import express from "express";
import {
  createPolicy,
  updatePolicy,
  getPolicies,
  getPolicyByIdOrSlug,
  getLatestCompanyDetails,
  updateCompanyDetails,
} from "../controllers/policy.controller.js";

const router = express.Router();

router.post("/", createPolicy);
router.put("/:id", updatePolicy);

// ✅ GET routes
router.get("/", getPolicies);                   // Get all policies
router.get("/company-details", getLatestCompanyDetails);                   // Get all policies
router.post("/company-details", updateCompanyDetails);                     // Update company details
router.get("/:idOrSlug", getPolicyByIdOrSlug);  // Get one policy by ID or slug

export default router;