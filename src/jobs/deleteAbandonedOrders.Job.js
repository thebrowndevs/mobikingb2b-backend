import { Order } from "../models/order.model.js";

export const deleteAbandonedOrders = async()=>{

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const abandonedOrders = await Order.find(
        { 
            abondonedOrder: true, 
            createdAt: { $lt: thirtyDaysAgo } 
        }
    ).select("_id");

    console.log("Abandoned order found: ",abandonedOrders.length);

    for (const order of abandonedOrders) {
        // if (cart?.items?.length <= 0) continue;
        // const user = await User.findById(cart?.userId);
        // if (!user) continue;
        console.log(`Running delete Abandoned order on: `,order._id);

        try {
            const deletedOrder = await Order.findByIdAndDelete(order?._id);
            if (deletedOrder) {
                console.log(`Abandoned order deleted: `,deletedOrder);
            }
        } catch (error) {
            console.error(`Error deleting abandoned order ${order?._id}:`, error?.message);
        }
    }

}