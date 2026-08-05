import { Router } from "express";
import { processAbandonedCarts } from "../jobs/abandonedOrder.Job.js";

const router = Router()
router.get('/run-abandoned-job', async (req, res) => {
    try {
        console.log("⏰ Running abandoned cart job at", new Date().toISOString());
        await processAbandonedCarts();
        res.status(200).send("✅ Abandoned cart job executed.");
    } catch (error) {
        console.error("❌ Error running abandoned job:", error.message);
        res.status(500).send("❌ Failed to run job.");
    }
});

export default router