import { Policy } from "../models/policy.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { CompanyDetails } from "../models/company_details.model.js";
import mongoose from "mongoose";

export const createPolicy = asyncHandler(async (req, res) => {
  const { policyName, slug, heading, content, lastUpdated } = req.body;

  if (!policyName || !heading || !content) {
    throw new ApiError(400, "All fields are required");
  }

  const newPolicy = await Policy.create({ policyName, slug: slug || "", heading, content, lastUpdated: lastUpdated || null });

  return res
    .status(201)
    .json(new ApiResponse(201, newPolicy, "Policy created successfully"));
});

export const updatePolicy = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { policyName, slug, heading, content, lastUpdated } = req.body;

  const policy = await Policy.findById(id);
  if (!policy) throw new ApiError(404, "Policy not found");

  policy.policyName = policyName || policy.policyName;
  policy.slug = slug || policy.slug;
  policy.heading = heading || policy.heading;
  policy.content = content || policy.content;
  policy.lastUpdated = lastUpdated || policy?.lastUpdated || null;

  const updated = await policy.save();

  return res
    .status(200)
    .json(new ApiResponse(200, updated, "Policy updated successfully"));
});

// GET All Policies
export const getPolicies = asyncHandler(async (req, res) => {
  const policies = await Policy.find({}).sort({ lastUpdated: -1 });
  return res
    .status(200)
    .json(new ApiResponse(200, policies, "Policies fetched successfully"));
});

export const getPolicyByIdOrSlug = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.params;

  const isObjectId = mongoose.Types.ObjectId.isValid(idOrSlug);

  const policy = await Policy.findOne(
    isObjectId ? { _id: idOrSlug } : { slug: idOrSlug }
  );

  if (!policy) {
    throw new ApiError(404, "Policy not found");
  }

  return res.status(200).json(
    new ApiResponse(200, policy, "Policy fetched successfully")
  );
});

export const getLatestCompanyDetails = asyncHandler(async (req, res) => {
  const latest = await CompanyDetails.findOne().sort({ updatedAt: -1 }).lean();

  if (!latest) {
    throw new ApiError(404, "Company details not found");
  }

  return res.status(200).json(
    new ApiResponse(200, latest, "Company details fetched successfully")
  );
});

export const updateCompanyDetails = asyncHandler(async (req, res) => {
  const {
    phoneNo, whatsappNo, email, address,
    instaLink, facebookLink, twitterLink, websiteLink,
    androidAppLink, iosAppLink, logoImage,
    paymentGatewaySettings,
    minOrderLimit,
    minQuotationLimit
  } = req.body;

  let details = await CompanyDetails.findOne();

  const updateFields = {
    phoneNo, whatsappNo, email, address,
    instaLink, facebookLink, twitterLink, websiteLink,
    androidAppLink, iosAppLink, logoImage
  };

  if (paymentGatewaySettings) {
    updateFields.paymentGatewaySettings = {
      enableRazorpay: paymentGatewaySettings.enableRazorpay !== undefined ? !!paymentGatewaySettings.enableRazorpay : true,
      enablePhonepe: paymentGatewaySettings.enablePhonepe !== undefined ? !!paymentGatewaySettings.enablePhonepe : true
    };
  }

  if (minOrderLimit !== undefined && minOrderLimit !== null) {
    updateFields.minOrderLimit = Number(minOrderLimit);
  }
  if (minQuotationLimit !== undefined && minQuotationLimit !== null) {
    updateFields.minQuotationLimit = Number(minQuotationLimit);
  }

  if (details) {
    details = await CompanyDetails.findByIdAndUpdate(details._id, { $set: updateFields }, { new: true });
  } else {
    details = await CompanyDetails.create(updateFields);
  }

  return res.status(200).json(
    new ApiResponse(200, details, "Company details updated successfully")
  );
});

/**
 * GET /api/v1/policy/limits
 * Public — no auth required.
 * Returns the minimum cart values enforced for Order Requests and direct Buy Now orders.
 */
export const getCompanyLimits = asyncHandler(async (req, res) => {
  const details = await CompanyDetails.findOne().select("minOrderLimit minQuotationLimit").lean();

  return res.status(200).json(
    new ApiResponse(200, {
      minOrderLimit: details?.minOrderLimit ?? 0,
      minQuotationLimit: details?.minQuotationLimit ?? 0
    }, "Company limits fetched successfully")
  );
});
