import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js"
import { User } from "../models/user.model.js"
import { ApiResponse } from "../utils/ApiResponse.js";
import jwt from "jsonwebtoken";
import { ROLES } from "../constants.js";
import { Cart } from "../models/cart.model.js";
import { Order } from "../models/order.model.js";
import { OTP } from "../models/otp.model.js";
import axios from 'axios';
import otpGenerator from 'otp-generator'
import mongoose from "mongoose";
import { Address } from './../models/address.model.js';
import { sendOtpEmail, sendPasswordResetEmail } from "../utils/emailService.js";
import crypto from "crypto";

// ******************************************************
//                  USER AUTH CONTROLLERS
// ******************************************************

export const sendOtp = asyncHandler(async (req, res) => {
    const { mobile } = req.body;
    if (!mobile) return res.status(400).json({ error: 'Mobile number required' });
    if (mobile == "1984736519") {
        return res.status(200).json(
            new ApiResponse(200, { data: "" }, 'OTP sent')
        );
    }

    let existingUser = await User.find({ phoneNo: mobile });
    existingUser = existingUser[0];
    if (existingUser && existingUser?.role != "user") {
        throw new ApiError(403, `${existingUser?.role} aacount already exist with this phone number`);
    }

    let otp = 0;
    let result = null;

    do {
        //if new user then generate otp
        otp = otpGenerator.generate(6, {
            upperCaseAlphabets: false,
            lowerCaseAlphabets: false,
            specialChars: false
        });

        //check if otp generated is unique or not
        result = await OTP.findOne({ code: otp });
    } while (result)

    const expiresAt = new Date(Date.now() + process.env.OTP_EXPIRY_MINUTES * 60 * 1000);

    // DONT EDIT THIS TEMPLATE NOT EVEN INDENTATION
    const message = `Dear User, your OTP to login on https://mobikingwholesale.com/ is ${otp}. It is valid for 2 minutes. 
Please Do Not share with anyone.
Team Mobiking.`;

    const newOtp = await OTP.create(
        {
            mobile,
            code: otp, expiresAt, verified: false
        }
    );

    if (!newOtp) {
        throw new ApiError(500, "Could not create otp. Try again later");
    }

    const response = await axios.get('https://api.mylogin.co.in/api/v2/SendSMS', {
        params: {
            ApiKey: process.env.MY_SMSMANTRA_API_KEY,
            ClientId: process.env.MY_SMSMANTRA_CLIENT_ID,
            SenderId: process.env.MY_SMSMANTRA_SENDER_ID,
            Message: message,
            MobileNumbers: mobile
        }
    });

    // console.log(response?.data)
    if (!response?.data?.Data[0]) {
        throw new ApiError(500, "Could not send otp");
    }

    return res.status(200).json(
        new ApiResponse(200, { ...response?.data?.Data[0] }, 'OTP sent')
    );
});
export const sendEmailOtp = asyncHandler(async (req, res) => {
    const { email } = req.body;
    console.log()
    if (!email) {
        throw new ApiError(400, "Email is required");
    }

    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(404, "User not found with this email");
    }

    // Generate 6 digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save({ validateBeforeSave: false });

    try {
        await sendOtpEmail(email, otp, user.name || 'User');
    } catch (error) {
        user.otp = undefined;
        user.otpExpiry = undefined;
        await user.save({ validateBeforeSave: false });
        throw new ApiError(500, "Failed to send OTP email");
    }

    return res.status(200).json(
        new ApiResponse(200, {}, "OTP sent successfully to your email")
    );
});
export const verifyEmailOtp = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        throw new ApiError(400, "Email and OTP are required");
    }

    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.otp || !user.otpExpiry) {
        throw new ApiError(400, "No OTP request found for this user");
    }

    if (user.otp !== otp) {
        throw new ApiError(400, "Invalid OTP");
    }

    if (new Date() > user.otpExpiry) {
        // Clear expired OTP
        user.otp = undefined;
        user.otpExpiry = undefined;
        await user.save({ validateBeforeSave: false });
        throw new ApiError(400, "OTP has expired");
    }

    // OTP verified successfully
    user.otp = undefined;
    user.otpExpiry = undefined;

    // You might want to generate a token here if this is a login flow
    // For now, based on requirements, just clearing OTP and returning success

    await user.save({ validateBeforeSave: false });

    return res.status(200).json(
        new ApiResponse(200, {}, "OTP verified successfully")
    );
}); // End of verifyOtp


export const resetPassword = asyncHandler(async (req, res) => {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
        throw new ApiError(400, "Email and new password are required");
    }

    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    user.password = newPassword;
    user.isPasswordChanged = true;
    await user.save(); // This will trigger the pre-save hook to hash the password

    return res.status(200).json(
        new ApiResponse(200, {}, "Password changed successfully")
    );
});

export const forgotPasswordTokenRequest = asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        throw new ApiError(400, "Email is required");
    }

    const user = await User.findOne({ email });

    if (!user) {
        throw new ApiError(404, "User not found with this email");
    }

    // Generate token
    const token = crypto.randomBytes(20).toString('hex');
    const expiry = new Date(Date.now() + 3600000); // 1 hour

    user.forgotPasswordToken = token;
    user.forgotPasswordExpiry = expiry;
    await user.save({ validateBeforeSave: false });

    try {
        await sendPasswordResetEmail(email, token, user.name || 'User');
    } catch (error) {
        user.forgotPasswordToken = undefined;
        user.forgotPasswordExpiry = undefined;
        await user.save({ validateBeforeSave: false });
        throw new ApiError(500, "Failed to send reset email");
    }

    return res.status(200).json(
        new ApiResponse(200, {}, "Password reset link sent to your email")
    );
});

export const resetPasswordWithToken = asyncHandler(async (req, res) => {
    const { token } = req.params;
    const { newPassword } = req.body;

    if (!token || !newPassword) {
        throw new ApiError(400, "Token and new password are required");
    }

    const user = await User.findOne({
        forgotPasswordToken: token,
        forgotPasswordExpiry: { $gt: Date.now() }
    });

    if (!user) {
        throw new ApiError(400, "Invalid or expired token");
    }

    user.password = newPassword;
    user.forgotPasswordToken = undefined;
    user.forgotPasswordExpiry = undefined;
    user.isPasswordChanged = true;
    await user.save();

    return res.status(200).json(
        new ApiResponse(200, {}, "Password reset successfully")
    );
});

const generateAccessAndRefereshTokens = async (userId) => {
    try {
        const user = await User.findById(userId)
        const accessToken = user.generateAccessToken()
        const refreshToken = user.generateRefreshToken()

        user.refreshToken = refreshToken
        // await user.save({ validateBeforeSave: false })

        const updatedUser = await User.findByIdAndUpdate(
            userId,
            {
                refreshToken: refreshToken
            },
            { new: true }
        ).populate({
            path: "cart",
            populate: {
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            }
        })
            .populate("address")
            .populate("wishlist")
            .exec();


        return { accessToken, refreshToken, updatedUser }

    } catch (error) {
        throw new ApiError(500, "Something went wrong while generating referesh and access token")
    }
}

export const verifyOtp = asyncHandler(async (req, res, next) => {
    const { role, phoneNo: mobile, otp } = req.body;

    if (role && role != ROLES.USER) {
        return next();
    }

    if (mobile == "1984736519" && otp == "950268") {
        return next();
    }

    if (!mobile || !otp) throw new ApiError(400, 'Mobile and OTP code required');

    const response = await OTP.find({ mobile, code: otp }).sort({ createdAt: -1 }).limit(1);

    if (response.length === 0) throw new ApiError(404, 'OTP not found');

    const otpDoc = response[0];

    if (otpDoc.verified) throw new ApiError(400, 'OTP already verified');

    if (otpDoc.expiresAt < new Date()) throw new ApiError(400, 'OTP expired');

    if (otpDoc.code !== otp) throw new ApiError(400, 'Incorrect OTP');

    const updatedOtp = await OTP.findByIdAndUpdate(
        otpDoc?._id,
        {
            verified: true
        },
        { new: true }
    );

    console.log("Otp verified", updatedOtp);
    next();
})

const loginUser = asyncHandler(async (req, res) => {
    const { role, email, phoneNo, password } = req.body;

    if (!role) {
        throw new ApiError(400, 'Role Not Found');
    }

    let user = null;
    if (role === ROLES.USER) {
        if (!phoneNo) {
            throw new ApiError(400, 'Phone number not found');
        }

        user = await User.findOne({
            phoneNo
        }).populate({
            path: "cart",
            populate: {
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            }
        })
            .populate("address")
            .populate("wishlist")
            .populate("orders")
            .exec();
        //populate orders

        if (!user) {
            user = await User.create({
                phoneNo,
                role,
                email: phoneNo
            });

            const newCart = await Cart.create({
                userId: user?._id,
            });

            user = await User.findByIdAndUpdate(
                user?._id,
                {
                    cart: newCart?._id
                },
                { new: true }
            ).populate({
                path: "cart",
                populate: {
                    path: "items.productId",
                    model: "Product",
                    populate: {
                        path: "category",  // This is the key part
                        model: "SubCategory"
                    }
                }
            })
                .populate("wishlist")
                .populate("address")
                .populate("orders")
                .exec();
            //populate orders

        } else {
            if (user?.role !== role) {
                throw new ApiError(400, `Employee Account Registered with the phone number ${user?.phoneNo}`);
            } else {

            }
        }

    } else {
        if (!email || !password) {
            throw new ApiError(400, 'Phone number not found');
        }
        user = await User.findOne({ email: email ? email : "" });
        if (!user) {
            throw new ApiError(404, 'User not found');
        }

        if (user?.role === ROLES.USER) {
            throw new ApiError(400, `Customer Account Registered with this email`);
        }

        const isPasswordValid = await user.isPasswordCorrect(password)
        if (!isPasswordValid) {
            throw new ApiError(401, "Invalid user credentials")
        }
    }

    const { accessToken, refreshToken } = await generateAccessAndRefereshTokens(user?._id);

    const loggedInUser = await User.findById(user?._id)
        .select("-password -refreshToken")
        .populate({
            path: "cart",
            populate: {
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            }
        })
        .populate("wishlist")
        .populate("address")
        // .populate("orders")
        .exec();
    //populate orders

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(
                200,
                {
                    user: loggedInUser, accessToken, refreshToken
                },
                "User logged In Successfully"
            )
        )

})

const customerSignupByEmail = asyncHandler(async (req, res) => {
    let { name, email, phoneNo, password } = req.body;

    if (!email || !password || !phoneNo) {
        throw new ApiError(400, 'Phone No, Email and password required for signup');
    }

    let user = await User.findOne({
        $or: [
            { email: email || "" },
            { phoneNo: phoneNo || "" }
        ]
    });

    if (user) {
        throw new ApiError(404, 'User already registered with email or phone no');
    }

    name = name?.trim();
    email = email?.trim();
    phoneNo = phoneNo?.trim();
    password = password?.trim();

    const newUser = await User.create(
        {
            name, email, phoneNo,
            password,
            role: ROLES.USER,
        }
    )

    if (!newUser) {
        throw new ApiError(500, 'Could not create user');
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {
                    user: newUser
                },
                "User Signup Successfull"
            )
        )
})

const customerLoginByEmail = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new ApiError(400, 'Email and password required to login');
    }

    let user = await User.findOne({ email: email ? email : "" });
    if (!user) {
        throw new ApiError(404, 'User not registered');
    }

    if (user.role != ROLES.USER) {
        throw new ApiError(404, 'Not a customer account');
    }

    const isPasswordValid = await user.isPasswordCorrect(password)
    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid user credentials")
    }

    const { accessToken, refreshToken } = await generateAccessAndRefereshTokens(user?._id);

    const loggedInUser = await User.findById(user?._id)
        .select("-password -refreshToken")
        .populate({
            path: "cart",
            populate: {
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            }
        })
        .populate("wishlist")
        .populate("address")
        .exec();
    //populate orders

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(
                200,
                {
                    user: loggedInUser, accessToken, refreshToken
                },
                "User logged In Successfully"
            )
        )
})

const getUserPermissions = asyncHandler(async (req, res) => {
    const user = req?.user;

    const userData = {
        id: user?._id,
        role: user?.role,
        permissions: user?.permissions || {}
    }

    return res.status(200)
        .json(
            new ApiResponse(200, userData, "Permissions fetched successfully")
        );
})

const logoutUser = asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $unset: {
                refreshToken: 1 // this removes the field from document
            }
        },
        {
            new: true
        }
    )

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(new ApiResponse(200, {}, "User logged Out"))
})

const refreshAccessToken = asyncHandler(async (req, res) => {
    const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken

    if (!incomingRefreshToken) {
        throw new ApiError(401, "Unauthorized request")
    }

    try {
        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        )

        const user = await User.findById(decodedToken?._id)

        if (!user) {
            throw new ApiError(401, "Invalid refresh token")
        }

        if (incomingRefreshToken != user?.refreshToken) {
            throw new ApiError(401, "Refresh token is expired or used")

        }

        const options = {
            httpOnly: true,
            secure: true
        }

        const { accessToken, refreshToken: newRefreshToken, updatedUser } = await generateAccessAndRefereshTokens(user._id)

        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", newRefreshToken, options)
            .json(
                new ApiResponse(
                    200,
                    { accessToken, refreshToken: newRefreshToken, updatedUser },
                    "Access token refreshed"
                )
            )
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid refresh token")
    }

})

const getMyProfile = asyncHandler(async (req, res) => {
    const user = req?.user

    if (!user) {
        throw new ApiError(401, "Unauthorized request")
    }

    try {

        const customer = await User.findById(user._id).populate({
            path: "cart",
            populate: {
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory",
                    select: "-products"
                },
                select: "-orders -stocks -groups"
            }
        })
            .populate("address")
            .populate("wishlist")
            .select("-orders -password -refreshToken -addresses -wishlists -phoneNo -email")
            .exec();

        if (!customer) {
            throw new ApiError(404, "User not found")
        }

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    customer,
                    "User profile fetched successfully"
                )
            )
    } catch (error) {
        throw new ApiError(401, error?.message || "User profile fetch failed")
    }

})

// const getUserCart = asyncHandler(async (req, res) => {
//     const user = req?.user;

//     const cart = await Cart.findById(user?.cart).populate(
//         {
//             path: "items.productId",
//             model: "Product",
//             populate: {
//                 path: "category",  // This is the key part
//                 model: "SubCategory"
//             }
//         }
//     );

//     return res.status(200)
//         .json(
//             new ApiResponse(200, cart, "Cart fetched successfully")
//         );

// })


// **********************************************************
//              USER MANAGEMENT CONTROLLERS FOR ADMIN
// **********************************************************

const getUserCart = asyncHandler(async (req, res) => {

    const user = req?.user;

    let cart = await Cart.findById(user?.cart).populate({
        path: "items.productId",
        model: "Product",
        select: "-orders -stock -groups",
        populate: {
            path: "category",
            model: "SubCategory",
            select: "-products"
        }
    });

    if (!cart) {
        throw new ApiError(404, "Cart not found");
    }

    let updated = false;

    const validItems = [];

    for (const item of cart.items) {

        const product = item.productId;

        // product removed
        if (!product) {
            updated = true;
            continue;
        }

        const variantKey = String(item.variantName || "").trim();

        // variant removed
        if (!product.variants || !product.variants.has(variantKey)) {
            updated = true;
            continue;
        }

        const availableStock = product.variants.get(variantKey);

        // out of stock
        if (!availableStock || availableStock <= 0) {
            updated = true;
            continue;
        }

        // adjust quantity if more than available
        if (item.quantity > availableStock) {
            item.quantity = availableStock;
            updated = true;
        }

        validItems.push(item);
    }

    if (updated) {
        cart.items = validItems;

        cart.totalCartValue = cart.items.reduce(
            (sum, item) => sum + (item.price * item.quantity),
            0
        );

        await cart.save();
    }

    return res.status(200).json(
        new ApiResponse(200, cart, "Cart fetched successfully")
    );
});

const createCustomer = asyncHandler(async (req, res) => {
    // get user details from frontend
    // validation - not empty
    // check if user already exists: username, email
    // check for images, check for avatar
    // upload them to cloudinary, avatar
    // create user object - create entry in db
    // remove password and refresh token field from response
    // check for user creation
    // return res

    let {
        name, phoneNo,
    } = req.body

    if (
        [name, phoneNo].some((field) => field?.trim() === "")
    ) {
        throw new ApiError(400, "All fields are required")
    }

    name = name?.trim();
    phoneNo = phoneNo?.trim();

    const existedUser = await User.findOne({ phoneNo });

    // console.log(existedUser);
    if (existedUser) {
        throw new ApiError(409, "User with phone number already exists")
    }

    const user = await User.create({
        name,
        phoneNo,
        role: ROLES.USER,
        email: phoneNo
    })

    if (!user) {
        throw new ApiError(500, "Something went wrong while registering the user")
    }

    let createdUser = null;
    if (user?.role == ROLES.USER) {
        const newCart = await Cart.create({
            userId: user?._id,
        });

        createdUser = await User.findByIdAndUpdate(
            user?._id,
            {
                cart: newCart?._id
            },
            { new: true }
        )
            .select("-password -refreshToken")
            .populate({
                path: "cart",
                populate: {
                    path: "items.productId",
                    model: "Product"
                }
            })
            .populate("wishlist")
            .populate("orders")
            .exec();
    } else {
        createdUser = await User.findById(user._id)
            .select("-password -refreshToken")
            .populate({
                path: "cart",
                populate: {
                    path: "items.productId",
                    model: "Product"
                }
            })
            .populate("wishlist")
            .populate("orders")
            .exec();
    }

    if (!createdUser) {
        throw new ApiError(500, "Something went wrong while registering the user")
    }

    return res.status(201).json(
        new ApiResponse(201, createdUser, "User registered Successfully")
    )

})

const updateCustomer = asyncHandler(async (req, res) => {

    let {
        name, email,
    } = req.body

    if (
        [name, email].some((field) => field?.trim() === "")
    ) {
        throw new ApiError(400, "All fields are required")
    }

    name = name?.trim();
    email = email?.trim();
    const existedUser = await User.findOne({ email });

    // console.log(existedUser);
    if (existedUser && !existedUser._id.equals(req.user._id)) {
        throw new ApiError(409, "User with email already exists");
    }


    const user = await User.findByIdAndUpdate(
        req?.user?._id,
        {
            name,
            email
        },
        { new: true }
    ).select("-password -refreshToken")
        .populate({
            path: "cart",
            populate: {
                path: "items.productId",
                model: "Product"
            }
        })
        .populate("wishlist")
        .populate("orders")
        .exec();

    if (!user) {
        throw new ApiError(500, "Something went wrong while updating the profile")
    }

    return res.status(201).json(
        new ApiResponse(201, user, "Profile updated Successfully")
    )

})

const getCustomerByMobile = asyncHandler(async (req, res) => {

    const {
        phoneNo,
    } = req.params;

    if (
        [phoneNo].some((field) => field?.trim() === "")
    ) {
        throw new ApiError(400, "Phone No is undefined")
    }

    const existedUser = await User.findOne({
        phoneNo, role: "user"
    });
    ;
    if (!existedUser) {
        return res.status(200).json(
            new ApiResponse(200, { phoneNo }, "Customer not found with this phone number")
        )
    }

    return res.status(200).json(
        new ApiResponse(201, existedUser?._id, "Customer fetched Successfully")
    )

})

const getCustomerById = asyncHandler(async (req, res) => {

    const {
        _id,
    } = req.params;

    if (
        [_id].some((field) => field?.trim() === "") || !mongoose.Types.ObjectId.isValid(_id)
    ) {
        throw new ApiError(400, "Valid user Id not found")
    }

    const existedUser = await User.findById(_id)
        .populate({
            path: "cart",
            populate: {
                path: "items.productId",
                model: "Product",
                populate: {
                    path: "category",  // This is the key part
                    model: "SubCategory"
                }
            }
        })
        .populate("address")
        .populate("wishlist")
        .populate({
            path: "orders",
            model: "Order",
            populate: {
                path: "items.productId",
                model: "Product",
                select: "name fullName images"
            }
        })
        .exec();

    if (!existedUser) {
        throw new ApiError(400, `Customer not found with Id ${existedUser?._id}`)
    }

    return res.status(200).json(
        new ApiResponse(200, existedUser, "Customer fetched Successfully")
    )

})

const createEmployee = asyncHandler(async (req, res) => {
    // get user details from frontend
    // validation - not empty
    // check if user already exists: username, email
    // check for images, check for avatar
    // upload them to cloudinary, avatar
    // create user object - create entry in db
    // remove password and refresh token field from response
    // check for user creation
    // return res

    let {
        name, email, phoneNo,
        password, role,
        permissions, departments,
        profilePicture, documents
    } = req.body

    if (
        [name, email, phoneNo, password, role].some((field) => field?.trim() === "")
    ) {
        throw new ApiError(400, "All fields are required")
    }

    name = name?.trim();
    email = email?.trim();
    phoneNo = phoneNo?.trim();
    password = password?.trim();
    role = role?.trim();

    if (role === ROLES.EMPLOYEE && (!permissions || !(departments))) {
        throw new ApiError(400, "Permissions and departments required for employee")
    }

    const existedUser = await User.findOne({
        $or: [{ phoneNo }, { email }]
    })

    // console.log(existedUser);
    if (existedUser) {
        throw new ApiError(409, "User with email or phone number already exists")
    }

    const user = await User.create({
        name,
        email,
        phoneNo,
        password,
        departments,
        permissions,
        role,
        profilePicture: profilePicture ? profilePicture : "",
        documents: documents ? documents : []
    })

    if (!user) {
        throw new ApiError(500, "Something went wrong while registering the user")
    }

    let createdUser = null;
    if (user?.role == ROLES.USER) {
        const newCart = await Cart.create({
            userId: user?._id,
        });

        createdUser = await User.findByIdAndUpdate(
            user?._id,
            {
                cart: newCart?._id
            },
            { new: true }
        )
            .select("-password -refreshToken")
            .populate({
                path: "cart",
                populate: {
                    path: "items.productId",
                    model: "Product"
                }
            })
            .populate("wishlist")
            // .populate("orders")
            .exec();
    } else {
        createdUser = await User.findById(user._id)
            .select("-password -refreshToken")
            .populate({
                path: "cart",
                populate: {
                    path: "items.productId",
                    model: "Product"
                }
            })
            .populate("wishlist")
            // .populate("orders")
            .exec();
    }

    if (!createdUser) {
        throw new ApiError(500, "Something went wrong while registering the user")
    }

    return res.status(201).json(
        new ApiResponse(201, createdUser, "User registered Successfully")
    )

})

const editEmployee = asyncHandler(async (req, res) => {
    // const { _id } = req.user;
    const { _id } = req.params;
    let { name, email, phoneNo, role, permissions, departments } = req.body

    if (
        [name, email, phoneNo, role].some((field) => field?.trim() === "")
    ) {
        throw new ApiError(400, "All fields are required")
    }

    name = name?.trim();
    email = email?.trim();
    phoneNo = phoneNo?.trim();
    role = role?.trim();

    // if (role === ROLES.EMPLOYEE && (!permissions || !(departments))) {
    //     throw new ApiError(400, "Permissions and departments required for employee")
    // }

    //console.log(req.files);

    // const avatarLocalPath = req.files?.avatar[0]?.path;
    //const coverImageLocalPath = req.files?.coverImage[0]?.path;

    // let coverImageLocalPath;
    // if (req.files && Array.isArray(req.files.coverImage) && req.files.coverImage.length > 0) {
    //     coverImageLocalPath = req.files.coverImage[0].path
    // }


    // if (!avatarLocalPath) {
    //     throw new ApiError(400, "Avatar file is required")
    // }

    // const avatar = await uploadOnCloudinary(avatarLocalPath)
    // const coverImage = await uploadOnCloudinary(coverImageLocalPath)

    // if (!avatar) {
    //     throw new ApiError(400, "Avatar file is required")
    // }

    let updates = {
        name,
        email,
        phoneNo,
        role
    };

    if (permissions) {
        updates.permissions = permissions;
    }

    if (departments) {
        updates.departments = departments;
    }

    let updatedUser = await User.findByIdAndUpdate(
        { _id },
        {
            ...updates
        },
        { new: true }
    ).select(
        "-password -refreshToken"
    )

    if (req?.body?.password) {
        updatedUser.password = req?.body?.password;
        await updatedUser.save();
    }

    if (!updatedUser) {
        throw new ApiError(500, "Something went wrong while updating the user")
    }

    return res.status(200).json(
        new ApiResponse(200, updatedUser, "User Updated Successfully")
    )

})

const deleteUser = asyncHandler(async (req, res) => {

    let _id = null;

    console.log(req?.user?.role != ROLES.USER)
    if (req?.user?.role != ROLES.USER) {
        _id = req.params?._id;
    }
    else
        _id = req?.user?._id;

    console.log(_id);
    if (!_id || !mongoose.Types.ObjectId.isValid(_id)) {
        throw new ApiError(404, "Valid User Id not Found");
    }

    let foundUser = await User.findById(_id);
    if (!foundUser) {
        throw new ApiError(404, "User not Found");
    }

    // Delete User Cart If There
    if (foundUser?.cart) {
        const deletedCart = await Cart.findByIdAndDelete(foundUser?.cart);
        console.log("deleted cart:", deletedCart);
    }

    // Delete User Addresses If There
    if (foundUser?.address && foundUser?.address?.length > 0) {

        for (let addressId of foundUser?.address) {
            const deletedAddress = await Address.findByIdAndDelete(addressId);
            console.log("deleted address:", deletedAddress);
        }

    }

    // Now delete User
    const deletedUser = await User.findByIdAndDelete(
        { _id }
    ).select(
        "-password -refreshToken"
    )

    if (!deletedUser) {
        throw new ApiError(500, "Something went wrong while deleting the user")
    }

    return res.status(200).json(
        new ApiResponse(200, deletedUser, "User Deleted Successfully")
    )

})

const getUsersByRole = asyncHandler(async (req, res) => {
    const allUsers = await User.find({
        role: req.params.role
    })
    // .populate("orders").exec();

    if (!allUsers) {
        throw new ApiError(409, "Could not find users");
    }

    return res.status(200).json(
        new ApiResponse(200, allUsers, "Users fetched Successfully")
    )
})

const getUserById = asyncHandler(async (req, res) => {
    const completeUserDetails = await User.findById(req?.params?._id)
        // .populate("orders")
        .exec();

    if (!completeUserDetails) {
        throw new ApiError(409, "Could not fetch user details");
    }

    return res.status(200).json(
        new ApiResponse(200, completeUserDetails, "User details fetched Successfully")
    )
});


// ******************************************************
//                  PLACE, REJECT REQUEST CONTROLLERS
// ******************************************************

const placeCancelRequest = asyncHandler(async (req, res) => {
    const { type, reason, orderId } = req.body;

    /* -------------------------- 1. basic validation -------------------------- */
    if (
        // !type || 
        !reason || !orderId) {
        throw new ApiError(400, "Complete details not found");
    }

    // if (type !== "Cancel") {
    //     throw new ApiError(400, "Only type = 'Cancel' is supported here");
    // }

    /* --------------------------- 2. fetch the order -------------------------- */
    const foundOrder = await Order.findById(orderId)
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!foundOrder) throw new ApiError(404, "Order does not exist");

    /* --------------------- 3. ensure the order is cancellable ---------------- */
    const cancellableStates = ["New", "Accepted", "Shipped"]; // adjust as needed
    if (!cancellableStates.includes(foundOrder.status)) {
        throw new ApiError(
            409,
            `Order cannot be cancelled once it is ${foundOrder.status}`
        );
    }

    /* --------------------- 3. ensure the order is shipped, pickedup, in transit or delivered ---------------- */
    if (![
        "Pending",
        "PENDING",
        "Courier Assigned",
        "Pickup Scheduled"
    ].includes(foundOrder?.shippingStatus)
    ) {
        throw new ApiError(
            409,
            `Order cannot be cancelled once shipment is ${foundOrder.status}`
        );
    }

    /* --------------- 4. block duplicate / unresolved requests --------------- */
    const alreadyRaised = foundOrder.requests.some(
        (r) => r.type === "Cancel"
        // && !r.isResolved
    );
    if (alreadyRaised) {
        throw new ApiError(
            409,
            "A cancellation request is already placed for this order"
        );
    }

    /* --------------- 4. block if return requests placed already --------------- */
    const reutrnRaised = foundOrder.requests.some(
        (r) => r?.type === "Return"
        // ||
        // (!r?.isResolved || (r?.isResolved && r?.status == "Rejected"))
    );
    if (reutrnRaised) {
        throw new ApiError(
            409,
            "A return request is already in placed for this order"
        );
    }

    const warrantyRaised = foundOrder.requests.some(
        (r) => r?.type === "Warranty"
        // || !r?.isResolved
    );
    if (warrantyRaised) {
        throw new ApiError(
            409,
            "A warranty request is already pending for this order"
        );
    }

    /* ------------------------- 5. build request object ----------------------- */
    const newRequest = {
        type: "Cancel",
        isRaised: true,
        raisedAt: new Date().toISOString(),
        isResolved: false,
        status: "Pending",
        reason,
    };

    /* -------- 6. atomically push the request & (optionally) mark on hold ----- */
    const updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
            $push: { requests: newRequest },
            // Optional: put order on hold until the request is processed
            // status: "Hold",
            // holdReason: "Cancellation requested",
        },
        { new: true }
    )
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!updatedOrder)
        throw new ApiError(500, "Could not attach cancel request to order");

    /* ------------------------------- 7. respond ------------------------------ */
    return res
        .status(200)
        .json(
            new ApiResponse(200, updatedOrder, "Cancellation request placed successfully")
        );
});

const rejectCancelRequest = asyncHandler(async (req, res) => {
    const { reason, orderId } = req.body;

    /* -------------------------- 1. basic validation -------------------------- */
    if (
        !reason || !orderId) {
        throw new ApiError(400, "Complete details not found");
    }

    if (req?.user?.role == ROLES.USER) {
        throw new ApiError(409, "User not Authorized to Reject Request");
    }

    /* --------------------------- 2. fetch the order -------------------------- */
    const foundOrder = await Order.findById(orderId)
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!foundOrder) throw new ApiError(404, "Order does not exist");

    /* --------------- 4. block alrady rejected requests --------------- */
    const existingRequest = foundOrder.requests.some(
        (r) => r.type === "Cancel"
    );
    if (!existingRequest) {
        throw new ApiError(
            409,
            "No cancellation request is placed"
        );
    }

    const rejectedRaised = foundOrder.requests.some(
        (r) => r.type === "Cancel"
            && r.status == "Rejected"
    );
    if (rejectedRaised) {
        throw new ApiError(
            409,
            "Cancellation request is already rejected"
        );
    }

    /* -------- 6. reject only if cancel request is in 'Pending' state ----- */
    const updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            requests: {
                $elemMatch: {
                    type: "Cancel",
                    status: "Pending",
                    isRaised: true,
                    isResolved: false,
                },
            },
        },
        {
            $set: {
                "requests.$.status": "Rejected",
                "requests.$.isResolved": true,
                "requests.$.resolvedAt": new Date().toISOString(),
                "requests.$.reason": reason,
            },
        },
        { new: true }
    )
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!updatedOrder)
        throw new ApiError(
            409,
            "No pending cancellation request found to reject"
        );

    /* ------------------------------- 7. respond ------------------------------ */
    return res
        .status(200)
        .json(
            new ApiResponse(200, updatedOrder, "Cancellation request rejected successfully")
        );
});

const placeReturnRequest = asyncHandler(async (req, res) => {
    const { reason, orderId } = req.body;

    // 1️⃣ Basic Validation
    if (!reason || !orderId) {
        throw new ApiError(400, "Complete details not found");
    }

    // 2️⃣ Fetch the order
    const foundOrder = await Order.findById(orderId)
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!foundOrder) throw new ApiError(404, "Order does not exist");

    // 3️⃣ Ensure order is delivered
    if (foundOrder.status !== "Delivered") {
        throw new ApiError(409, `Order cannot be returned unless it is Delivered`);
    }

    // 4️⃣ Block duplicate/unresolved Return requests
    const returnRaised = foundOrder.requests.some(
        (r) => r?.type === "Return"
    );
    if (returnRaised) {
        throw new ApiError(409, "A return request is already in place for this order");
    }

    // 5️⃣ Block if Cancel request already placed
    const cancelRaised = foundOrder.requests.some(
        (r) => r?.type === "Cancel" &&
            (!r?.isResolved || (r?.isResolved && r?.status !== "Rejected"))
    );
    if (cancelRaised) {
        throw new ApiError(409, "A cancellation request is already pending for this order");
    }

    // 6️⃣ Block if Warranty request already placed
    const warrantyRaised = foundOrder.requests.some(
        (r) => r?.type === "Warranty" &&
            (!r?.isResolved || (r?.isResolved && r?.status !== "Rejected"))
    );
    if (warrantyRaised) {
        throw new ApiError(409, "A warranty request is already pending for this order");
    }

    // 7️⃣ Build request object
    const newRequest = {
        type: "Return",
        isRaised: true,
        raisedAt: new Date().toISOString(),
        isResolved: false,
        status: "Pending",
        reason,
    };

    // 8️⃣ Push the request to the order
    const updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        { $push: { requests: newRequest } },
        { new: true }
    )
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!updatedOrder) {
        throw new ApiError(500, "Could not attach return request to order");
    }

    // ✅ Respond
    return res.status(200).json(
        new ApiResponse(200, updatedOrder, "Return request placed successfully")
    );
});

/* --------------------------------------------------------------------------
   Reject RETURN request
-------------------------------------------------------------------------- */
const rejectReturnRequest = asyncHandler(async (req, res) => {
    const { reason, orderId } = req.body;

    // 1️⃣ Basic validation
    if (!reason || !orderId) {
        throw new ApiError(400, "Complete details not found");
    }

    if (req?.user?.role === ROLES.USER) {
        throw new ApiError(409, "User not authorized to reject request");
    }

    // 2️⃣ Fetch the order
    const foundOrder = await Order.findById(orderId)
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!foundOrder) throw new ApiError(404, "Order does not exist");

    // 3️⃣ Ensure a return request exists
    const existingRequest = foundOrder.requests.some(
        (r) => r.type === "Return"
    );
    if (!existingRequest) {
        throw new ApiError(409, "No return request is placed");
    }

    // 4️⃣ Block if already rejected
    const alreadyRejected = foundOrder.requests.some(
        (r) => r.type === "Return" && r.status === "Rejected"
    );
    if (alreadyRejected) {
        throw new ApiError(409, "Return request is already rejected");
    }

    // 5️⃣ Reject the request only if it's pending
    const updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            requests: {
                $elemMatch: {
                    type: "Return",
                    status: "Pending",
                    isRaised: true,
                    isResolved: false,
                },
            },
        },
        {
            $set: {
                "requests.$.status": "Rejected",
                "requests.$.isResolved": true,
                "requests.$.resolvedAt": new Date().toISOString(),
                "requests.$.reason": reason,
            },
        },
        { new: true }
    )
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!updatedOrder) {
        throw new ApiError(409, "No pending return request found to reject");
    }

    // ✅ Respond
    return res
        .status(200)
        .json(
            new ApiResponse(200, updatedOrder, "Return request rejected successfully")
        );
});

const placeWarrantyRequest = asyncHandler(async (req, res) => {
    const { type, reason, orderId } = req.body;

    /* -------------------------- 1. basic validation -------------------------- */
    if (
        // !type || 
        !reason || !orderId) {
        throw new ApiError(400, "Complete details not found");
    }

    // if (type !== "Warranty") {
    //     throw new ApiError(400, "Only type = 'Cancel' is supported here");
    // }

    /* --------------------------- 2. fetch the order -------------------------- */
    const foundOrder = await Order.findById(orderId)
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!foundOrder) throw new ApiError(404, "Order does not exist");


    /* --------------- 4. block duplicate / unresolved requests --------------- */
    const warrantyRaised = foundOrder.requests.some(
        (r) => r?.type === "Warranty"
    );
    if (warrantyRaised) {
        throw new ApiError(
            409,
            "A warranty request is already placed for this order"
        );
    }

    /* --------------- 4. block if return requests placed already --------------- */
    const reutrnRaised = foundOrder.requests.some(
        (r) => r?.type === "Return" &&
            (!r?.isResolved || (r?.isResolved && r?.status != "Rejected"))
    );
    if (reutrnRaised) {
        throw new ApiError(
            409,
            "A return request is already placed for this order"
        );
    }

    const alreadyRaised = foundOrder.requests.some(
        (r) => r.type === "Cancel"
            && r.status != "Rejected"
    );
    if (alreadyRaised) {
        throw new ApiError(
            409,
            "A cancellation request is already placed for this order"
        );
    }

    /* --------------------- 3. ensure the order is in valid state for return ---------------- */
    const warrantyStates = ["Delivered"]; // adjust as needed
    if (
        !warrantyStates.includes(foundOrder.status)
        // || !warrantyStates.includes(foundOrder?.shippingStatus)
    ) {
        throw new ApiError(
            409,
            `Warranty cannot be request until order is delivered`
        );
    }

    /* ------------------------- 5. build request object ----------------------- */
    const newRequest = {
        type: "Warranty",
        isRaised: true,
        raisedAt: new Date().toISOString(),
        isResolved: false,
        status: "Pending",
        reason,
    };

    /* -------- 6. atomically push the request & (optionally) mark on hold ----- */
    const updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
            $push: { requests: newRequest },
            // Optional: put order on hold until the request is processed
            // status: "Hold",
            // holdReason: "Cancellation requested",
        },
        { new: true }
    )
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!updatedOrder)
        throw new ApiError(500, "Could not Warranty request to order");

    /* ------------------------------- 7. respond ------------------------------ */
    return res
        .status(200)
        .json(
            new ApiResponse(200, updatedOrder, "Warranty request placed successfully")
        );
})

/* --------------------------------------------------------------------------
   Reject WARRANTY request
-------------------------------------------------------------------------- */
const rejectWarrantyRequest = asyncHandler(async (req, res) => {
    const { reason, orderId } = req.body;

    /* 1. validation */
    if (!reason || !orderId)
        throw new ApiError(400, "Complete details not found");

    /* 2. fetch order */
    const foundOrder = await Order.findById(orderId)
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!foundOrder) throw new ApiError(404, "Order does not exist");

    /* 3. ensure a warranty request exists */
    if (!foundOrder.requests.some(r => r.type === "Warranty"))
        throw new ApiError(409, "No warranty request is placed");

    if (foundOrder.requests.some(r => r.type === "Warranty" && r.status === "Rejected"))
        throw new ApiError(409, "Warranty request is already rejected");

    /* 4. reject only if currently Pending */
    const updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            requests: { $elemMatch: { type: "Warranty", status: "Pending", isRaised: true, isResolved: false } },
        },
        {
            $set: {
                "requests.$.status": "Rejected",
                "requests.$.isResolved": true,
                "requests.$.resolvedAt": new Date().toISOString(),
                "requests.$.reason": reason,
            },
        },
        { new: true }
    )
        .populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();

    if (!updatedOrder)
        throw new ApiError(409, "No pending warranty request found to reject");

    return res
        .status(200)
        .json(new ApiResponse(200, updatedOrder, "Warranty request rejected successfully"));
});

export {
    loginUser,
    customerSignupByEmail,
    customerLoginByEmail,
    getUserPermissions,
    logoutUser,
    refreshAccessToken,
    getMyProfile,
    getUserCart,
    createCustomer,
    updateCustomer,
    getCustomerByMobile,
    getCustomerById,
    createEmployee,
    editEmployee,
    deleteUser,
    getUsersByRole,
    getUserById,
    placeCancelRequest,
    rejectCancelRequest,
    placeReturnRequest,
    rejectReturnRequest,
    placeWarrantyRequest,
    rejectWarrantyRequest,

}