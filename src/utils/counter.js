import { Counter } from "../models/counter.model.js";

const initCounter = async () => {
    try {
        const exists = await Counter.findById("quotationId");
        if (!exists) {
            await Counter.create({ _id: "quotationId", seq: 100 }).catch(err => {
                if (err.code !== 11000) throw err;
            });
            console.log("✅ Counter initialized at 100000");
        } else {
            console.log("ℹ️ Counter already exists at:", exists.seq);
        }
    } catch (error) {
        console.error("Counter initialization error:", error);
    }
};

export {
    initCounter
}