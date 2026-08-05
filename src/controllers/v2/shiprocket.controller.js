import mongoose from "mongoose";
import { Order } from "../../models/order.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
    getShiprocketOrderDetails,
    assignShiprocketReturnCourier,
    generateShiprocketReturnPickup,
    trackShiprocketAwb
} from "../../services/shiprocket.service.js";

/* ─────────────────────────────────────────────────────────────────────
   assignPartialReturnCourier (v2)
   - Assigns return courier for child Partial Return Order using shiprocket.service.js
───────────────────────────────────────────────────────────────────── */
export const assignPartialReturnCourier = asyncHandler(async (req, res) => {
    const { orderId: myOrderId, courierId } = req.body;
    const token = req.shiprocketToken;

    if (!myOrderId || !mongoose.Types.ObjectId.isValid(myOrderId)) {
        return res.status(400).json({
            success: false,
            message: "Valid Order ID not found"
        });
    }

    let freshOrder = await Order.findById(myOrderId);
    if (!freshOrder) {
        return res.status(400).json({
            success: false,
            message: "Partial Return Order not found"
        });
    }

    const shipmentId = freshOrder?.returnData?.shipment_id;
    const shiprocketOrderId = freshOrder?.returnData?.order_id;

    if (!shipmentId) {
        return res.status(400).json({
            success: false,
            message: "Shipment ID missing in return data"
        });
    }

    if (!courierId) {
        return res.status(400).json({
            success: false,
            message: "Courier ID missing"
        });
    }

    if (freshOrder?.returnData?.awb_code) {
        return res.status(400).json({
            success: false,
            message: "Courier already assigned"
        });
    }

    const data = await assignShiprocketReturnCourier({ shipmentId, courierId }, token);

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
            data
        });
    }

    freshOrder.returnData = {
        ...freshOrder?.returnData,
        shippingStatus: "Return Courier Assigned",
        awb_code: awbCode,
        courier_name: courierName,
        assigned_date_time: { date: new Date() }
    };
    freshOrder.awbCode = awbCode;
    freshOrder.courierName = courierName;
    freshOrder.courierAssignedAt = new Date();
    freshOrder.shippingStatus = "Return Courier Assigned";
    await freshOrder.save();

    let pickupInfo = null;
    if (shiprocketOrderId) {
        try {
            const shipData = await getShiprocketOrderDetails(shiprocketOrderId, token);
            if (shipData?.status === "RETURN PICKUP GENERATED") {
                pickupInfo = {
                    pickupScheduled: true,
                    pickup_scheduled_date: shipData?.shipments?.pickup_scheduled_date || shipData.pickup_date,
                    shippingStatus: "Return Pickup Scheduled",
                    expectedDeliveryDate: shipData?.shipments?.etd || null
                };
                freshOrder.returnData = {
                    ...freshOrder?.returnData,
                    ...pickupInfo
                };
                freshOrder.pickupScheduled = true;
                freshOrder.pickupDate = shipData?.shipments?.pickup_scheduled_date || shipData.pickup_date;
                freshOrder.expectedDeliveryDate = shipData?.shipments?.etd || null;
                freshOrder.status = "Return Shipped";
                freshOrder.shippedAt = new Date();
                freshOrder.shippingStatus = pickupInfo.shippingStatus;
                await freshOrder.save();
            }
        } catch (err) {
            console.warn("Auto pickup check warning:", err?.response?.data || err?.message);
        }
    }

    return res.status(200).json({
        success: true,
        message: `Return Courier Assigned${pickupInfo ? " and Pickup Scheduled" : ""}`,
        data: { order: freshOrder }
    });
});

/* ─────────────────────────────────────────────────────────────────────
   schedulePartialReturnPickup (v2)
   - Schedules return pickup for child Partial Return Order using shiprocket.service.js
───────────────────────────────────────────────────────────────────── */
export const schedulePartialReturnPickup = asyncHandler(async (req, res) => {
    const { orderId: myOrderId } = req.body;
    const token = req.shiprocketToken;

    if (!myOrderId || !mongoose.Types.ObjectId.isValid(myOrderId)) {
        return res.status(400).json({
            success: false,
            message: "Valid Order ID not found"
        });
    }

    let freshOrder = await Order.findById(myOrderId);
    if (!freshOrder) {
        return res.status(400).json({
            success: false,
            message: "Partial Return Order not found"
        });
    }

    const shipmentId = freshOrder?.returnData?.shipment_id;

    if (!shipmentId) {
        return res.status(400).json({
            success: false,
            message: "Shipment ID missing"
        });
    }

    if (freshOrder?.returnData?.pickup_scheduled_date) {
        return res.status(400).json({
            success: false,
            message: "Return Pickup already scheduled",
            pickupDate: freshOrder?.returnData?.pickup_scheduled_date
        });
    }

    const data = await generateShiprocketReturnPickup(shipmentId, token);

    const pickupTokenNumber = data?.response?.pickup_token_number;
    const pickupDate = data?.response?.pickup_scheduled_date;
    const pickupSlot = data?.response?.pickup_token_data?.slot;

    if (!pickupDate) {
        return res.status(502).json({
            success: false,
            message: "Pickup scheduling failed",
            data
        });
    }

    let etd = null;
    if (freshOrder?.returnData?.awb_code) {
        try {
            const trackRes = await trackShiprocketAwb(freshOrder.returnData.awb_code, token);
            etd = trackRes?.tracking_data?.etd || null;
        } catch (err) {
            console.warn("Track AWB warning:", err?.response?.data || err?.message);
        }
    }

    freshOrder.returnData = {
        ...freshOrder?.returnData,
        pickupScheduled: true,
        shippingStatus: "Return Pickup Scheduled",
        pickup_token_number: pickupTokenNumber,
        pickup_scheduled_date: pickupDate,
        pickupSlot: pickupSlot || null,
        expectedDeliveryDate: etd
    };
    freshOrder.pickupScheduled = true;
    freshOrder.pickupTokenNumber = pickupTokenNumber;
    freshOrder.pickupDate = pickupDate;
    freshOrder.pickupSlot = pickupSlot || null;
    freshOrder.expectedDeliveryDate = etd;
    freshOrder.status = "Return Shipped";
    freshOrder.shippedAt = new Date();
    freshOrder.shippingStatus = "Return Pickup Scheduled";
    await freshOrder.save();

    return res.status(200).json({
        success: true,
        message: "Return Pickup scheduled successfully",
        data: data,
        order: freshOrder,
        pickupDate,
        pickupSlot: pickupSlot || null
    });
});
