import axios from "axios";
import crypto from "crypto";
import { User } from "../models/user.model.js";
import { Address } from "../models/address.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derives the current onboarding step from user data (no extra DB field).
 *   0 → account exists, business not yet filled
 *   1 → business done, no warehouse address
 *   2 → fully onboarded
 */
const deriveStep = (user) => {
    if (!user.business?.active) return 0;
    if (!user.address || user.address.length === 0) return 1;
    return 2;
};

/**
 * Parses the IDfy GST API response into a clean object.
 * Response shape based on actual API output.
 */
const parseGstResponse = (sourceOutput) => {
    const addr = sourceOutput?.principal_place_of_business_fields?.principal_place_of_business_address || {};

    // Build a readable street from the address components
    const streetParts = [addr.door_number, addr.floor_number, addr.building_name, addr.street]
        .filter(Boolean)
        .join(", ");

    return {
        gstin: sourceOutput.gstin || "",
        tradeName: sourceOutput.trade_name || "",
        legalName: sourceOutput.legal_name || "",
        gstinStatus: sourceOutput.gstin_status || "",   // "Active" | "Cancelled" etc.
        isActive: sourceOutput.gstin_status === "Active",
        registrationDate: sourceOutput.date_of_registration || "",
        constitution: sourceOutput.constitution_of_business || "",
        taxpayerType: sourceOutput.taxpayer_type || "",
        natureOfBusiness: sourceOutput.nature_of_business_activity || [],
        principalAddress: {
            street: streetParts,
            street2: addr.location || "",
            city: addr.dst || addr.city || "",         // city is often null; fall back to district (dst)
            state: addr.state_name || "",
            pinCode: addr.pincode || "",
            country: "India",
        },
    };
};

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/onboarding/status
 * Returns the user's current onboarding step + business + addresses
 */
export const getOnboardingStatus = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id)
        .select("business address name phoneNo")
        .populate("address", "label street street2 city state pinCode country isDefault");

    const step = deriveStep(user);

    return res.json(
        new ApiResponse(200, {
            step,
            business: user.business,
            addresses: user.address,
            name: user.name,
            phoneNo: user.phoneNo,
        }, "Onboarding status fetched")
    );
});

/**
 * GET /api/v1/onboarding/check-duplicate
 * Real-time check before calling the paid GST API.
 * Query: ?gstin=XXX  OR  ?businessName=YYY
 */
export const checkDuplicate = asyncHandler(async (req, res) => {
    const { gstin, businessName } = req.query;
    const currentUserId = req.user._id;

    if (!gstin && !businessName) {
        throw new ApiError(400, "Provide gstin or businessName query param");
    }

    let query;
    let field;

    if (gstin) {
        const normalized = gstin.trim().toUpperCase();
        query = { "business.gstNumber": normalized, _id: { $ne: currentUserId } };
        field = "gstin";
    } else {
        query = {
            "business.businessName": { $regex: `^${businessName.trim()}$`, $options: "i" },
            _id: { $ne: currentUserId },
        };
        field = "businessName";
    }

    const existing = await User.findOne(query).select("_id").lean();

    return res.json(
        new ApiResponse(200, { exists: !!existing, field }, "Duplicate check complete")
    );
});

/**
 * POST /api/v1/onboarding/gst/verify
 * Proxies the IDfy RapidAPI GST verification call server-side.
 * Only called after duplicate check passes on the frontend.
 * Body: { gstin: "15-char-string" }
 */
export const verifyGst = asyncHandler(async (req, res) => {
    const { gstin } = req.body;

    if (!gstin || gstin.trim().length !== 15) {
        throw new ApiError(400, "A valid 15-character GSTIN is required");
    }

    const normalized = gstin.trim().toUpperCase();

    // Proxy call — key never leaves server
    let apiResponse;
    try {
        apiResponse = await axios.post(
            "https://gst-verification.p.rapidapi.com/v3/tasks/sync/verify_with_source/ind_gst_certificate",
            {
                task_id: crypto.randomUUID(),
                group_id: "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                data: {
                    gstin: normalized
                }
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "x-rapidapi-host": "gst-verification.p.rapidapi.com",
                    "x-rapidapi-key": process.env.RAPIDAPI_GST_KEY,
                },
                timeout: 15000,
            }
        );
    } catch (err) {
        const msg = err?.response?.data?.message || err.message || "GST verification service unavailable";
        throw new ApiError(502, `GST API error: ${msg}`);
    }

    const raw = apiResponse.data;

    // IDfy wraps result under result.source_output
    const sourceOutput = raw?.result?.source_output;

    if (!sourceOutput || raw.status !== "completed") {
        throw new ApiError(502, "GST verification service returned an unexpected response");
    }

    if (sourceOutput.status !== "id_found") {
        throw new ApiError(404, "GSTIN not found in government records");
    }

    if (sourceOutput.gstin_status !== "Active") {
        throw new ApiError(400, `GSTIN is not active. Current status: ${sourceOutput.gstin_status}`);
    }

    const parsed = parseGstResponse(sourceOutput);

    return res.json(
        new ApiResponse(200, { ...parsed, rawSnapshot: sourceOutput }, "GSTIN verified successfully")
    );
});

export const verifyGstPos = asyncHandler(async (req, res) => {
    const { gstin, phoneNo } = req.body;

    if (!gstin || gstin.trim().length !== 15) {
        throw new ApiError(400, "A valid 15-character GSTIN is required");
    }

    const normalized = gstin.trim().toUpperCase();

    // 1. Check if GST is already linked to an existing user in our DB
    const existingUser = await User.findOne({ "business.gstNumber": normalized })
        .populate("address")
        .lean();

    if (existingUser) {
        // Compare phone numbers (last 10 digits to normalize formatting differences)
        const cleanDbPhone = String(existingUser.phoneNo || "").trim().slice(-10);
        const cleanInputPhone = String(phoneNo || "").trim().slice(-10);

        if (cleanDbPhone !== cleanInputPhone) {
            throw new ApiError(400, "This GST number is already registered with another account.");
        }

        const defaultAddr = (existingUser.address && Array.isArray(existingUser.address))
            ? (existingUser.address.find(a => a.isDefault) || existingUser.address[0] || {})
            : {};
        return res.json(
            new ApiResponse(200, {
                alreadyRegistered: true,
                user: {
                    _id: existingUser._id,
                    name: existingUser.name || "",
                    phoneNo: existingUser.phoneNo || "",
                    email: existingUser.email || "",
                    gstNumber: existingUser.business?.gstNumber || "",
                    address: defaultAddr.street || "",
                    address2: defaultAddr.street2 || "",
                    city: defaultAddr.city || "",
                    state: defaultAddr.state || "",
                    pincode: defaultAddr.pinCode || "",
                    country: defaultAddr.country || "India"
                }
            }, "GST number is already linked to this customer account.")
        );
    }

    // 2. If not registered, proceed with paid IDfy API verification call
    let apiResponse;
    try {
        apiResponse = await axios.post(
            "https://gst-verification.p.rapidapi.com/v3/tasks/sync/verify_with_source/ind_gst_certificate",
            {
                task_id: crypto.randomUUID(),
                group_id: "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                data: {
                    gstin: normalized
                }
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "x-rapidapi-host": "gst-verification.p.rapidapi.com",
                    "x-rapidapi-key": process.env.RAPIDAPI_GST_KEY,
                },
                timeout: 15000,
            }
        );
    } catch (err) {
        const msg = err?.response?.data?.message || err.message || "GST verification service unavailable";
        throw new ApiError(502, `GST API error: ${msg}`);
    }

    const raw = apiResponse.data;
    const sourceOutput = raw?.result?.source_output;

    if (!sourceOutput || raw.status !== "completed") {
        throw new ApiError(502, "GST verification service returned an unexpected response");
    }

    if (sourceOutput.status !== "id_found") {
        throw new ApiError(404, "GSTIN not found in government records");
    }

    if (sourceOutput.gstin_status !== "Active") {
        throw new ApiError(400, `GSTIN is not active. Current status: ${sourceOutput.gstin_status}`);
    }

    const parsed = parseGstResponse(sourceOutput);

    return res.json(
        new ApiResponse(200, { ...parsed, alreadyRegistered: false, rawSnapshot: sourceOutput }, "GSTIN verified successfully")
    );
});

/**
 * POST /api/v1/onboarding/business
 * Saves business details (GST or manual). Sets business.active = true.
 * Body (GST path):
 *   { gstNumber, businessName, businessPhone, businessEmail,
 *     registeredAddress: { street, street2, city, state, pinCode, country },
 *     gstData: <raw snapshot> }
 * Body (No-GST path):
 *   { businessName, businessPhone, businessEmail,
 *     registeredAddress: { ... } }
 */
export const saveBusinessDetails = asyncHandler(async (req, res) => {
    const {
        gstNumber,
        businessName,
        businessPhone,
        businessEmail,
        registeredAddress,
        gstData,
    } = req.body;

    if (!businessName?.trim()) {
        throw new ApiError(400, "Business name is required");
    }
    if (!registeredAddress?.street || !registeredAddress?.city || !registeredAddress?.state || !registeredAddress?.pinCode) {
        throw new ApiError(400, "Registered address (street, city, state, pinCode) is required");
    }

    const isGstPath = !!gstNumber;

    const businessUpdate = {
        "business.active": true,
        "business.businessName": businessName.trim(),
        "business.businessPhone": businessPhone?.trim() || "",
        "business.businessEmail": businessEmail?.trim() || "",
        "business.regsiteredAddress": {
            street: registeredAddress.street,
            street2: registeredAddress.street2 || "",
            city: registeredAddress.city,
            state: registeredAddress.state,
            pinCode: registeredAddress.pinCode,
            country: registeredAddress.country || "India",
        },
    };

    if (isGstPath) {
        businessUpdate["business.gstNumber"] = gstNumber.trim().toUpperCase();
        businessUpdate["business.gstVerified"] = true;
        businessUpdate["business.verified"] = true;
        businessUpdate["business.gstData"] = gstData || null;
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $set: businessUpdate },
        { new: true, runValidators: false }
    ).select("business address name phoneNo");

    return res.json(
        new ApiResponse(200, {
            step: deriveStep(updatedUser),
            business: updatedUser.business,
        }, "Business details saved successfully")
    );
});

/**
 * PUT /api/v1/onboarding/gst/update
 * Allows adding/updating GST from the Account page post-onboarding.
 * Body: { gstin, gstData: <parsed + raw snapshot> }
 */
export const updateGstDetails = asyncHandler(async (req, res) => {
    const { gstin, gstData } = req.body;

    if (!gstin || gstin.trim().length !== 15) {
        throw new ApiError(400, "A valid 15-character GSTIN is required");
    }

    // Ensure not a duplicate (excluding current user)
    const existing = await User.findOne({
        "business.gstNumber": gstin.trim().toUpperCase(),
        _id: { $ne: req.user._id },
    }).select("_id").lean();

    if (existing) {
        throw new ApiError(409, "This GSTIN is already linked to another account");
    }

    const updated = await User.findByIdAndUpdate(
        req.user._id,
        {
            $set: {
                "business.gstNumber": gstin.trim().toUpperCase(),
                "business.gstVerified": true,
                "business.verified": true,
                "business.gstData": gstData || null,
            },
        },
        { new: true }
    ).select("business");

    return res.json(
        new ApiResponse(200, { business: updated.business }, "GST details updated successfully")
    );
});
