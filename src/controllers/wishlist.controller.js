import { User } from '../models/user.model.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Product } from '../models/product.model.js';

const addProductInWishList = asyncHandler(async (req, res) => {
    const {
        productId,
    } = req.body;

    const user = req?.user;
    if (user?.wishlist?.some(pr => pr == productId)) {
        throw new ApiError(404, "Product already present in whishlist");
    }

    // 2. Fetch product to get latest price (for consistency)
    const product = await Product.findById(productId);
    if (!product) {
        throw new ApiError(404, "Product not found");
    }

    // 4. Populate user with product details
    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        {
            $push: {
                wishlist: productId
            }
        },
        { new: true }
    )
        .select('-password -refreshToken')
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
        // .populate("orders")
        .exec();
    //populate orders

    return res.status(201).json(
        new ApiResponse(201, {
            user: updatedUser
        }, "Product added to whishlist successfully")
    );
});

const removeProductFromWishList = asyncHandler(async (req, res) => {
    const {
        productId,
    } = req.body;

    const user = req?.user;
    if (!user?.wishlist?.some(pr => pr == productId)) {
        throw new ApiError(404, "Product not found in whishlist");
    }

    // 2. Fetch product to get latest price (for consistency)
    const product = await Product.findById(productId);
    if (!product) {
        throw new ApiError(404, "Product not found");
    }

    // 4. Populate user with product details
    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        {
            $pull: {
                wishlist: productId
            }
        },
        { new: true }
    )
        .select('-password -refreshToken')
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
        // .populate("orders")
        .exec();
    //populate orders

    return res.status(201).json(
        new ApiResponse(201, {
            user: updatedUser
        }, "Product removed from whishlist successfully")
    );
});

export {
    addProductInWishList,
    removeProductFromWishList
}