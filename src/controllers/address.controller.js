import { Address } from "../models/address.model.js"
import { User } from "../models/user.model.js"
import { ApiError } from "../utils/ApiError.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import { asyncHandler } from "../utils/asyncHandler.js"
import axios from "axios";
import https from "https";

const agent = new https.Agent({
    rejectUnauthorized: false
});


const createAddress = asyncHandler(async (req, res) => {
    const { label, street, city, state, pinCode, latitude, longitude } = req.body;

    // Basic field validation
    if ([label, street, city, state, pinCode].some((field) => field?.trim() === "")) {
        throw new ApiError(400, "All fields are required");
    }

    // Validate pincode using India Post API
    let pinRes;
    try {
        pinRes = await axios.get(`https://api.postalpincode.in/pincode/${pinCode}`, {
            httpsAgent: agent
        });
    } catch (error) {
        throw new ApiError(500, `Address API error: ${error.message}`);
    }
    const pinData = pinRes.data?.[0];

    if (!pinData || pinData.Status !== "Success" || !Array.isArray(pinData.PostOffice)) {
        throw new ApiError(400, `Invalid pincode: ${pinCode}`);
    }

    const postOffices = pinData.PostOffice;

    // Validate state and country (strict match)
    const stateMatch = postOffices.some((po) => po.State.toLowerCase() === state.toLowerCase());
    const countryMatch = postOffices.some((po) => po.Country.toLowerCase() === "india");

    if (!stateMatch) {
        const validStates = [...new Set(postOffices.map((po) => po.State))];
        throw new ApiError(400, `State does not exist in the pincode`);
        // throw new ApiError(400, `State does not match the pincode. Valid: ${validStates.join(", ")}`);
    }

    if (!countryMatch) {
        throw new ApiError(400, `Only Indian addresses are supported`);
    }

    // Partial city match
    const lowerCity = city.toLowerCase();
    const matchingOffice = postOffices.find((po) =>
        [
            po.Name,
            po.Circle,
            po.District,
            po.Division,
            po.Region,
            po.Block
        ].some((field) => field?.toLowerCase().includes(lowerCity))
    );

    if (!matchingOffice) {
        const allFields = postOffices.flatMap((po) =>
            [po.Name, po.Circle, po.District, po.Division, po.Region, po.Block].filter(Boolean)
        );
        const uniqueFields = [...new Set(allFields)];
        throw new ApiError(
            400,
            `City not valid for this PIN-code`
        );
    }

    // Save new address
    const newAddress = await Address.create({
        userId: req?.user?._id,
        label,
        street,
        city,
        state,
        pinCode,
        latitude,
        longitude
    });

    if (!newAddress) {
        throw new ApiError(500, "Something went wrong while creating the address");
    }

    // Update user
    const updatedUser = await User.findByIdAndUpdate(
        req?.user?._id,
        {
            $push: { address: newAddress?._id }
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
        .populate("address")
        .exec();

    if (!updatedUser) {
        throw new ApiError(500, "Something went wrong while adding the address to user");
    }

    return res
        .status(201)
        .json(new ApiResponse(201, updatedUser, "Address added successfully"));
});

/* -----------------------------------------------------------
   Edit Address with conditional postal validation
----------------------------------------------------------- */
const editAddress = asyncHandler(async (req, res) => {
    const { _id } = req.params;
    const { label, street, city, state, pinCode, latitude, longitude } = req.body;

    if (!_id) throw new ApiError(400, "Address Id required");

    const addressExists = await Address.findById(_id);
    if (!addressExists) throw new ApiError(404, "Address not found");

    /* ---------- CONDITIONAL VALIDATION SECTION ---------- */
    const shouldValidate =
        city?.trim() && state?.trim() && pinCode?.toString().trim();

    if (shouldValidate) {
        if (!/^\d{6}$/.test(pinCode))
            throw new ApiError(400, "PIN‑code must be 6 digits");

        // Call India‑Post API
        let apiResponse;
        try {
            apiResponse = await axios.get(
                `https://api.postalpincode.in/pincode/${pinCode}`,
                {
                    timeout: 8000,
                    httpsAgent: agent
                }
            );
        } catch (error) {
            throw new ApiError(500, `Address API error: ${error.message}`);
        }
        const api = apiResponse?.data?.[0];
        if (!api || api.Status !== "Success" || !api.PostOffice?.length) {
            throw new ApiError(400, `Invalid PIN‑code: ${pinCode}`);
        }

        const offices = api.PostOffice;

        // Strict state & country checks
        const stateOk = offices.some(
            (po) => po.State.toLowerCase() === state.toLowerCase()
        );
        if (!stateOk) {
            const validStates = [...new Set(offices.map((po) => po.State))];
            throw new ApiError(
                400,
                `State does not exist in PIN`
            );
        }
        const countryOk = offices.every(
            (po) => po.Country.toLowerCase() === "india"
        );
        if (!countryOk)
            throw new ApiError(400, "Only Indian addresses are supported");

        // Partial city match across multiple office fields
        const lcCity = city.toLowerCase();
        const cityMatch = offices.find((po) =>
            [
                po.Name,
                po.Circle,
                po.District,
                po.Division,
                po.Region,
                po.Block,
            ].some((f) => f?.toLowerCase().includes(lcCity))
        );
        if (!cityMatch) {
            const allFields = [
                ...new Set(
                    offices.flatMap((po) =>
                        [
                            po.Name,
                            po.Circle,
                            po.District,
                            po.Division,
                            po.Region,
                            po.Block,
                        ].filter(Boolean)
                    )
                ),
            ];
            throw new ApiError(
                400,
                `City invalid for this PIN`
            );
        }
    }
    /* ---------- END CONDITIONAL VALIDATION ---------- */

    const updated = await Address.findByIdAndUpdate(
        _id,
        { label, street, city, state, pinCode, latitude, longitude },
        { new: true }
    );

    if (!updated)
        throw new ApiError(500, "Something went wrong while updating the address");

    return res
        .status(200)
        .json(new ApiResponse(200, updated, "Address updated successfully"));
});

const deleteAddress = asyncHandler(async (req, res) => {
    const { _id } = req.params;

    if (!_id) {
        throw new ApiError(400, "Address Id Required");
    }

    const foundAddress = await Address.findById(_id)

    if (!foundAddress) {
        throw new ApiError(500, "Address not found")
    }

    const deletedAddress = await Address.findByIdAndDelete(_id)
        .populate({
            path: "userId",
            select: "-password -refreshToken"
        })
        .exec();

    if (!deletedAddress) {
        throw new ApiError(500, "Something went wrong while deleting the address for user")
    }

    //Remove Id from user
    const updatedUser = await User.findByIdAndUpdate(
        req?.user?._id,
        {
            $pull: {
                address: deletedAddress?._id
            }
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
        .populate("address")
        .exec();

    if (!updatedUser) {
        throw new ApiError(500, "Something went wrong while adding the address for user")
    }

    return res.status(200).json(
        new ApiResponse(200, updatedUser, "Address deleted successfully")
    )

})

const getAllAddressByUser = asyncHandler(async (req, res) => {

    // console.log("User", req?.user?._id);
    const userAddresses = await Address.find({ userId: req?.user?._id })
        .populate({
            path: "userId",
            select: "-password -refreshToken"
        })
        .exec();

    if (!userAddresses) {
        throw new ApiError(500, "Something went wrong while fetching the addresses")
    }

    return res.status(200).json(
        new ApiResponse(200, userAddresses, "Address fetched successfully")
    )

})

export {
    createAddress,
    editAddress,
    deleteAddress,
    getAllAddressByUser
}