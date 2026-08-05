import mongoose from "mongoose";

const counterSchema = new mongoose.Schema({
    _id: { type: String, required: true },   // e.g. "orderId"
    seq: { type: Number, default: 80000 }    // starting orderId
});

export const Counter = mongoose.model("Counter", counterSchema);
