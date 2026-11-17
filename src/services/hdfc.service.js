import axios from "axios";

/**
 * Returns configuration parameters for HDFC SmartGateway
 */
export const getHdfcConfig = () => {
    const baseUrl = (process.env.HDFC_GATEWAY_URL || "https://smartgateway.hdfcuat.bank.in").replace(/\/+$/, "");
    const apiKey = process.env.HDFC_API_KEY || "";
    const merchantId = process.env.HDFC_MERCHANT_ID || "";

    return { baseUrl, apiKey, merchantId };
};

/**
 * Helper to build HTTP headers required for HDFC SmartGateway Basic Auth APIs
 */
export const getHdfcHeaders = () => {
    const { apiKey, merchantId } = getHdfcConfig();
    const encodedKey = Buffer.from(apiKey.trim()).toString("base64");

    const headers = {
        "Authorization": `Basic ${encodedKey}`,
        "Content-Type": "application/json"
    };

    if (merchantId) {
        headers["x-merchantid"] = merchantId.trim();
    }

    return headers;
};

/**
 * Initiates an HDFC SmartGateway payment session (Server-to-Server)
 * 
 * @param {Object} params
 * @param {string} params.orderId - Merchant's unique order identifier
 * @param {number} params.amount - Order total in INR
 * @param {string} [params.customerPhone] - Customer mobile number
 * @param {string} [params.customerEmail] - Customer email address
 * @param {string} [params.customerId] - Customer / User ID
 * @param {string} params.returnUrl - URL where HDFC redirects the customer post-payment
 * @param {string} [params.description] - Order description
 * @returns {Promise<Object>} Session response with payment URL
 */
export const initiateHdfcSession = async ({
    orderId,
    amount,
    customerPhone,
    customerEmail,
    customerId,
    returnUrl,
    description
}) => {
    const { baseUrl, apiKey } = getHdfcConfig();

    if (!apiKey) {
        throw new Error("HDFC_API_KEY is not configured in environment variables.");
    }

    const payload = {
        order_id: String(orderId),
        amount: Number(amount).toFixed(2),
        currency: "INR",
        customer_id: String(customerId || "GUEST"),
        customer_phone: customerPhone ? String(customerPhone).trim().replace(/^\+91/, "") : "9999999999",
        customer_email: customerEmail && customerEmail.includes("@") ? customerEmail.trim() : "customer@mobiking.in",
        payment_page_client_id: process.env.HDFC_CLIENT_ID || "hdfcmaster",
        action: "paymentPage",
        return_url: returnUrl,
        description: description || `Mobiking B2B Order #${orderId}`
    };

    try {
        const response = await axios.post(`${baseUrl}/session`, payload, {
            headers: getHdfcHeaders(),
            timeout: 15000
        });

        const data = response.data;
        const redirectUrl = data?.payment_links?.web || data?.payment_link || "";

        return {
            success: true,
            sessionId: data?.id,
            orderId: data?.order_id || String(orderId),
            redirectUrl,
            status: data?.status || "NEW",
            rawResponse: data
        };
    } catch (error) {
        console.error("HDFC initiateSession API Error:", error.response?.data || error.message);
        throw new Error(
            error.response?.data?.message ||
            error.response?.data?.error_message ||
            error.message ||
            "Failed to initiate HDFC SmartGateway session"
        );
    }
};

/**
 * Checks the authoritative order status directly from HDFC SmartGateway (Server-to-Server)
 * 
 * @param {string} orderId - Merchant's order identifier
 * @returns {Promise<Object>} Order status object
 */
export const checkHdfcOrderStatus = async (orderId) => {
    const { baseUrl, apiKey } = getHdfcConfig();

    if (!apiKey) {
        throw new Error("HDFC_API_KEY is not configured in environment variables.");
    }

    try {
        const response = await axios.get(`${baseUrl}/orders/${encodeURIComponent(orderId)}`, {
            headers: getHdfcHeaders(),
            timeout: 15000
        });

        const data = response.data;
        const status = (data?.status || "UNKNOWN").toUpperCase();
        const paymentId = data?.txn_id || data?.id || "N/A";
        const amount = data?.amount;
        const isPaid = status === "CHARGED";
        const isPending = ["AUTHORIZING", "PENDING", "PENDING_VBV", "STARTED", "NEW"].includes(status);

        return {
            success: true,
            orderId: data?.order_id || orderId,
            status, // 'CHARGED', 'AUTHORIZING', 'AUTHORIZATION_FAILED', etc.
            isPaid,
            isPending,
            paymentId,
            amount,
            rawResponse: data
        };
    } catch (error) {
        console.error(`HDFC checkOrderStatus Error for ${orderId}:`, error.response?.data || error.message);
        return {
            success: false,
            orderId,
            status: "ERROR",
            isPaid: false,
            error: error.response?.data?.message || error.message
        };
    }
};
