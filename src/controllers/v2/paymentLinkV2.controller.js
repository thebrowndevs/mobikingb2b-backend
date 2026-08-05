import { PaymentLink } from "../../models/payment_link.model.js";
import { Order } from "../../models/order.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { initiatePhonepePaymentLink } from "../../services/phonepe.service.js";
import { initiateRazorpayPaymentLink } from "../../services/razorpay.service.js";
import { CompanyDetails } from "../../models/company_details.model.js";
import axios from "axios";

export const generatePaymentLinkV2 = asyncHandler(async (req, res) => {
    const {
        orderId, amount,
        name, email, phoneNo,
        gateway
    } = req.body;

    if (!gateway || !["razorpay", "phonepe"].includes(gateway)) {
        throw new ApiError(400, "Invalid or missing gateway type");
    }

    // Check gateway toggles in CompanyDetails
    const settings = await CompanyDetails.findOne();
    if (settings && settings.paymentGatewaySettings) {
        if (gateway === "phonepe" && !settings.paymentGatewaySettings.enablePhonepe) {
            throw new ApiError(400, "PhonePe payment gateway is currently disabled.");
        }
        if (gateway === "razorpay" && !settings.paymentGatewaySettings.enableRazorpay) {
            throw new ApiError(400, "Razorpay payment gateway is currently disabled.");
        }
    }

    try {
        let linkResponse = {};
        const reqOrigin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
        const backendOrigin = `${req.protocol}://${req.get('host')}`;

        if (gateway === "phonepe") {
            const tempLink = await initiatePhonepePaymentLink(orderId, amount, phoneNo, reqOrigin, backendOrigin);
            linkResponse = {
                id: tempLink.id,
                short_url: tempLink.short_url
            };

            // Send SMS to user mobile using SMS Mantra
            // if (phoneNo) {
            //     try {
            //         const cleanPhone = phoneNo.replace(/[^0-9]/g, "");
            //         const smsMessage = `Dear Customer, payment link for your Mobiking order is ${tempLink.short_url}. Team Mobiking.`;
            //         await axios.get('https://api.mylogin.co.in/api/v2/SendSMS', {
            //             params: {
            //                 ApiKey: process.env.MY_SMSMANTRA_API_KEY,
            //                 ClientId: process.env.MY_SMSMANTRA_CLIENT_ID,
            //                 SenderId: process.env.MY_SMSMANTRA_SENDER_ID,
            //                 Message: smsMessage,
            //                 MobileNumbers: cleanPhone
            //             }
            //         });
            //         console.log(`Payment link SMS dispatched successfully to ${cleanPhone}`);
            //     } catch (smsError) {
            //         console.error("Failed to send payment link SMS via SMS Mantra:", smsError);
            //     }
            // }
        } else {
            // razorpay
            const tempLink = await initiateRazorpayPaymentLink(orderId, amount, name, phoneNo);
            linkResponse = {
                id: tempLink.id,
                short_url: tempLink.short_url
            };
        }

        const newPaymentLink = new PaymentLink({
            gateway,
            orderId, amount,
            name, email, phoneNo,
            paymentLink_id: linkResponse.id,
            link: linkResponse.short_url
        });

        await newPaymentLink.save();

        res.status(200).json(
            new ApiResponse(200,
                { payment_link: linkResponse.short_url },
                "Link generated successfully"
            )
        );
    } catch (error) {
        console.error("Error creating payment link:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Failed to generate link"
        });
    }
});
