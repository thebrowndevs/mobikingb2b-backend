import Razorpay from "razorpay";
import { asyncHandler } from "../utils/asyncHandler.js";
import { PaymentLink } from "../models/payment_link.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

const razorpayConfig = () => {
    const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    return razorpay;
}

const generatePaymentLink = asyncHandler(async (req, res) => {
    const {
        orderId, amount,
        name, email, phoneNo
    } = req.body;

    try {

        const razorpay = await razorpayConfig();

        const response = await razorpay.paymentLink.create({
            amount: amount * 100, // Amount in paise
            currency: "INR",
            accept_partial: false,
            // reference_id: orderId,
            description: `Payment for Order #${orderId}`,
            customer: {
                name: name,
                // email: email,
                contact: phoneNo,
            },
            notify: {
                sms: true,
                // email: true,
            },
            notes: {
                orderId,
            },
            reminder_enable: true,
            //   callback_url: "https://yourdomain.com/payment-success",
            //   callback_method: "get",
        });

        console.log(response);

        if (!response.status) {
            throw new ApiError("Could not create link")
        }

        const newPaymentLink = new PaymentLink({
            gateway: 'razorpay',
            orderId, amount,
            name, email, phoneNo,
            paymentLink_id: response.id,
            link: response.short_url
        })

        await newPaymentLink.save();

        res.status(200).json(
            new ApiResponse(200,
                { payment_link: response.short_url },
                "Link generated successfully"
            )
        );
    } catch (error) {
        console.error("Error creating payment link", error);
        res.status(500).json({
            success: false,
            message: error.description
        });
    }
});

const getAllPaymentLinks = asyncHandler(async (req, res) => {
    const allPaymentLinks = await PaymentLink.find({}).populate("orderId");
    if (!allPaymentLinks)
        throw new ApiError(404, "Payment Links not found");

    return res.status(200).json(
        new ApiResponse(200,
            allPaymentLinks,
            "Payment Links Fetched Succefully"
        )
    )
});

export {
    generatePaymentLink,
    getAllPaymentLinks
}