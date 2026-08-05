import nodemailer from 'nodemailer';

// Create reusable transporter object using SMTP transport
const createTransporter = () => {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || 587,
        secure: false, // true for 465, false for other ports
        auth: {
            user: process.env.SMTP_USER, // Your email
            pass: process.env.SMTP_PASS, // Your email password or app password
        },
    });
};

/**
 * Send email verification link to user
 * @param {string} email - User's email address
 * @param {string} token - Verification token
 * @param {string} userName - User's name (optional)
 */
export const sendVerificationEmail = async (email, token, userName = 'User') => {
    try {
        const transporter = createTransporter();

        // Frontend URL - update this based on your frontend URL
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const verificationUrl = `${frontendUrl}/verify-email/${token}`;

        const mailOptions = {
            from: `"${process.env.APP_NAME || 'MobiKing E-Commerce'}" <${process.env.SMTP_USER}>`,
            to: email,
            subject: 'Verify Your Email Address',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #333;">Email Verification</h2>
                    <p>Hello ${userName},</p>
                    <p>Thank you for registering with us! Please verify your email address by clicking the button below:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${verificationUrl}" 
                           style="background-color: #4CAF50; color: white; padding: 12px 30px; 
                                  text-decoration: none; border-radius: 5px; display: inline-block;">
                            Verify Email
                        </a>
                    </div>
                    <p>Or copy and paste this link in your browser:</p>
                    <p style="color: #666; word-break: break-all;">${verificationUrl}</p>
                    <p style="color: #999; font-size: 12px; margin-top: 30px;">
                        This link will expire in 24 hours. If you didn't create an account, please ignore this email.
                    </p>
                </div>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Verification email sent: %s', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('Error sending verification email:', error);
        throw new Error('Failed to send verification email');
    }
};

/**
 * Send password reset link to user
 * @param {string} email - User's email address
 * @param {string} token - Password reset token
 * @param {string} userName - User's name (optional)
 */
export const sendPasswordResetEmail = async (email, token, userName = 'User') => {
    try {
        const transporter = createTransporter();

        // Frontend URL - update this based on your frontend URL
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const resetUrl = `${frontendUrl}/reset-password/${token}?email=${email}`;

        const mailOptions = {
            from: `"${process.env.APP_NAME || 'MobiKing E-Commerce'}" <${process.env.SMTP_USER}>`,
            to: email,
            subject: 'Password Reset Request',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #333;">Password Reset Request</h2>
                    <p>Hello ${userName},</p>
                    <p>We received a request to reset your password. Click the button below to create a new password:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetUrl}" 
                           style="background-color: #2196F3; color: white; padding: 12px 30px; 
                                  text-decoration: none; border-radius: 5px; display: inline-block;">
                            Reset Password
                        </a>
                    </div>
                    <p>Or copy and paste this link in your browser:</p>
                    <p style="color: #666; word-break: break-all;">${resetUrl}</p>
                    <p style="color: #999; font-size: 12px; margin-top: 30px;">
                        This link will expire in 1 hour. If you didn't request a password reset, please ignore this email.
                    </p>
                </div>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Password reset email sent: %s', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('Error sending password reset email:', error);
        throw new Error('Failed to send password reset email');
    }
};

/**
 * Send OTP verification email to user
 * @param {string} email - User's email address
 * @param {string} otp - OTP code
 * @param {string} userName - User's name (optional)
 */
export const sendOtpEmail = async (email, otp, userName = 'User') => {
    try {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            console.log("Mocking OTP Email (Missing Credentials):");
            console.log(`To: ${email}`);
            console.log(`OTP: ${otp}`);
            return { success: true, messageId: 'mock-id' };
        }

        const transporter = createTransporter();

        const mailOptions = {
            from: `"${process.env.APP_NAME || 'MobiKing E-Commerce'}" <${process.env.SMTP_USER}>`,
            to: email,
            subject: 'Your Verification Code',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #333;">Verification Code</h2>
                    <p>Hello ${userName},</p>
                    <p>Your verification code is:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <h1 style="color: #4CAF50; letter-spacing: 5px; font-size: 32px; margin: 0;">${otp}</h1>
                    </div>
                    <p>This code will expire in 10 minutes.</p>
                    <p style="color: #999; font-size: 12px; margin-top: 30px;">
                        If you didn't request this code, please ignore this email.
                    </p>
                </div>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('OTP email sent: %s', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('Error sending OTP email:', error);
        throw new Error('Failed to send OTP email');
    }
};
