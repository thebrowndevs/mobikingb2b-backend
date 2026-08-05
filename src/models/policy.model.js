import mongoose from "mongoose";

const policySchema = new mongoose.Schema({
  policyName: {
    type: String,
    // required: true,
    // trim: true
  },
  slug: {
    type: String,
    // required: true,
    // lowercase: true,
    // unique: true
  },
  heading: {
    type: String,
    // required: true,
    // trim: true
  },
  content: {
    type: String,
    // required: true
  },
  lastUpdated: {
    type: Date,
    // default: Date.now
  }
}, { timestamps: true });

export const Policy = mongoose.model("Policy", policySchema);