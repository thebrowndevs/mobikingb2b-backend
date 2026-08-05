import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const addImage = asyncHandler(async (req, res) => {
    try {
        const { image } = req.body;

        if (!image) {
            throw new ApiError(400, "Image is required");
        }

        const uploadResponse = await uploadOnCloudinary(image);

        console.log("Cloudinary Response:", uploadResponse);

        return res.status(200).json(
            new ApiResponse(200, { imageURL: uploadResponse.secure_url }, "Image Uploaded Successfully")
        );
    } catch (error) {
        throw new ApiError(500, "Could not upload Image");
    }
})

export const deleteImage = asyncHandler(async (req, res) => {
    try {
        const { publicId } = req.body;

        if (!publicId) {
            throw new ApiError(400, "Public Id is required");
        }

        const result = await deleteOnCloudinary(publicId);
        if (!result) {
            throw new ApiError(500, 'Someting went wrong while deleting image');
        }

        return res.status(200).json(
            new ApiResponse(200, "Image deleted Successfully")
        );
    } catch (error) {
        throw new ApiError(500, "Could not delete Image");
    }
})

export const getImages = asyncHandler(async (req, res) => {
    try {

        const result = await getImagesFromCloudinary();
        if (!result) {
            throw new ApiError(500, 'Someting went wrong while fetching images');
        }

        // console.log(result);
        return res.status(200).json(
            new ApiResponse(200, result, "Images fetched Successfully")
        );
    } catch (error) {

        throw new ApiError(500, "Could not fetch images");
    }
})
