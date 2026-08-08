import { Cart } from '../models/cart.model.js';
import { User } from '../models/user.model.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Product } from './../models/product.model.js';
import { Variant } from '../models/variant.model.js';

// Helper to recalculate selling prices of all items in cart dynamically based on product slabs
async function recalculateCartPrices(cart) {
    if (!cart || !cart.items || cart.items.length === 0) {
        if (cart) {
            cart.totalCartValue = 0;
        }
        return;
    }

    // Group items by productId to find total product quantity
    const productQuantities = {};
    for (const item of cart.items) {
        if (!item.productId) continue;
        const pId = item.productId.toString();
        productQuantities[pId] = (productQuantities[pId] || 0) + item.quantity;
    }

    // Fetch product details and update item prices
    for (const pId of Object.keys(productQuantities)) {
        const product = await Product.findById(pId);
        if (!product) continue;

        const totalQty = productQuantities[pId];

        // Determine price from slabs based on totalQty
        let activeSlab = product.sellingPrice?.slabs?.[0] || { quantity: 60, price: product.basePrice || 0 };
        if (product.sellingPrice?.slabs && product.sellingPrice.slabs.length > 0) {
            const sortedSlabs = [...product.sellingPrice.slabs].sort((a, b) => b.quantity - a.quantity);
            for (const slab of sortedSlabs) {
                if (totalQty >= slab.quantity) {
                    activeSlab = slab;
                    break;
                }
            }
        }

        // Update all items of this product in cart
        for (const item of cart.items) {
            if (item.productId && item.productId.toString() === pId) {
                item.price = activeSlab.price;
                item.appliedSlab = {
                    quantity: activeSlab.quantity,
                    price: activeSlab.price
                };
            }
        }
    }

    // Recalculate total value
    cart.totalCartValue = cart.items.reduce((total, item) => {
        return total + item.quantity * item.price;
    }, 0);
}

const addProductInCart = asyncHandler(async (req, res) => {
    let itemsInput = Array.isArray(req.body) ? req.body : (req.body.items || []);

    // Backwards compatibility for single item additions
    if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
        const { productId, variantId, variantName, quantity } = req.body;
        if (productId) {
            let vId = variantId;
            if (!vId && variantName) {
                const foundV = await Variant.findOne({ productId, name: variantName });
                vId = foundV?._id;
            }
            if (productId && vId) {
                itemsInput = [{
                    productId,
                    variantId: vId,
                    quantity: quantity || 1
                }];
            }
        }
    }

    if (itemsInput.length === 0) {
        throw new ApiError(400, "Items array or item details are required");
    }

    const cartId = req?.user?.cart;
    let cart = null;
    if (cartId) {
        cart = await Cart.findById(cartId);
    }

    if (!cart) {
        const allCarts = await Cart.find({ userId: req?.user?._id });
        for (let c of allCarts) {
            await Cart.findByIdAndDelete(c?._id);
        }
        cart = await Cart.create({
            userId: req.user._id,
            items: []
        });
    }

    const cartItems = cart.items || [];

    for (const item of itemsInput) {
        const { productId, variantId, quantity } = item;
        const qtyToAdd = parseInt(quantity);
        if (isNaN(qtyToAdd) || qtyToAdd <= 0) continue;

        if (!productId || !variantId) {
            throw new ApiError(400, "productId and variantId are required for all items");
        }

        const product = await Product.findById(productId);
        if (!product) {
            throw new ApiError(404, `Product not found for ID: ${productId}`);
        }

        const variant = await Variant.findById(variantId);
        if (!variant) {
            throw new ApiError(404, `Variant not found for ID: ${variantId}`);
        }

        const availableVariantStock = variant.totalStock || 0;

        const existingIndex = cartItems.findIndex(
            it => it.variantId.toString() === variantId.toString()
        );

        let finalQty = qtyToAdd;
        if (existingIndex !== -1) {
            finalQty = cartItems[existingIndex].quantity + qtyToAdd;
        }

        if (finalQty > availableVariantStock) {
            throw new ApiError(400, `Only ${availableVariantStock} units available for variant "${variant.name}"`);
        }

        const latestPrice = product.sellingPrice?.[product.sellingPrice.length - 1]?.price || product.basePrice || 0;

        if (existingIndex !== -1) {
            cartItems[existingIndex] = {
                ...cartItems[existingIndex].toObject(),
                quantity: finalQty,
                price: latestPrice,
                gst: product.gst || 18,
                discount: 0
            };
        } else {
            cartItems.push({
                productId,
                variantId: variant._id,
                sku: String(variant._id),
                fullName: product.fullName,
                basePrice: product.basePrice,
                variantName: variant.name,
                quantity: finalQty,
                price: latestPrice,
                gst: product.gst || 18,
                discount: 0
            });
        }
    }

    cart.items = cartItems;

    // Recalculate prices based on slabs
    await recalculateCartPrices(cart);

    const updatedCart = await cart.save();
    if (!updatedCart) {
        throw new ApiError(500, "Failed to update cart");
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        {
            cart: updatedCart?._id
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
                    path: "category",
                    model: "SubCategory"
                }
            }
        })
        .populate("wishlist")
        .exec();

    // Hiding purchasePrice and purchaseSetId from customer response
    if (updatedUser.cart && updatedUser.cart.items) {
        updatedUser.cart.items = updatedUser.cart.items.map(it => {
            const obj = it.toObject ? it.toObject() : it;
            delete obj.purchasePrice;
            delete obj.purchaseSetId;
            return obj;
        });
    }

    return res.status(200).json(
        new ApiResponse(200, {
            user: updatedUser
        }, "Products added to cart successfully")
    );
});

const removeProductFromCart = asyncHandler(async (req, res) => {
    let itemsInput = Array.isArray(req.body) ? req.body : (req.body.items || []);

    // Backwards compatibility for single item removals
    if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
        const { productId, variantId, variantName, quantity } = req.body;
        if (productId) {
            let vId = variantId;
            if (!vId && variantName) {
                const foundV = await Variant.findOne({ productId, name: variantName });
                vId = foundV?._id;
            }
            if (productId && vId) {
                itemsInput = [{
                    productId,
                    variantId: vId,
                    quantity: quantity || 1
                }];
            }
        }
    }

    if (itemsInput.length === 0) {
        throw new ApiError(400, "Items array or item details are required");
    }

    const cartId = req?.user?.cart;
    if (!cartId) {
        throw new ApiError(404, "Cart not found");
    }

    const cart = await Cart.findById(cartId);
    if (!cart) {
        throw new ApiError(404, "Cart not found");
    }

    const cartItems = cart.items || [];

    for (const item of itemsInput) {
        const { variantId, quantity } = item;
        const qtyToRemove = parseInt(quantity) || 1;

        const index = cartItems.findIndex(
            it => it.variantId.toString() === variantId.toString()
        );

        if (index === -1) continue;

        const newQty = cartItems[index].quantity - qtyToRemove;
        if (newQty > 0) {
            cartItems[index].quantity = newQty;
        } else {
            cartItems.splice(index, 1);
        }
    }

    cart.items = cartItems;

    // Recalculate prices based on slabs
    await recalculateCartPrices(cart);

    const updatedCart = await cart.save();
    if (!updatedCart) {
        throw new ApiError(500, "Failed to update cart");
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        {
            cart: updatedCart?._id
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
                    path: "category",
                    model: "SubCategory"
                }
            }
        })
        .populate("wishlist")
        .exec();

    // Hiding purchasePrice and purchaseSetId from customer response
    if (updatedUser.cart && updatedUser.cart.items) {
        updatedUser.cart.items = updatedUser.cart.items.map(it => {
            const obj = it.toObject ? it.toObject() : it;
            delete obj.purchasePrice;
            delete obj.purchaseSetId;
            return obj;
        });
    }

    return res.status(200).json(
        new ApiResponse(200, {
            user: updatedUser
        }, "Products removed from cart successfully")
    );
});

export {
    addProductInCart,
    removeProductFromCart
};