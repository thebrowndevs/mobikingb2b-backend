import { Cart } from "../models/cart.model.js";
import { User } from "../models/user.model.js";
import { createAbandonedOrderFromCart } from "../controllers/order.controller.js";

export const processAbandonedCarts = async () => {
    // const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    // const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // const abandonedCarts = await Cart.find({ updatedAt: { $lt: fifteenMinutesAgo } }).populate("userId");
    // const abandonedCarts = await Cart.find({ updatedAt: { $lt: oneWeekAgo } }).populate("userId");
    const abandonedCarts = await Cart.find({ updatedAt: { $lt: threeDaysAgo } }).populate("userId");

    for (const cart of abandonedCarts) {
        if (cart?.items?.length <= 0) continue;
        const user = await User.findById(cart?.userId);
        if (!user) continue;

        try {
            const createdOrder = await createAbandonedOrderFromCart(
                cart?._id, user?._id,
                // user?.address ?? 
                // "Rohini, Delhi"
            );
            if (createdOrder) {
                console.log(`Abandoned order created for user ${user?._id}`);
                // Step 2: Clone the cart
                const duplicatedCart = new Cart({
                    userId: user?._id,
                    items: cart?.items,
                    totalCartValue: cart.totalCartValue,
                    updatedAt: ""
                });

                await duplicatedCart.save({ timestamps: false });
                // console.log("duplicate cart:", duplicatedCart);

                // Step 3: Update user with new cart reference
                await User.findByIdAndUpdate(user?.id, { cart: duplicatedCart._id });

                // Step 4: Delete old cart
                await Cart.findByIdAndDelete(cart?._id);
            }
        } catch (error) {
            console.error(`Error processing cart ${cart?._id}:`, error?.message);
        }
    }
};
