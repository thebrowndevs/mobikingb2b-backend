import Razorpay from 'razorpay';

export const razorpayConfig = () => {
    return new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
};

/**
 * Checks with Razorpay API if any payments for the given orderId are captured.
 * Returns { isPaid: true, paymentId: String } or { isPaid: false }.
 */
export const checkRazorpayOrderStatus = async (razorpayOrderId) => {
    if (!razorpayOrderId) {
        return { isPaid: false };
    }
    try {
        const razorpay = razorpayConfig();
        const payments = await razorpay.orders.fetchPayments(razorpayOrderId);
        if (payments?.items && payments.items.length > 0) {
            const capturedPayment = payments.items.find(p => p.status === 'captured');
            if (capturedPayment) {
                return { isPaid: true, paymentId: capturedPayment.id };
            }
        }
        return { isPaid: false };
    } catch (error) {
        console.error(`Error checking Razorpay status for order ${razorpayOrderId}:`, error.message);
        return { isPaid: false };
    }
};

/**
 * Initiates Razorpay payment order.
 */
export const initiateRazorpayPayment = async (orderDbId, amount) => {
    const razorpay = razorpayConfig();
    const options = {
        amount: Math.round(amount * 100),
        currency: "INR",
        receipt: orderDbId.toString(),
    };
    const response = await razorpay.orders.create(options);
    if (!response || !response.id) {
        throw new Error("Could not create Razorpay order link");
    }
    return response;
};

/**
 * Initiates Razorpay Payment Link.
 */
export const initiateRazorpayPaymentLink = async (orderId, amount, name, phoneNo) => {
    const razorpay = razorpayConfig();
    const response = await razorpay.paymentLink.create({
        amount: Math.round(amount * 100), // Amount in paise
        currency: "INR",
        accept_partial: false,
        description: `Payment for Order #${orderId}`,
        customer: {
            name: name,
            contact: phoneNo,
        },
        notify: {
            sms: true,
        },
        notes: {
            orderId,
        },
        reminder_enable: true,
    });
    if (!response || !response.short_url) {
        throw new Error("Could not create Razorpay payment link");
    }
    return response;
};

/**
 * Initiates Razorpay payment refund (with instant speed support)
 */
export const refundRazorpayPayment = async (razorpayPaymentId, refundAmount) => {
    try {
        const razorpay = razorpayConfig();
        const response = await razorpay.payments.refund(razorpayPaymentId, {
            amount: String(Math.round(refundAmount * 100)), // in paise as string
            speed: "optimum"
        });
        return { success: true, refundId: response.id, rawResponse: response };
    } catch (error) {
        console.error("Razorpay Refund execution failure:", error);
        return { success: false, error: error.message || error };
    }
};
