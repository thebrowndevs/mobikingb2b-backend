import axios from "axios";

const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";

/**
 * Fetch Order Details from Shiprocket by Shiprocket Order ID
 */
export const getShiprocketOrderDetails = async (shiprocketOrderId, token) => {
    const response = await axios.get(
        `${SHIPROCKET_BASE_URL}/orders/show/${shiprocketOrderId}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    return response?.data?.data;
};

/**
 * Create Return Order on Shiprocket
 */
export const createShiprocketReturnOrder = async (payload, token) => {
    const { data } = await axios.post(
        `${SHIPROCKET_BASE_URL}/orders/create/return`,
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    return data;
};

/**
 * Assign Return Courier AWB on Shiprocket
 */
export const assignShiprocketReturnCourier = async ({ shipmentId, courierId }, token) => {
    const { data } = await axios.post(
        `${SHIPROCKET_BASE_URL}/courier/assign/awb`,
        { shipment_id: shipmentId, courier_id: courierId, is_return: 1 },
        { headers: { Authorization: `Bearer ${token}` } }
    );
    return data;
};

/**
 * Generate Return Pickup Token & Date on Shiprocket
 */
export const generateShiprocketReturnPickup = async (shipmentIds, token) => {
    const shipment_id = Array.isArray(shipmentIds) ? shipmentIds : [shipmentIds];
    const { data } = await axios.post(
        `${SHIPROCKET_BASE_URL}/courier/generate/pickup`,
        { shipment_id },
        { headers: { Authorization: `Bearer ${token}` } }
    );
    return data;
};

/**
 * Track AWB Status on Shiprocket
 */
export const trackShiprocketAwb = async (awbCode, token) => {
    const response = await axios.get(
        `${SHIPROCKET_BASE_URL}/courier/track/awb/${awbCode}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    return response?.data;
};
