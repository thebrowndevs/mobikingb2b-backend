import { Policy } from "../models/policy.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { CompanyDetails } from "../models/company_details.model.js";
import { Product } from "../models/product.model.js";
import { calculateProductDeliveryCharge } from "../utils/deliveryCharge.js";
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
    minQuotationLimit,
    minQuotationQty,
    deliveryChargeSettings
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
      enablePhonepe: paymentGatewaySettings.enablePhonepe !== undefined ? !!paymentGatewaySettings.enablePhonepe : true,
      enableHdfc: paymentGatewaySettings.enableHdfc !== undefined ? !!paymentGatewaySettings.enableHdfc : false
    };
  }

  if (minOrderLimit !== undefined && minOrderLimit !== null) {
    updateFields.minOrderLimit = Number(minOrderLimit);
  }
  if (minQuotationLimit !== undefined && minQuotationLimit !== null) {
    updateFields.minQuotationLimit = Number(minQuotationLimit);
  }
  if (minQuotationQty !== undefined && minQuotationQty !== null) {
    updateFields.minQuotationQty = Number(minQuotationQty);
  }

  // Capture previous delivery charge settings for rollback / scope detection
  const oldSettings = details?.deliveryChargeSettings ? {
    firstKgCharge: details.deliveryChargeSettings.firstKgCharge,
    additionalKgCharge: details.deliveryChargeSettings.additionalKgCharge,
    volumeMultiplier: details.deliveryChargeSettings.volumeMultiplier,
    volumetricDivisor: details.deliveryChargeSettings.volumetricDivisor,
  } : {
    firstKgCharge: 100,
    additionalKgCharge: 60,
    volumeMultiplier: 1.2,
    volumetricDivisor: 5000,
  };

  // Detect Smart Migration Scope
  let migrationScope = null;
  if (deliveryChargeSettings) {
    const newMultiplier = Number(deliveryChargeSettings.volumeMultiplier ?? 1.2);
    const newDivisor = Number(deliveryChargeSettings.volumetricDivisor ?? 5000);
    const newFirstKg = Number(deliveryChargeSettings.firstKgCharge ?? 100);
    const newAddKg = Number(deliveryChargeSettings.additionalKgCharge ?? 70);

    if (oldSettings.volumeMultiplier !== newMultiplier) {
      migrationScope = "scope_volume";
    } else if (oldSettings.volumetricDivisor !== newDivisor) {
      migrationScope = "scope_weight";
    } else if (oldSettings.firstKgCharge !== newFirstKg || oldSettings.additionalKgCharge !== newAddKg) {
      migrationScope = "scope_rate_only";
    }

    updateFields.deliveryChargeSettings = {
      firstKgCharge: newFirstKg,
      additionalKgCharge: newAddKg,
      volumeMultiplier: newMultiplier,
      volumetricDivisor: newDivisor
    };
  }

  if (details) {
    details = await CompanyDetails.findByIdAndUpdate(details._id, { $set: updateFields }, { returnDocument: 'after' });
  } else {
    details = await CompanyDetails.create(updateFields);
  }

  return res.status(200).json(
    new ApiResponse(200, {
      ...details.toObject(),
      migrationScope,
      previousSettings: oldSettings
    }, "Company details updated successfully")
  );
});

/**
 * GET /api/v1/policy/limits
 * Public — no auth required.
 * Returns order limits, payment gateway flags, and volumetric delivery charge rates.
 */
export const getCompanyLimits = asyncHandler(async (req, res) => {
  const details = await CompanyDetails.findOne()
    .select("minOrderLimit minQuotationLimit minQuotationQty paymentGatewaySettings deliveryChargeSettings").lean();

  return res.status(200).json(
    new ApiResponse(200, {
      minOrderLimit: details?.minOrderLimit ?? 0,
      minQuotationLimit: details?.minQuotationLimit ?? 0,
      minQuotationQty: details?.minQuotationQty ?? 0,
      enableRazorpay: details?.paymentGatewaySettings?.enableRazorpay ?? true,
      enablePhonepe: details?.paymentGatewaySettings?.enablePhonepe ?? true,
      enableHdfc: details?.paymentGatewaySettings?.enableHdfc ?? false,
      deliveryChargeSettings: details?.deliveryChargeSettings ?? {
        firstKgCharge: 100,
        additionalKgCharge: 70,
        volumeMultiplier: 1.2,
        volumetricDivisor: 5000
      }
    }, "Company limits fetched successfully")
  );
});

/**
 * GET /api/v1/policy/delivery-settings/migrate-stream
 * Server-Sent Events (SSE) Stream
 * Smartly recalculates product attributes in batches and streams live progress to the frontend.
 */
export const streamDeliverySettingsMigration = asyncHandler(async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  const scope = req.query.scope || "scope_rate_only";
  const details = await CompanyDetails.findOne().lean();
  const config = details?.deliveryChargeSettings || {
    firstKgCharge: 100,
    additionalKgCharge: 60,
    volumeMultiplier: 1.2,
    volumetricDivisor: 5000
  };

  const query = {
    "dimensions.length": { $gt: 0 },
    "dimensions.breadth": { $gt: 0 },
    "dimensions.height": { $gt: 0 }
  };

  const total = await Product.countDocuments(query);

  if (total === 0) {
    res.write(`data: ${JSON.stringify({ processed: 0, total: 0, percent: 100, status: "completed", scope, message: "No products with physical dimensions to migrate." })}\n\n`);
    setTimeout(() => {
      try { res.end(); } catch {}
    }, 1000);
    return;
  }

  let processed = 0;
  const batchSize = 100;
  const cursor = Product.find(query).cursor({ batchSize });

  let batch = [];
  for await (const product of cursor) {
    const l = product.dimensions?.length || 0;
    const b = product.dimensions?.breadth || 0;
    const h = product.dimensions?.height || 0;

    let updateFields = {};
    if (scope === "scope_volume") {
      const calc = calculateProductDeliveryCharge({ length: l, breadth: b, height: h, quantity: 1, config });
      updateFields = {
        "dimensions.volume": calc.unitVolume,
        "dimensions.volumetricWeight": calc.unitVolumetricWeight,
        "baseDeliveryCharge": calc.unitBaseCharge
      };
    } else if (scope === "scope_weight") {
      const vol = product.dimensions?.volume || (l * b * h * config.volumeMultiplier);
      const wt = config.volumetricDivisor > 0 ? parseFloat((vol / config.volumetricDivisor).toFixed(3)) : 0;
      let charge = 0;
      if (wt > 0) {
        charge = wt <= 1 ? config.firstKgCharge : Math.round(config.firstKgCharge + Math.ceil(wt - 1) * config.additionalKgCharge);
      }
      updateFields = {
        "dimensions.volumetricWeight": wt,
        "baseDeliveryCharge": charge
      };
    } else {
      // scope_rate_only: preserve volume and volumetricWeight, only recalculate baseDeliveryCharge
      const wt = product.dimensions?.volumetricWeight || 0;
      let charge = 0;
      if (wt > 0) {
        charge = wt <= 1 ? config.firstKgCharge : Math.round(config.firstKgCharge + Math.ceil(wt - 1) * config.additionalKgCharge);
      }
      updateFields = {
        "baseDeliveryCharge": charge
      };
    }

    batch.push({
      updateOne: {
        filter: { _id: product._id },
        update: { $set: updateFields }
      }
    });

    if (batch.length >= batchSize) {
      await Product.bulkWrite(batch);
      processed += batch.length;
      const percent = Math.min(100, Math.round((processed / total) * 100));
      res.write(`data: ${JSON.stringify({ processed, total, percent, status: "progress", scope })}\n\n`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await Product.bulkWrite(batch);
    processed += batch.length;
    res.write(`data: ${JSON.stringify({ processed, total, percent: 100, status: "progress", scope })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({ processed: total, total, percent: 100, status: "completed", scope, message: "Smart product migration completed successfully." })}\n\n`);
  setTimeout(() => {
    try { res.end(); } catch {}
  }, 1000);
});

/**
 * POST /api/v1/policy/delivery-settings/rollback
 * Reverts company delivery settings to previous state if a migration fails or is interrupted.
 */
export const rollbackDeliverySettings = asyncHandler(async (req, res) => {
  const { previousSettings } = req.body;
  if (!previousSettings) {
    throw new ApiError(400, "Previous settings are required for rollback");
  }

  let details = await CompanyDetails.findOne();
  if (details) {
    details.deliveryChargeSettings = {
      firstKgCharge: Number(previousSettings.firstKgCharge ?? 100),
      additionalKgCharge: Number(previousSettings.additionalKgCharge ?? 70),
      volumeMultiplier: Number(previousSettings.volumeMultiplier ?? 1.2),
      volumetricDivisor: Number(previousSettings.volumetricDivisor ?? 5000),
    };
    await details.save();
  }

  return res.status(200).json(
    new ApiResponse(200, details?.deliveryChargeSettings, "Delivery settings rolled back successfully")
  );
});

/**
 * POST /api/v1/policy/delivery-settings/migrate-batch
 * Fallback reliable batch migration (atomic bulkWrite) without requiring SSE streaming.
 */
export const migrateDeliverySettingsBatch = asyncHandler(async (req, res) => {
  const scope = req.body?.scope || req.query?.scope || "scope_rate_only";
  const details = await CompanyDetails.findOne().lean();
  const config = details?.deliveryChargeSettings || {
    firstKgCharge: 100,
    additionalKgCharge: 60,
    volumeMultiplier: 1.2,
    volumetricDivisor: 5000,
  };

  const query = {
    "dimensions.length": { $gt: 0 },
    "dimensions.breadth": { $gt: 0 },
    "dimensions.height": { $gt: 0 },
  };

  const products = await Product.find(query);
  if (products.length === 0) {
    return res.status(200).json(
      new ApiResponse(200, { processed: 0, total: 0, scope }, "No products with dimensions to migrate")
    );
  }

  const batch = [];
  for (const product of products) {
    const l = product.dimensions?.length || 0;
    const b = product.dimensions?.breadth || 0;
    const h = product.dimensions?.height || 0;

    let updateFields = {};
    if (scope === "scope_volume") {
      const calc = calculateProductDeliveryCharge({ length: l, breadth: b, height: h, quantity: 1, config });
      updateFields = {
        "dimensions.volume": calc.unitVolume,
        "dimensions.volumetricWeight": calc.unitVolumetricWeight,
        "baseDeliveryCharge": calc.unitBaseCharge,
      };
    } else if (scope === "scope_weight") {
      const vol = product.dimensions?.volume || (l * b * h * config.volumeMultiplier);
      const wt = config.volumetricDivisor > 0 ? parseFloat((vol / config.volumetricDivisor).toFixed(3)) : 0;
      let charge = 0;
      if (wt > 0) {
        charge = wt <= 1 ? config.firstKgCharge : Math.round(config.firstKgCharge + Math.ceil(wt - 1) * config.additionalKgCharge);
      }
      updateFields = {
        "dimensions.volumetricWeight": wt,
        "baseDeliveryCharge": charge,
      };
    } else {
      const wt = product.dimensions?.volumetricWeight || 0;
      let charge = 0;
      if (wt > 0) {
        charge = wt <= 1 ? config.firstKgCharge : Math.round(config.firstKgCharge + Math.ceil(wt - 1) * config.additionalKgCharge);
      }
      updateFields = {
        "baseDeliveryCharge": charge,
      };
    }

    batch.push({
      updateOne: {
        filter: { _id: product._id },
        update: { $set: updateFields },
      },
    });
  }

  if (batch.length > 0) {
    await Product.bulkWrite(batch);
  }

  return res.status(200).json(
    new ApiResponse(200, { processed: products.length, total: products.length, scope }, "Products migrated successfully")
  );
});
