import mongoose from "mongoose";

const companyDetailsSchema = new mongoose.Schema({
  phoneNo: { type: String, trim: true },
  whatsappNo: { type: String, trim: true },
  email: { type: String, trim: true },
  address: { type: String, trim: true },
  instaLink: { type: String, trim: true },
  facebookLink: { type: String, trim: true },
  twitterLink: { type: String, trim: true },
  websiteLink: { type: String, trim: true },
  androidAppLink: { type: String, trim: true },
  iosAppLink: { type: String, trim: true },
  logoImage: { type: String, trim: true }, // optional reference to the image file / url
  paymentGatewaySettings: {
    enableRazorpay: { type: Boolean, default: true },
    enablePhonepe: { type: Boolean, default: true }
  },
  minOrderLimit: { type: Number, default: 0 },
  minQuotationLimit: { type: Number, default: 0 }
}, { timestamps: true });

export const CompanyDetails = mongoose.model("CompanyDetails", companyDetailsSchema);