import axios from 'axios';
import { ApiResponse } from '../utils/ApiResponse.js';

const shiprocketAuth = async (req, res, next) => {
    try {
        const now = Date.now();

        let shiprocketToken = null;
        let tokenExpiry = null;

        if (!shiprocketToken || now > tokenExpiry) {
            const { data } = await axios.post('https://apiv2.shiprocket.in/v1/external/auth/login', {
                email: process.env.SHIPROCKET_EMAIL,
                password: process.env.SHIPROCKET_PASSWORD
            });

            shiprocketToken = data.token;
            tokenExpiry = now + 8 * 60 * 60 * 1000; // 8 hours
        }

        req.shiprocketToken = shiprocketToken;
        // return res.status(200).json(
        //     new ApiResponse(200, { shiprocketToken: req.shiprocketToken }, 'Shiprocket Logged In Successfully')
        // );
        next();
    } catch (err) {
        console.error("Shiprocket login error", err?.response?.data || err);
        return res.status(500).json({ success: false, message: 'Shiprocket authentication failed' });
    }
};

export {
    shiprocketAuth
}