import mongoose from "mongoose";

const MONGODB_URI = "mongodb+srv://thebrowndevs_db_user:f171x42eKEKOSoqX@cluster0.dssqjuk.mongodb.net/mobikingb2b";

const schema = new mongoose.Schema({}, { strict: false });
const Product = mongoose.model("Product", schema, "products");
const Variant = mongoose.model("Variant", schema, "variants");

async function main() {
    console.log("Connecting to DB...");
    await mongoose.connect(MONGODB_URI);
    console.log("Connected!");

    const prod = await Product.findOne();
    console.log("Sample product document:\n", JSON.stringify(prod?.toObject(), null, 2));

    const variantSample = await Variant.findOne();
    console.log("Sample variant document:\n", JSON.stringify(variantSample?.toObject(), null, 2));

    await mongoose.disconnect();
}

main().catch(console.error);
