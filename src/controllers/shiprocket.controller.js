import axios from "axios";
import { Order } from "../models/order.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import { Product } from "../models/product.model.js";
import mongoose from "mongoose";
import { Stock } from "../models/stock.model.js";
import { STOCK_TYPES } from "../constants.js";
import { User } from "../models/user.model.js";
import { PartialRequests } from "../models/partialOrderRequests.model.js";
import { logToFile } from "../utils/logger.js";

// This function should be used right after order creation in Shiprocket
// controllers/assignBestCourier.js
const assignBestCourier = async (req, res, next) => {
    try {
        const { shipmentId, shiprocketOrderId } = req.order;
        const courierId = req?.body?.courierId;
        const token = req.shiprocketToken;

        if (!shipmentId)
            return res.status(400).json({
                success: false,
                message: "Shipment ID missing",
            });

        if (!courierId)
            return res.status(400).json({
                success: false,
                message: "Courier ID missing",
            });

        // Skip if already assigned
        const freshOrder = await Order.findById(req?.order?._id);
        if (freshOrder?.awbCode) return next();

        const { data } = await axios.post(
            "https://apiv2.shiprocket.in/v1/external/courier/assign/awb",
            { shipment_id: shipmentId, courier_id: courierId },
            { headers: { Authorization: `Bearer ${token}` } },
        );
        console.log("Courier Assign data: ", data);
        let awbCode = null;
        let courierName = null;

        if (data?.awb_assign_status === 1 && data?.response?.data?.awb_code) {
            awbCode = data?.response?.data?.awb_code;
            courierName = data?.response?.data?.courier_name;
        } else if (data?.response?.awb_code) {
            awbCode = data.response.awb_code;
            courierName = data.response.courier_name;
        }

        if (!awbCode) {
            return res.status(502).json({
                success: false,
                message: "Courier assignment failed",
                data,
            });
        }

        // Update DB after courier assigned
        await Order.findByIdAndUpdate(
            req.order._id,
            {
                // ...pickupInfo,
                awbCode,
                courierName,
                courierAssignedAt: new Date(),
                shippedAt: new Date(),
                // status: 'Accepted',
                // status: 'Shipped',
                shippingStatus: "Courier Assigned",
            },
            { new: true },
        );

        console.log("Shiprocket order Id: ", shiprocketOrderId);
        // Call Shiprocket API to get full order details to check if pickup is auto scheduled
        const response = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/orders/show/${shiprocketOrderId}`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const shipData = response?.data?.data;
        console.log("Pickup Auto Schedule check data: ", shipData);

        //if pickupup auto scheduled then update details in db
        let pickupInfo = null;
        if (shipData?.status === "PICKUP SCHEDULED") {
            pickupInfo = {
                pickupScheduled: true,
                pickupDate:
                    shipData?.shipments?.pickup_scheduled_date || shipData.pickup_date,
                shippingStatus: "Pickup Scheduled",
                expectedDeliveryDate: shipData?.shipments?.etd || null,
            };
        }

        // Update DB
        await Order.findByIdAndUpdate(
            req.order._id,
            {
                ...pickupInfo,
                // awbCode,
                // courierName,
                // courierAssignedAt: new Date(),
                // status: 'Accepted',
                status: "Shipped",
                shippedAt: new Date(),
                shippingStatus: pickupInfo
                    ? pickupInfo?.shippingStatus
                    : "Courier Assigned",
            },
            { new: true },
        );

        next();
    } catch (e) {
        console.error("assignBestCourier error:", e?.response?.data || e);
        return res.status(500).json({
            success: false,
            message: "Internal server error during courier assignment",
            data: e?.response?.data || e?.message,
        });
    }
};

// controllers/schedulePickup.js
const schedulePickup = async (req, res, next) => {
    try {
        const shipmentId = req?.order?.shipmentId || req?.body?.shipmentId;
        const orderId = req?.order?._id || req?.body?.orderId;
        const token = req.shiprocketToken;

        if (!orderId)
            return res.status(400).json({
                success: false,
                message: "Order ID missing",
            });

        if (!shipmentId)
            return res.status(400).json({
                success: false,
                message: "Shipment ID missing",
            });

        const freshOrder = await Order.findById(orderId);
        if (freshOrder.pickupScheduled) {
            res.status(200).json({
                success: true,
                message: "Pickup already scheduled",
                pickupDate: freshOrder.pickupDate,
            });
            next();
        }

        const { data } = await axios.post(
            "https://apiv2.shiprocket.in/v1/external/courier/generate/pickup",
            { shipment_id: [shipmentId] },
            { headers: { Authorization: `Bearer ${token}` } },
        );

        const pickupTokenNumber = data?.response?.pickup_token_number;
        const pickupDate = data?.response?.pickup_scheduled_date;
        const pickupSlot = data?.response?.pickup_token_data?.slot; // Optional slot info

        if (!pickupDate) {
            return res.status(502).json({
                success: false,
                message: "Pickup scheduling failed",
                data,
            });
        }

        // console.log("Fresh Order", freshOrder);
        const trackData = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${freshOrder?.awbCode}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
        );

        // console.log("Track Data: ", trackData);

        // Update order
        const updatedOrder = await Order.findByIdAndUpdate(
            orderId,
            {
                pickupScheduled: true,
                pickupTokenNumber,
                pickupDate,
                pickupSlot: pickupSlot || null,
                // status: 'Accepted',
                shippingStatus: "Pickup Scheduled",
                expectedDeliveryDate: trackData?.data?.tracking_data?.etd || null,
                status: "Shipped",
                shippedAt: new Date(),
            },
            { new: true },
        )
            .populate({
                path: "userId",
                select: "-password -refreshToken",
            })
            .populate({
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category", // This is the key part
                    model: "SubCategory",
                },
            })
            .populate("addressId")
            .exec();

        res.status(200).json({
            success: true,
            message: "Pickup scheduled successfully",
            data: data,
            pickupDate,
            pickupSlot: pickupSlot || null,
        });
        req.order = updatedOrder;
        next();
    } catch (e) {
        console.error("schedulePickup error:", e?.response?.data || e);
        return res.status(500).json({
            success: false,
            message: "Internal server error during pickup scheduling",
            details: e?.response?.data || e?.message,
        });
    }
};

// Helper to call Label+Manifest without response context
const generateLabelAndManifestBackground = async (req, res, next) => {
    try {
        const token = req?.shiprocketToken;

        const order = await Order.findById(req?.order?._id);
        if (!order || !order?.shipmentId) return;

        const shipmentId = order?.shipmentId;

        // Manifest
        const manifestRes = await axios.post(
            "https://apiv2.shiprocket.in/v1/external/manifests/generate",
            { shipment_id: [shipmentId] },
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const manifestUrl = manifestRes.data?.manifest_url;

        // Label
        const labelRes = await axios.post(
            "https://apiv2.shiprocket.in/v1/external/courier/generate/label",
            { shipment_id: [shipmentId] },
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const labelUrl = labelRes?.data?.label_url;
        console.log(labelRes?.data);

        // Update DB
        await Order.findByIdAndUpdate(order?._id, {
            shippingLabelUrl: labelUrl,
            shippingManifestUrl: manifestUrl,
            labelGeneratedAt: new Date(),
            manifestGeneratedAt: new Date(),
        });
    } catch (err) {
        console.error(
            "Background Label+Manifest error:",
            err?.response?.data || err,
        );
        // retry once after delay
        // setTimeout(() => generateLabelAndManifestBackground(orderId, token), 30000); // retry after 30s
    }
};

const generateLabel = async (req, res) => {
    try {
        const { shipmentId } = req.body;
        const { shiprocketToken } = req;

        if (!shipmentId) {
            return res.status(400).json({ message: "Shipment ID is required" });
        }

        const { data } = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/courier/generate/label?shipment_id=${shipmentId}`,
            {
                headers: {
                    Authorization: `Bearer ${shiprocketToken}`,
                },
            },
        );

        const updatedOrder = await Order.findOneAndUpdate(
            { shipmentId },
            {
                shippingLabelUrl: data?.label_url,
                labelGeneratedAt: new Date(),
            },
            { new: true },
        );

        res.status(200).json({ success: true, url: data?.label_url });
    } catch (error) {
        console.error("Label Generation Error:", error);
        res
            .status(500)
            .json({ success: false, message: "Label generation failed" });
    }
};

const generateManifest = async (req, res) => {
    try {
        const { shipmentId } = req.body;
        const { shiprocketToken } = req;

        if (!shipmentId) {
            return res.status(400).json({ message: "Shipment ID is required" });
        }

        const { data } = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/manifests/generate?shipment_id=${shipmentId}`,
            {
                headers: {
                    Authorization: `Bearer ${shiprocketToken}`,
                },
            },
        );

        const updatedOrder = await Order.findOneAndUpdate(
            { shipmentId },
            {
                shippingManifestUrl: data?.manifest_url,
                manifestGeneratedAt: new Date(),
            },
            { new: true },
        );

        res.status(200).json({ success: true, url: data?.manifest_url });
    } catch (error) {
        console.error("Manifest Generation Error:", error);
        res
            .status(500)
            .json({ success: false, message: "Manifest generation failed" });
    }
};

const checkPickupStatus = async (shipmentId, token) => {
    try {
        const response = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/courier/track/shipment/${shipmentId}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
        );

        const data = response?.data;
        const status = data?.tracking_data?.shipment_track?.current_status;

        // Match any status indicating pickup is done
        // console.log("Pickup Data", data);
        const pickupCompleted = [
            "Pickup Completed",
            "PICKED UP",
            "In Transit",
            "Shipment picked up",
            "Delivered",
            "RTO",
        ]?.some((s) => status?.toLowerCase()?.includes(s?.toLowerCase()));

        return {
            completed: pickupCompleted,
            currentStatus: status,
        };
    } catch (err) {
        console.error("Error checking pickup status:", err?.response?.data || err);
        return {
            completed: false,
            error: true,
        };
    }
};

// ----------------------------------- RETURN ORDER CONTROLLERS --------------------------------------------------

// This function should be used right after order creation in Shiprocket
// controllers/assignBestCourier.js
const assignReturnCourier = async (req, res) => {
    try {

        const { orderId: myOrderId, courierId } = req?.body;
        const token = req.shiprocketToken;

        if (!myOrderId || !mongoose.Types.ObjectId.isValid(myOrderId)) {
            return res.status(400).json({
                success: false,
                message: "Valid Order ID not found",
            });
        }

        let freshOrder = await Order.findById(myOrderId);
        if (!freshOrder) {
            return res.status(400).json({
                success: false,
                message: "Order not found",
            });
        }

        const { shipment_id: shipmentId, order_id: shiprocketOrderId } =
            freshOrder?.returnData;
        // const courierId = req?.body?.courierId;

        if (!shipmentId)
            return res.status(400).json({
                success: false,
                message: "Shipment ID missing",
            });

        if (!courierId) {
            // console.log("Request body in courier: ",req?.body);
            return res.status(400).json({
                success: false,
                message: "Courier ID missing",
            });
        }

        // Skip if already assigned
        // let freshOrder = await Order.findById(req?.order?._id);
        if (freshOrder?.returnData?.awb_code) {
            return res.status(400).json({
                success: false,
                message: "Courier already assigned",
            });
        }

        const { data } = await axios.post(
            "https://apiv2.shiprocket.in/v1/external/courier/assign/awb",
            { shipment_id: shipmentId, courier_id: courierId, is_return: 1 },
            { headers: { Authorization: `Bearer ${token}` } },
        );
        // console.log("Courier Assign data: ", data);
        let awbCode = null;
        let courierName = null;

        if (data?.awb_assign_status === 1 && data?.response?.data?.awb_code) {
            awbCode = data?.response?.data?.awb_code;
            courierName = data?.response?.data?.courier_name;
        } else if (data?.response?.awb_code) {
            awbCode = data?.response?.awb_code;
            courierName = data?.response?.courier_name;
        }

        if (!awbCode) {
            return res.status(502).json({
                success: false,
                message: "Return Courier assignment failed",
                data,
            });
        }

        // let newReturnData = {
        //     ...freshOrder?.returnData,
        //     shippingStatus: "Return Courier Assigned",
        //     awb_code: awbCode,
        //     courier_name: courierName,
        //     assigned_date_time: { date: new Date() },
        // }

        freshOrder.returnData = {
            ...freshOrder?.returnData,
            shippingStatus: "Return Courier Assigned",
            awb_code: awbCode,
            courier_name: courierName,
            assigned_date_time: { date: new Date() },
        }

        freshOrder.shippingStatus = "Return Courier Assigned",

            await freshOrder.save();

        // Update DB after courier assigned
        // freshOrder = await Order.findByIdAndUpdate(
        //     freshOrder._id,
        //     {
        //         returnData: newReturnData,
        //         // status: 'Accepted',
        //         // status: 'Shipped',
        //         shippingStatus: "Return Courier Assigned",
        //     },
        //     { new: true },
        // );

        // console.log("Return Shiprocket order Id: ", shiprocketOrderId);
        // Call Shiprocket API to get full order details to check if pickup is auto scheduled
        const response = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/orders/show/${shiprocketOrderId}`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const shipData = response?.data?.data;
        // console.log("Pickup Auto Schedule check data: ", shipData);

        //if pickupup auto scheduled then update details in db
        let pickupInfo = null;
        if (shipData?.status === "RETURN PICKUP GENERATED") {

            //Save pickup info
            pickupInfo = {
                pickupScheduled: true,
                pickup_scheduled_date:
                    shipData?.shipments?.pickup_scheduled_date || shipData.pickup_date,
                shippingStatus: "Return Pickup Scheduled",
                expectedDeliveryDate: shipData?.shipments?.etd || null,
            };
            freshOrder.returnData = {
                ...freshOrder?.returnData,
                ...pickupInfo,
            }
            freshOrder.shippingStatus = pickupInfo
                ? pickupInfo?.shippingStatus : "Return Courier Assigned";

            await freshOrder.save();
        }


        // Update DB
        // freshOrder = await Order.findByIdAndUpdate(
        //     freshOrder._id,
        //     {
        //         returnData: newReturnData,
        //         shippingStatus: pickupInfo
        //             ? pickupInfo?.shippingStatus
        //             : "Return Courier Assigned",
        //     },
        //     { new: true },
        // );

        return res.status(200).json({
            success: true,
            message: `Return Courier Assigned${pickupInfo ? "  and Pickup Scheduled" : ""}`,
            data: { order: freshOrder }
        });

    } catch (e) {
        console.error("assignBestCourier error:", e?.response?.data || e);
        return res.status(500).json({
            success: false,
            message: "Internal server error during courier assignment",
            data: e?.response?.data || e?.message,
        });
    }
};

// controllers/schedulePickup.js
const scheduleReturnOrderPickup = async (req, res, next) => {
    try {

        const { orderId: myOrderId } = req?.body;
        const token = req.shiprocketToken;

        if (!myOrderId || !mongoose.Types.ObjectId.isValid(myOrderId)) {
            return res.status(400).json({
                success: false,
                message: "Valid Order ID not found",
            });
        }

        let freshOrder = await Order.findById(myOrderId);
        if (!freshOrder) {
            return res.status(400).json({
                success: false,
                message: "Order not found",
            });
        }

        const shipmentId = freshOrder?.returnData?.shipment_id;
        // const orderId = req?.order?._id || req?.body?.orderId;

        if (!shipmentId)
            return res.status(400).json({
                success: false,
                message: "Shipment ID missing",
            });

        // const freshOrder = await Order.findById(orderId);
        if (freshOrder?.returnData?.pickup_scheduled_date) {
            return res.status(400).json({
                success: false,
                message: "Return Pickup already scheduled",
                pickupDate: freshOrder?.returnData?.pickup_scheduled_date,
            });
        }

        const { data } = await axios.post(
            "https://apiv2.shiprocket.in/v1/external/courier/generate/pickup",
            { shipment_id: [shipmentId] },
            { headers: { Authorization: `Bearer ${token}` } },
        );

        const pickupTokenNumber = data?.response?.pickup_token_number;
        const pickupDate = data?.response?.pickup_scheduled_date;
        const pickupSlot = data?.response?.pickup_token_data?.slot; // Optional slot info

        if (!pickupDate) {
            return res.status(502).json({
                success: false,
                message: "Pickup scheduling failed",
                data,
            });
        }

        // console.log("Fresh Order", freshOrder);
        const trackData = await axios.get(
            `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${freshOrder?.returnData?.awb_code}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
        );

        // console.log("Track Data: ", trackData);

        freshOrder.returnData = {
            ...freshOrder?.returnData,
            pickupScheduled: true,
            shippingStatus: "Return Pickup Scheduled",
            pickup_token_number: pickupTokenNumber,
            pickup_scheduled_date: pickupDate,
            pickupSlot: pickupSlot || null,
            expectedDeliveryDate: trackData?.data?.tracking_data?.etd || null,
        }
        freshOrder.shippingStatus = "Return Pickup Scheduled";
        await freshOrder.save();
        // Update order
        // const updatedOrder = await Order.findByIdAndUpdate(
        //     freshOrder?._id,
        //     {
        //         returnData: newReturnData,
        //         // status: 'Accepted',
        //         shippingStatus: "Return Pickup Scheduled",
        //         // status: "Shipped",
        //     },
        //     { new: true },
        // )
        //     .populate({
        //         path: "userId",
        //         select: "-password -refreshToken",
        //     })
        //     .populate({
        //         path: "items.productId",
        //         model: "Product",
        //         populate: {
        //             path: "category", // This is the key part
        //             model: "SubCategory",
        //         },
        //     })
        //     .populate("addressId")
        //     .exec();

        res.status(200).json({
            success: true,
            message: "Return Pickup scheduled successfully",
            data: data,
            order: freshOrder,
            pickupDate,
            pickupSlot: pickupSlot || null,
        });

        return res.status(200).json({
            success: true,
            message: `Pickup Scheduled Successfully`,
            data: { order: updatedOrder }
        });

    } catch (e) {
        console.error("schedulePickup error:", e?.response?.data || e);
        return res.status(500).json({
            success: false,
            message: "Internal server error during pickup scheduling",
            details: e?.response?.data || e?.message,
        });
    }
};

const getCourierServiceability = asyncHandler(async (req, res) => {
    const token = req.shiprocketToken;
    console.log(req.query);
    const { data } = await axios.get(
        "https://apiv2.shiprocket.in/v1/external/courier/serviceability/",
        {
            headers: {
                Authorization: `Bearer ${token}`,
            },
            params: req.query,
        }
    );
    console.log(data);
    res.status(200).json(new ApiResponse(200, data, "Courier serviceability fetched successfully"));
});

/* helper: restore stock safely, return true/false */
/* ─────────────────────────────────────────────────────────────────────
restoreStockCore — RTO / Return webhook se stock wapas karta hai
Single flag: _restockDone
Fix: $ne: true — false aur missing dono match karta hai (purane orders)
───────────────────────────────────────────────────────────────────── */
const restoreStockCore = async (order, type) => {
    const session = await mongoose.startSession();

    try {
        let restored = false;
        let alreadyDone = false;

        await session.withTransaction(async () => {

            /* 1️⃣ DISTRIBUTED LOCK
               $ne: true → false aur missing field dono match karta hai
               Purane orders jisme _restockDone exist nahi karta, woh bhi
               correctly lock honge — koi migration ki zaroorat nahi        */
            const lockedOrder = await Order.findOneAndUpdate(
                {
                    _id: order._id,
                    _restockDone: { $ne: true }     // ← KEY FIX
                },
                { $set: { _restockDone: true } },
                { new: true, session }
            );

            if (!lockedOrder) {
                console.warn(
                    `[restoreStockCore] Skipped — already restocked ` +
                    `for order ${order._id} (type: ${type})`
                );
                alreadyDone = true;
                return;
            }

            /* 2️⃣ Aggregate qty per product+variant
               Same product ka duplicate line item handle karta hai       */
            const agg = new Map();

            for (const item of lockedOrder.items) {
                const qty = Math.floor(Number(item.quantity));
                if (!Number.isInteger(qty) || qty <= 0) {
                    throw new Error(`Invalid quantity: ${item.quantity}`);
                }

                const productId = item.productId?._id
                    ? String(item.productId._id)
                    : String(item.productId);

                const variantKey = String(item.variantName || "").trim();
                if (!variantKey) {
                    throw new Error(`Missing variantName for product ${productId}`);
                }

                const key = `${productId}::${variantKey}`;
                agg.set(key, (agg.get(key) || 0) + qty);
            }

            if (agg.size === 0) return;

            /* 3️⃣ findOneAndUpdate with new:true
               Single DB round trip — post-update values se accurate log  */
            const stockEntries = [];

            for (const [mapKey, totalQty] of agg.entries()) {
                const [productId, variantKey] = mapKey.split("::");

                const afterRestore = await Product.findOneAndUpdate(
                    { _id: productId },
                    {
                        $inc: {
                            totalStock: totalQty,
                            [`variants.${variantKey}`]: totalQty
                        }
                    },
                    { new: true, session }
                ).select("variants totalStock");

                if (!afterRestore) {
                    throw new Error(
                        `Product "${productId}" not found — restore failed`
                    );
                }

                if (!afterRestore.variants.has(variantKey)) {
                    throw new Error(
                        `Variant "${variantKey}" not found after restore`
                    );
                }

                // Post-update values se derive — hamesha accurate
                const updatedStock = afterRestore.variants.get(variantKey);
                const previousStock = updatedStock - totalQty;

                stockEntries.push({
                    orderId: lockedOrder.orderId,
                    type,
                    variantName: variantKey,
                    quantity: totalQty,
                    previousStock,
                    updatedStock,
                    productId
                });
            }

            /* 4️⃣ Stock ledger */
            if (stockEntries.length > 0) {
                await Stock.insertMany(stockEntries, { session });
            }

            restored = true;
        });

        return { restored, alreadyDone };

    } finally {
        session.endSession();
    }
};

/* ─────────────────────────────────────────────────────────────────────
   restoreStock — retry wrapper around restoreStockCore
───────────────────────────────────────────────────────────────────── */
const restoreStock = async ({
    order,
    type = STOCK_TYPES.RETURN,
    maxRetries = 3
}) => {
    if (
        !order ||
        order.abondonedOrder ||
        !Array.isArray(order.items) ||
        order.items.length === 0
    ) {
        console.log(
            `[restoreStock] Skipped — no items or abandoned, orderId: ${order?.orderId}`
        );
        return true;
    }

    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            const result = await restoreStockCore(order, type);

            if (result.alreadyDone) {
                console.log(
                    `[restoreStock] Already done — orderId: ${order.orderId}`
                );
                return true;
            }

            if (result.restored) {
                console.log(
                    `[restoreStock] Success on attempt ${attempt + 1} — orderId: ${order.orderId}`
                );
                return true;
            }

            // restored: false bina error ke — treat as failure, retry
            attempt++;
            console.warn(
                `[restoreStock] Attempt ${attempt} returned false — orderId: ${order.orderId}`
            );

        } catch (err) {
            attempt++;
            console.warn(
                `[restoreStock] Attempt ${attempt} threw — orderId: ${order.orderId}:`,
                err.message
            );

            if (attempt >= maxRetries) {
                console.error(
                    `[restoreStock] All ${maxRetries} attempts failed — orderId: ${order.orderId}`
                );
                throw err;
            }

            // Back-off before retry
            await new Promise(resolve => setTimeout(resolve, 300 * attempt));
        }
    }

    return false;
};

/* ─────────────────────────────────────────────────────────────────────
   handlePartialReturnWebhook — Handles status updates for Partial Return orders
───────────────────────────────────────────────────────────────────── */
const handlePartialReturnWebhook = async (order, p, srStatus) => {
    const nowISO = new Date().toISOString();
    let upd = {};
    upd.shippingStatus = srStatus;

    const prevShip = (order?.shippingStatus || "").toUpperCase();

    switch (srStatus) {
        case "PICKUP SCHEDULED":
        case "PICKUP GENERATED":
        case "OUT FOR PICKUP":
            upd.status = "Return Shipped";
            upd.pickupScheduled = true;
            upd.awbCode = p?.awb || order?.awbCode;
            upd.pickupDate = p?.pickup_scheduled_date
            upd.expectedDeliveryDate = p?.etd
            logToFile("partial_return_webhook.log", "EVENT_PICKUP_SCHEDULED", {
                orderId: order._id,
                awbCode: upd.awbCode
            });
            break;

        case "PICKED UP":
            upd.status = "Return Shipped";
            upd.pickupScheduled = true;
            upd.awbCode = p?.awb || order?.awbCode;
            if (prevShip !== "PICKED UP") {
                upd.pickupDate = nowISO;
            }
            logToFile("partial_return_webhook.log", "EVENT_PICKED_UP", {
                orderId: order._id,
                pickupDate: upd.pickupDate || order?.pickupDate
            });
            break;

        case "SHIPPED":
        case "IN TRANSIT":
        case "OUT FOR PICKUP":
            // upd.status = "Shipped";
            upd.pickupScheduled = true;
            upd.awbCode = p?.awb || order?.awbCode;
            logToFile("partial_return_webhook.log", "EVENT_TRANSIT", {
                orderId: order._id,
                status: srStatus
            });
            break;

        case "DELIVERED":
        case "RETURN DELIVERED":
            upd.returnDeliveredAt = nowISO;
            upd.status = "Returned";
            // upd.paymentStatus = "Paid";
            upd.deliveredAt = nowISO;

            logToFile("partial_return_webhook.log", "EVENT_DELIVERED_RESTOCK_START", {
                orderId: order._id
            });

            // Restock items
            await restoreStock({
                order,
                type: STOCK_TYPES.RETURN,
            });

            logToFile("partial_return_webhook.log", "EVENT_DELIVERED_RESTOCK_COMPLETE", {
                orderId: order._id
            });

            // Update Parent Order items to Returned
            const parentOrderDelivered = await Order.findOne({ returnOrderRef: order._id });

            logToFile("partial_return_webhook.log", "DELIVERED_FLOW_PARENT_ORDER_UPDATE", {
                orderId: order._id,
                parentOrderFound: !!parentOrderDelivered,
                parentOrderId: parentOrderDelivered?._id
            });

            if (parentOrderDelivered) {
                order.items.forEach(reqIt => {
                    const parentIt = parentOrderDelivered.items.find(it =>
                        (it.product_id ? it.product_id == reqIt.product_id : false)
                    );
                    if (parentIt) {
                        parentIt.isReturned = true;
                        parentIt.returnStatus = "Returned";
                    }
                });
                parentOrderDelivered.markModified("items");
                await parentOrderDelivered.save();
            }
            break;

        case "RETURN PICKUP EXCEPTION":
        case "PICKUP EXCEPTION":
        case "CANCELED":
        case "CANCELLED":
            upd.status = "Return Cancelled";
            upd.shippingStatus = "Return Cancelled";
            upd.reason = "Return Cancelled on Shiprocket";
            upd.abondonedOrder = true;

            // 1. Update User Orders list
            if (order.userId) {
                logToFile("partial_return_webhook.log", "CANCEL_FLOW_USER_LINK_REMOVAL", {
                    orderId: order._id,
                    userId: order.userId
                });
                await User.findByIdAndUpdate(order.userId, {
                    $pull: { orders: order._id }
                });
            }

            // 2. Update Partial Request state
            const partialRequestId = order.partialReturnRequests?.[0] || order.partialReturnRequests;
            const query = partialRequestId ? { _id: partialRequestId } : { returnOrderRef: order._id };
            const partialRequest = await PartialRequests.findOne(query);

            logToFile("partial_return_webhook.log", "CANCEL_FLOW_PARTIAL_REQUEST_RESET", {
                orderId: order._id,
                partialRequestFound: !!partialRequest,
                partialRequestId: partialRequest?._id
            });

            if (partialRequest) {
                if (!partialRequest.cancelledReturnOrders) {
                    partialRequest.cancelledReturnOrders = [];
                }
                partialRequest.cancelledReturnOrders.push(order._id);
                partialRequest.returnOrderRef = null;
                partialRequest.status = "Pending";
                partialRequest.isResolved = false;
                partialRequest.resolvedAt = null;
                await partialRequest.save();
            }

            // 3. Update Parent Order items & references
            const parentOrder = await Order.findOne({ returnOrderRef: order._id });

            logToFile("partial_return_webhook.log", "CANCEL_FLOW_PARENT_ORDER_REVERSION", {
                orderId: order._id,
                parentOrderFound: !!parentOrder,
                parentOrderId: parentOrder?._id
            });

            if (parentOrder) {
                // parentOrder.returnOrderRef.pull(order._id);
                order.items.forEach(reqIt => {
                    const parentIt = parentOrder.items.find(it =>
                        (it.product_id ? it.product_id == reqIt.product_id : false)
                        // || 
                        // (it.sku && it.sku === reqIt.sku) ||
                        // (it.variantName === reqIt.variantName)
                    );
                    if (parentIt) {
                        parentIt.isReturned = false;
                        parentIt.returnStatus = "Pending";
                        parentIt.returnOrderRef = undefined;
                    }
                });
                parentOrder.markModified("items");
                await parentOrder.save();
            }
            break;

        default:
            break;
    }

    // Update returnData structure
    upd.returnData = {
        ...order?.returnData,
        shippingStatus: upd.shippingStatus || srStatus,
        pickupScheduled: upd.pickupScheduled !== undefined ? upd.pickupScheduled : order?.pickupScheduled,
        pickup_scheduled_date: upd.pickupDate || order?.pickupDate,
        expectedDeliveryDate: upd.expectedDeliveryDate || order?.expectedDeliveryDate,
    };

    if (upd.awbCode) {
        upd.returnData.awb_code = upd.awbCode;
    }

    logToFile("partial_return_webhook.log", "WEBHOOK_UPDATES_GENERATED", {
        orderId: order._id,
        status: srStatus,
        updates: upd
    });

    return upd;
};

/* ------------------------------------------------------------------
   Shiprocket Webhook – handle post‑pickup events only
------------------------------------------------------------------- */

// Middleware to validate Shiprocket webhook token
const verifyShiprocketToken = (req, res, next) => {
    const receivedToken = req.headers["x-api-key"];
    const expectedToken = process.env.SHIPROCKET_WEBHOOK_TOKEN;

    if (receivedToken !== expectedToken) {
        return res.status(403).json({ error: "Unauthorized: Invalid token" });
    }

    next();
};

const shiprocketWebhook = asyncHandler(async (req, res) => {
    const p = req?.body;
    console.log("Shiprocket Webhook Response:", p);
    const srStatus = (
        p?.shipment_status ||
        p?.current_status ||
        ""
    ).toUpperCase();

    const or = [];

    if (p?.awb) {
        or.push({ awbCode: p.awb.toString() });
        or.push({ "returnData.awb_code": p.awb.toString() });
    }

    if (p?.order_id) {
        or.push({ shiprocketOrderId: String(p.order_id.toString()) });
        or.push({ "returnData.orderId": String(p.order_id.toString()) });
        or.push({ "returnData.order_id": String(p.order_id.toString()) });
    }

    if (p?.sr_order_id) {
        or.push({ shiprocketOrderId: String(p.sr_order_id.toString()) });
        or.push({ "returnData.orderId": String(p.sr_order_id.toString()) });
        or.push({ "returnData.order_id": String(p.sr_order_id.toString()) });
    }

    let order = null;
    if (or.length) {
        order = await Order.findOne({ $or: or });
    }

    /* 2) Locate order -------------------------------------------------------- */
    //   let order = await Order.findOne({
    //     $or: [
    //       { awbCode: p?.awb },
    //       { shiprocketOrderId: String(p?.order_id) },
    //       { shiprocketOrderId: String(p?.sr_order_id) },
    //       { "returnData.order_id": String(p?.order_id) },
    //       { "returnData.order_id": String(p?.sr_order_id) },
    //       { "returnData.awb_code": p?.awb },
    //     ],
    //   });

    // console.log("OrderId", mongoose.Types.ObjectId.isValid(p?.sr_order_id));
    if (!order) {
        console.log("Found Order", order);
        if (mongoose.Types.ObjectId.isValid(p?.order_id)) {
            const or = [];
            if (p?.awb) or.push({ awbCode: p?.awb.toString() });
            // if (p?.order_id) or.push({ _id: p?.order_id });
            order = await Order.findOne({
                $or: or,
            });
        } else if (mongoose.Types.ObjectId.isValid(String(p?.sr_order_id))) {
            const or = [];
            if (p?.awb) or.push({ awbCode: p?.awb.toString() });
            // if (p?.sr_order_id) or.push({ _id: p?.sr_order_id });

            order = await Order.findOne({
                $or: or,
            });
        } else {
            const or = [];
            if (p?.awb) or.push({ awbCode: p?.awb.toString() });
            if (p?.sr_order_id) or.push({ orderId: p?.sr_order_id.toString() });
            if (p?.order_id) or.push({ orderId: p?.order_id.toString() });

            order = await Order.findOne({
                $or: or,
            });
        }
    }

    if (!order) return res.status(200).json({ success: true, unknown: true });
    console.log("After Found Order", order);

    if (order.type === "Partial Return") {
        logToFile("partial_return_webhook.log", "WEBHOOK_RECEIVED", {
            orderId: order._id,
            orderIdStr: order.orderId,
            status: srStatus,
            body: p
        });

        const upd = await handlePartialReturnWebhook(order, p, srStatus);

        if (Array.isArray(p?.scans) && p?.scans?.length) {
            upd.scans = p.scans;
            upd.returnScans = p.scans;
        }

        if (Object.keys(upd)?.length > 0) {
            await Order.findByIdAndUpdate(order?._id, upd, { new: true }).exec();
        }
        return res.status(200).json(new ApiResponse(200, null, "Webhook processed for partial return"));
    }

    const isReturnOrder = order?.returnData?.isReturnInitiated;

    /* 4) Always overwrite scans if provided ---------------------------------- */
    let updatedOrder = null;
    if (Array.isArray(p?.scans) && p?.scans?.length) {
        // let payload = {};

        if (isReturnOrder) {
            let newReturnData = {
                ...order?.returnData,
                shippingStatus: srStatus
            };
            updatedOrder = await Order.findByIdAndUpdate(
                order._id,
                {
                    returnScans: p?.scans, shippingStatus: srStatus,
                    returnData: newReturnData
                },
                { new: true },
            ).exec();
        } else {
            updatedOrder = await Order.findByIdAndUpdate(
                order._id,
                {
                    scans: p?.scans, shippingStatus: srStatus
                },
                { new: true },
            ).exec();
        }


    }

    const prevShip = (order?.shippingStatus || "").toUpperCase();
    const nowISO = new Date().toISOString();
    let upd = {}; // fields to update in DB
    upd.shippingStatus = srStatus;
    // if (isReturnOrder) {
    //     upd.returnData = updatedOrder?.returnData || {};
    // }

    console.log("Updated: ", upd, updatedOrder);

    // Uses the module-level restoreStock and restoreStockCore helper functions defined above.

    /* 3) Status-specific logic ---------------------------------------------- */
    switch (srStatus) {
        case "PICKUP SCHEDULED":
            if (["NEW", "ACCEPTED", "SHIPPED"].includes(order?.status?.toUpperCase())) {
                upd.status = "Shipped";
                upd.pickupScheduled = true;
                upd.awbCode = p?.awb || order?.awbCode;
            }
            break;

        case "PICKED UP":
            if (
                ["NEW", "ACCEPTED", "SHIPPED"].includes(order?.status?.toUpperCase())
            ) {
                upd.status = "Shipped";
                upd.pickupScheduled = true;
                upd.awbCode = p?.awb || order?.awbCode;
            }

            if (prevShip !== "PICKED UP") {
                upd.pickupDate = nowISO;
            }
            break;

        case "SHIPPED":
        case "IN TRANSIT":
        case "OUT FOR PICKUP":
            if (["NEW", "ACCEPTED", "SHIPPED"].includes(order?.status?.toUpperCase())) {
                upd.status = "Shipped";
                upd.pickupScheduled = true;
                upd.awbCode = p?.awb || order?.awbCode;
            }
            break;

        case "DELIVERED":
            if (order.status !== "Delivered") {
                upd.status = "Delivered";
                upd.paymentStatus = "Paid";
                upd.deliveredAt = nowISO;
            }
            else if (order?.returnData && order?.returnData?.order_id) {
                upd.returnDeliveredAt = nowISO;
                upd.status = "Returned";
                upd.returnData = {
                    ...updatedOrder?.returnData,
                    status: "RETURNED",
                    shippingStatus: "Return Delivered"
                }

                // 🔁 attempt restoreStock up to 2 times
                await restoreStock({
                    order,
                    type: STOCK_TYPES.RETURN,
                });
                // if (!restored) {
                //     console.warn("⚠️ First restoreStock attempt failed, retrying...");
                //     restored = await restoreStock({
                //         type: STOCK_TYPES.RETURN,
                //     });
                // }
            }

            break;

        /* Late cancellation *after* pickup */
        case "CANCELED":
        case "CANCELLED": {
            const needsCancel =
                ["PICKED UP", "SHIPPED", "IN TRANSIT"].includes(prevShip) ||
                order?.status !== "Cancelled" ||
                order?.status !== "Delivered";
            if (order?.returnData) {
                upd.shippingStatus = "Return Cancelled";
                upd.reason = "Return Cancelled on Shiprocket";
                upd.returnData = {
                    ...updatedOrder?.returnData,
                    shippingStatus: "Return Cancelled"
                }
            } else if (needsCancel) {
                upd.status = "Cancelled";
                upd.reason = "Cancelled by courier after pickup";

                // 🔁 attempt restoreStock up to 2 times
                await restoreStock({
                    order,
                    type: STOCK_TYPES.CANCEL,
                });
                // if (!restored) {
                //     console.warn("⚠️ First restoreStock attempt failed, retrying...");
                //     restored = await restoreStock();
                // }
            }
            break;
        }

        /* RTO journey */
        case "RTO":
        case "RTO IN TRANSIT":
        case "SET RTO INITIATED":
            if (!order?.rtoInitiatedAt) upd.rtoInitiatedAt = nowISO;
            break;

        case "RTO INITIATED":
            if (!order?.rtoInitiatedAt) upd.rtoInitiatedAt = nowISO;
            upd.status = "RTO Initiated";
            break;

        case "RTO DELIVERED":
            upd.rtoDeliveredAt = nowISO;
            upd.status = "RTO Delivered";
            upd.status = "Returned";

            // 🔁 attempt restoreStock up to 2 times
            await restoreStock({
                order,
                type: STOCK_TYPES.RETURN,
            });
            // if (!restored) {
            //     console.warn("⚠️ First restoreStock attempt failed, retrying...");
            //     restored = await restoreStock({
            //         type: STOCK_TYPES.RETURN,
            //     });
            // }
            break;

        case "RETURN DELIVERED": {
            upd.returnDeliveredAt = nowISO;
            upd.status = "Returned";
            upd.returnData = {
                ...updatedOrder?.returnData,
                shippingStatus: "Return Delivered"
            }

            // 🔁 attempt restoreStock up to 2 times
            await restoreStock({
                order,
                type: STOCK_TYPES.RETURN,
            });
            // if (!restored) {
            //     console.warn("⚠️ First restoreStock attempt failed, retrying...");
            //     restored = await restoreStock({
            //         type: STOCK_TYPES.RETURN,
            //     });
            // }
            break;
        }

        default:
            // Any post-pickup status we didn’t foresee: just record it.
            break;
    }

    /* 5) Persist if anything changed ---------------------------------------- */
    if (Object.keys(upd)?.length > 0) {
        await Order.findByIdAndUpdate(order?._id, upd, { new: true }).exec();
    }

    return res.status(200).json(new ApiResponse(200, null, "Webhook processed"));
});

export {
    assignBestCourier,
    schedulePickup,
    generateLabel,
    generateManifest,
    generateLabelAndManifestBackground,
    checkPickupStatus,
    assignReturnCourier,
    scheduleReturnOrderPickup,
    shiprocketWebhook,
    verifyShiprocketToken,
    getCourierServiceability
};

// const shiprocketWebhook = asyncHandler(async (req, res) => {
//     const p = req?.body;
//     console.log("Shiprocket Webhook Response:", p);
//     const srStatus = (p?.shipment_status || p?.current_status || "").toUpperCase();

//     /* 2) Locate order -------------------------------------------------------- */
//     let order = await Order.findOne({
//         $or: [
//             { awbCode: p?.awb },
//             // { _id: String(p?.order_id) },
//             // { _id: String(p?.sr_order_id) },
//             { shiprocketOrderId: String(p?.order_id) },
//             { shiprocketOrderId: String(p?.sr_order_id) },
//             { "returnData.order_id": String(p?.order_id) },  // match return order_id
//             { "returnData.order_id": String(p?.sr_order_id) },  // match return order_id
//             { "returnData.awb_code": p?.awb }
//         ],
//     });
//     console.log("Found Order", order);
//     if (!order) {

//         if (mongoose.Types.ObjectId.isValid(p?.order_id)) {
//             order = await Order.findOne({
//                 $or: [
//                     { awbCode: p?.awb },
//                     { _id: p?.order_id },
//                 ],
//             });
//         } else if (mongoose.Types.ObjectId.isValid(String(p?.sr_order_id))) {
//             order = await Order.findOne({
//                 $or: [
//                     { awbCode: p?.awb },
//                     { _id: String(p?.sr_order_id) },
//                 ],
//             });
//         } else {
//             order = await Order.findOne({
//                 $or: [
//                     { awbCode: p?.awb },
//                     { orderId: String(p?.sr_order_id) },
//                     { orderId: String(p?.order_id) },
//                 ],
//             });
//         }

//     }
//     if (!order) return res.status(200).json({ success: true, unknown: true });
//     console.log("After Found Order", order);

//     /* 4) Always overwrite scans if provided ---------------------------------- */
//     if (Array.isArray(p?.scans) && p?.scans?.length) {
//         await Order.findByIdAndUpdate(order._id, {
//             scans: p?.scans,
//             shippingStatus: srStatus
//         }, { new: true }).exec();
//     };

//     /* 1) Ignore everything before PICKED UP ---------------------------------- */
//     // const postPickupStatuses = [
//     //     "PICKED UP", "SHIPPED", "IN TRANSIT", "OUT FOR PICKUP", "DELIVERED",
//     //     "CANCELED", "CANCELLED", "RETURN DELIVERED", "RETURN ACKNOWLEDGED",                      // late cancellation
//     //     "SET RTO INITIATED", "RTO INITIATED", "RTO IN TRANSIT", "RTO", "RTO DELIVERED", "RTO ACKNOWLEDGED"
//     // ];
//     // if (!postPickupStatuses.includes(srStatus))
//     //     return res.status(200).json({ success: true, ignored: true });

//     const prevShip = (order?.shippingStatus || "").toUpperCase();
//     const nowISO = new Date().toISOString();
//     const upd = {
//         // shippingStatus: srStatus
//     };      // always store latest

//     /* helper to restore stock exactly once */
//     const restoreStock = async () => {
//         if (order?._restockDone) return;
//         for (const it of order?.items) {
//             await Product.findByIdAndUpdate(it?.productId, {
//                 $inc: {
//                     totalStock: it?.quantity,
//                     [`variants.${it?.variantName}`]: it?.quantity,
//                 },
//             }).exec();
//         }
//         upd._restockDone = true;
//     };

//     /* 3) Status‑specific logic ---------------------------------------------- */
//     switch (srStatus) {
//         case "PICKED UP":
//             if (prevShip !== "PICKED UP") {
//                 upd.pickupDate = nowISO;
//                 if (["NEW", "ACCEPTED", "SHIPPED"].includes(order?.status?.toUpperCase()))
//                     upd.status = "Shipped";
//             }
//             break;

//         case "SHIPPED":
//         case "IN TRANSIT":
//         case "OUT FOR PICKUP":
//             if (["NEW", "ACCEPTED", "SHIPPED"].includes(order?.status?.toUpperCase()))
//                 upd.status = "Shipped";
//             break;

//         case "DELIVERED":
//             if (order.status !== "Delivered") {
//                 upd.status = "Delivered";
//                 upd.paymentStatus = "Paid";
//                 upd.deliveredAt = nowISO;
//             }
//             break;

//         /* Late cancellation *after* pickup */
//         case "CANCELED":
//             if (["PICKED UP", "SHIPPED", "IN TRANSIT"].includes(prevShip) || order?.status != "Cancelled") {
//                 upd.status = "Cancelled";
//                 upd.reason = "Cancelled by courier after pickup";
//                 await restoreStock();
//             }
//             break;
//         case "CANCELLED":
//             if (["PICKED UP", "SHIPPED", "IN TRANSIT"].includes(prevShip) || order?.status != "Cancelled") {
//                 upd.status = "Cancelled";
//                 upd.reason = "Cancelled by courier after pickup";
//                 await restoreStock();
//             }
//             break;

//         /* RTO journey */
//         case "RTO":
//         case "RTO IN TRANSIT":
//         case "SET RTO INITIATED":
//             if (!order?.rtoInitiatedAt) upd.rtoInitiatedAt = nowISO;
//             // if (order?.status !== "Returned") upd.status = "Returned";
//             break;

//         case "RTO INITIATED":
//             if (!order?.rtoInitiatedAt) upd.rtoInitiatedAt = nowISO;
//             upd.status = "RTO Initiated";
//             // if (order?.status !== "Returned") upd.status = "Returned";
//             break;

//             case "RTO DELIVERED":
//                 upd.rtoDeliveredAt = nowISO;
//                 upd.status = "RTO Delivered";
//             break;

//         case "RETURN DELIVERED":
//             upd.retrunDeliveredAt = nowISO;
//             break;

//         case "RTO ACKNOWLEDGED":
//             upd.status = "Returned";
//             await restoreStock();
//             break;

//         case "RETURN ACKNOWLEDGED":
//             // upd.rtoDeliveredAt = nowISO;
//             upd.status = "Returned";
//             await restoreStock();
//             break;

//         default:
//             // Any post‑pickup status we didn’t foresee: just record it.
//             break;
//     }

//     /* 5) Persist if anything changed ---------------------------------------- */
//     if (Object.keys(upd)?.length > 1) {             // >1 because shippingStatus always set
//         await Order.findByIdAndUpdate(order?._id, upd, { new: true }).exec();
//     }

//     return res.status(200).json(new ApiResponse(200, null, "Webhook processed"));
// });
