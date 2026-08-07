import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    getOnboardingStatus,
    checkDuplicate,
    verifyGst,
    saveBusinessDetails,
    updateGstDetails,
} from "../controllers/onboarding.controller.js";

const router = Router();

// All onboarding routes require authentication
router.use(verifyJWT);

router.get("/status",            getOnboardingStatus);
router.get("/check-duplicate",   checkDuplicate);
router.post("/gst/verify",       verifyGst);
router.post("/business",         saveBusinessDetails);
router.put("/gst/update",        updateGstDetails);

export default router;
