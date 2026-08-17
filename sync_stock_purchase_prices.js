import mongoose from "mongoose";
import dotenv from "dotenv";
import { Order } from "./src/models/order.model.js";
import { Stock } from "./src/models/stock.model.js";

dotenv.config();

const connectDB = async () => {
    let connectionURI = process.env.MONGODB_URI || "";
    if (connectionURI.endsWith("/")) {
        connectionURI = connectionURI.slice(0, -1);
    }
    const dbName = process.env.DB_NAME || "mobiking";
    const urlParts = connectionURI.split('/');
    const hasDbName = urlParts.length > 3 && urlParts[3].split('?')[0] !== "";
    if (!hasDbName && dbName) {
        connectionURI = `${connectionURI}/${dbName}`;
    }
    await mongoose.connect(connectionURI);
};

const run = async () => {
    try {
        console.log("Connecting to database...");
        await connectDB();
        console.log("Connected. Fetching all orders...");

        const orders = await Order.find({}).lean();
        console.log(`Found ${orders.length} orders. Syncing stock logs...`);

        let totalUpdated = 0;
        for (const order of orders) {
            if (!order.items || order.items.length === 0) continue;

            for (const item of order.items) {
                const finalUnitSellingPrice = Number(item.price || 0) - Number(item.discount || 0);
                const queryConditions = [];

                const cond = { orderRef: order._id };
                if (item.variantId) {
                    cond.variantId = item.variantId;
                } else {
                    if (item.productId) cond.productId = item.productId;
                    if (item.variantName) cond.variantName = item.variantName;
                }
                queryConditions.push(cond);

                if (item.stockIds && item.stockIds.length > 0) {
                    queryConditions.push({ _id: { $in: item.stockIds.map(id => new mongoose.Types.ObjectId(id)) } });
                }

                const result = await Stock.updateMany(
                    { $or: queryConditions },
                    {
                        $set: {
                            sellingPrice: finalUnitSellingPrice,
                            purchasePrice: Number(item.purchasePrice || 0)
                        }
                    }
                );
                totalUpdated += result.modifiedCount;
            }
        }

        console.log(`Sync completed successfully. Total stock logs updated: ${totalUpdated}`);
        process.exit(0);
    } catch (err) {
        console.error("Error executing sync script:", err);
        process.exit(1);
    }
};

run();
