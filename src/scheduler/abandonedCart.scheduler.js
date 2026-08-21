import cron from "node-cron";
import { processAbandonedCarts } from "../jobs/abandonedOrder.Job.js";
import { deleteAbandonedOrders } from "../jobs/deleteAbandonedOrders.Job.js";
import { restoreReservedOrders } from "../jobs/restoreReservedOrders.Job.js";

export const startAbandonedCartScheduler = () => {
    // cron.schedule("0 * * * *", async () => {
    cron.schedule("59 23 * * *", async () => {
        console.log("⏰ Running abandoned cart job at", new Date().toISOString());
        try {
            await processAbandonedCarts();
        } catch (error) {
            console.error("❌ Error running abandoned cart job:", error.message);
        }
    });
};

export const startDeleteAbandonedOrderScheduler = () => {
    // cron.schedule("0 * * * *", async () => {
    // cron.schedule("*/5 * * * *", async () => {
    cron.schedule("0 0 1,16 * * ", async () => {
        console.log("⏰ Running delete abandoned order job at", new Date().toISOString());
        try {
            // await processAbandonedCarts();
            await deleteAbandonedOrders();
        } catch (error) {
            console.error("❌ Error running delete abandoned order job:", error.message);
        }
    });
};

export const startRestoreReservedOrdersScheduler = () => {
    cron.schedule("* * * * *", async () => {
        // cron.schedule("*/5 * * * *", async () => {
        console.log("⏰ Running restore reserved orders job at", new Date().toISOString());
        try {
            await restoreReservedOrders();
        } catch (error) {
            console.error("❌ Error running restore reserved orders job:", error.message);
        }
    });
};
