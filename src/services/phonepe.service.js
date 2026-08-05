import { StandardCheckoutClient, Env, StandardCheckoutPayRequest, PrefillUserLoginDetails, RefundRequest } from "@phonepe-pg/pg-sdk-node";

/**
 * Helper to retrieve a singleton instance of PhonePe SDK Client.
 */
export const getPhonepeClient = () => {
    const merchantId = process.env.PHONEPE_MERCHANT_ID || "PGOMT";
    const saltKey = process.env.PHONEPE_SALT_KEY || "099eb0cd-02cf-4e2a-8aca-3e6c6a4d20a4";
    const saltIndex = parseInt(process.env.PHONEPE_SALT_INDEX, 10) || 1;

    let envStr = process.env.PHONEPE_ENV;
    if (!envStr) {
        envStr = (merchantId === "PGOMT") ? "staging" : "production";
    }

    const env = envStr === "production" ? Env.PRODUCTION : Env.SANDBOX;

    return StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex, env);
};

/**
 * Queries transaction status directly from PhonePe SDK.
 * Reused in webhook, callback controller, and cron jobs.
 */
export const checkPhonepeOrderStatus = async (merchantTransactionId) => {
    try {
        const client = getPhonepeClient();
        const response = await client.getOrderStatus(merchantTransactionId);
        if (response && response.state === "COMPLETED") {
            const paymentId = response.transactionId || response.orderId || "N/A";
            const paymentInstrument = response.paymentInstrument || (response.data && response.data.paymentInstrument) || {};
            const utr = paymentInstrument.utr || "N/A";
            const paymentMode = paymentInstrument.type || "N/A";
            return { isPaid: true, paymentId, utr, paymentMode, rawResponse: response };
        }
        return { isPaid: false, rawResponse: response };
    } catch (error) {
        console.error("Error querying PhonePe order status:", error);
        return { isPaid: false, error };
    }
};

/**
 * Initiates standard checkout redirect page for client checkout flows.
 */
export const initiatePhonepePayment = async (orderId, totalAmount, phone, reqOrigin, backendOrigin) => {
    const client = getPhonepeClient();
    const baseBackend = process.env.BACKEND_URL || backendOrigin;
    const baseFrontend = process.env.FRONTEND_URL || reqOrigin;
    const frontendSuccessUrl = `${baseFrontend}/account?tab=orders`;
    const frontendFailureUrl = `${baseFrontend}/checkout`;
    const redirectUrl = `${baseBackend}/api/v2/orders/online/phonepe-callback?id=${orderId}&successRedirect=${encodeURIComponent(frontendSuccessUrl)}&failureRedirect=${encodeURIComponent(frontendFailureUrl)}`;
    const formattedPhone = phone ? phone.replace(/[^0-9]/g, "") : "";

    const payRequestBuilder = StandardCheckoutPayRequest.builder()
        .merchantOrderId(orderId)
        .amount(Math.round(totalAmount * 100)) // Amount in paise
        .redirectUrl(redirectUrl);

    if (formattedPhone) {
        const userLoginDetails = PrefillUserLoginDetails.builder()
            .phoneNumber(formattedPhone)
            .build();
        payRequestBuilder.prefillUserLoginDetails(userLoginDetails);
    }

    const payRequest = payRequestBuilder.build();
    const payResponse = await client.pay(payRequest);

    if (!payResponse || !payResponse.redirectUrl) {
        console.error("PhonePe Pay Initiation Request Rejection:", payResponse);
        throw new Error("Failed to establish PhonePe session.");
    }

    return { redirectUrl: payResponse.redirectUrl };
};

/**
 * Initiates PhonePe PG Checkout session link to act as a shareable invoice/payment link.
 */
export const initiatePhonepePaymentLink = async (orderId, amount, phone, reqOrigin, backendOrigin) => {
    const paymentLinkId = "PL_" + Date.now() + Math.floor(Math.random() * 1000);
    const client = getPhonepeClient();
    const baseBackend = process.env.BACKEND_URL || backendOrigin;
    const baseFrontend = process.env.FRONTEND_URL || reqOrigin;
    const frontendSuccessUrl = `${baseFrontend}/account?tab=orders`;
    const frontendFailureUrl = `${baseFrontend}/checkout`;
    const redirectUrl = `${baseBackend}/api/v2/orders/online/phonepe-callback?id=${paymentLinkId}&successRedirect=${encodeURIComponent(frontendSuccessUrl)}&failureRedirect=${encodeURIComponent(frontendFailureUrl)}`;
    const formattedPhone = phone ? phone.replace(/[^0-9]/g, "") : "";

    const payRequestBuilder = StandardCheckoutPayRequest.builder()
        .merchantOrderId(paymentLinkId)
        .amount(Math.round(amount * 100))
        .redirectUrl(redirectUrl);

    if (formattedPhone) {
        const userLoginDetails = PrefillUserLoginDetails.builder()
            .phoneNumber(formattedPhone)
            .build();
        payRequestBuilder.prefillUserLoginDetails(userLoginDetails);
    }

    const payRequest = payRequestBuilder.build();
    const payResponse = await client.pay(payRequest);

    if (!payResponse || !payResponse.redirectUrl) {
        console.error("PhonePe Payment Link Initiation Failed:", payResponse);
        throw new Error("Failed to establish PhonePe link session.");
    }

    return {
        id: paymentLinkId,
        short_url: payResponse.redirectUrl
    };
};

/**
 * Initiates PhonePe payment refund
 */
export const refundPhonepePayment = async (originalMerchantOrderId, refundAmount) => {
    try {
        const client = getPhonepeClient();
        const refundId = `ref_${originalMerchantOrderId}_${Date.now()}`;
        const request = RefundRequest.builder()
            .amount(Math.round(refundAmount * 100)) // Amount in paise
            .merchantRefundId(refundId)
            .originalMerchantOrderId(originalMerchantOrderId)
            .build();
        const response = await client.refund(request);
        return { success: true, refundId: response.refundId || refundId, rawResponse: response };
    } catch (error) {
        console.error("PhonePe Refund execution failure:", error);
        return { success: false, error: error.message || error };
    }
};
