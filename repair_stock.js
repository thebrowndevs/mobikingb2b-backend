/**
 * Stock Repair Script
 * Fixes: available > physical, product totals out of sync with variants, negative reserved
 * Copy to backend root and run: node repair_stock.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const purchaseSetSchema = new mongoose.Schema({
    price: Number, quantity: Number, remainingStock: Number, availableStock: Number
}, { timestamps: true });

const variantSchema = new mongoose.Schema({
    productId: mongoose.Schema.Types.ObjectId,
    name: String,
    totalStock: { type: Number, default: 0 },
    availableStock: { type: Number, default: 0 },
    purchaseSets: [purchaseSetSchema]
}, { timestamps: true });

const productSchema = new mongoose.Schema({
    totalStock: Number, totalProductStock: Number, availableStock: Number
});

const inventorySchema = new mongoose.Schema({
    product: mongoose.Schema.Types.ObjectId,
    physicalStock: Number, reservedStock: Number, availableStock: Number
});

const Variant = mongoose.model('Variant', variantSchema);
const Product = mongoose.model('Product', productSchema);
const Inventory = mongoose.model('Inventory', inventorySchema);

async function repair() {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    const variants = await Variant.find({});
    console.log(`Found ${variants.length} variants to check`);

    let variantsFixed = 0;
    let productsFixed = 0;
    let inventoriesFixed = 0;

    // 1. Fix variants where availableStock > totalStock or negative
    for (const v of variants) {
        let newAvail = v.availableStock;
        if (newAvail > v.totalStock) {
            console.log(`  VARIANT ${v._id} (${v.name}): avail ${newAvail} > total ${v.totalStock} → clamping`);
            newAvail = v.totalStock;
        }
        if (newAvail < 0) {
            console.log(`  VARIANT ${v._id} (${v.name}): negative avail ${newAvail} → clamping to 0`);
            newAvail = 0;
        }
        if (newAvail !== v.availableStock) {
            await Variant.updateOne({ _id: v._id }, { $set: { availableStock: newAvail } });
            variantsFixed++;
        }
    }
    console.log(`Variants fixed: ${variantsFixed}`);

    // 2. Re-sync Product totals from variant sums
    const productIds = [...new Set(variants.map(v => v.productId.toString()))];
    for (const pid of productIds) {
        const pvs = await Variant.find({ productId: pid });
        const totalStockSum = pvs.reduce((s, v) => s + (v.totalStock || 0), 0);
        const availableStockSum = pvs.reduce((s, v) => s + (v.availableStock || 0), 0);
        const product = await Product.findById(pid);
        if (!product) continue;
        if (product.totalStock !== totalStockSum || product.totalProductStock !== totalStockSum || product.availableStock !== availableStockSum) {
            console.log(`  PRODUCT ${pid}: total ${product.totalStock}→${totalStockSum}, avail ${product.availableStock}→${availableStockSum}`);
            await Product.updateOne({ _id: pid }, {
                $set: { totalStock: totalStockSum, totalProductStock: totalStockSum, availableStock: availableStockSum }
            });
            productsFixed++;
        }
    }
    console.log(`Products re-synced: ${productsFixed}`);

    // 3. Fix Inventory: reserved = physical - available
    const inventories = await Inventory.find({});
    for (const inv of inventories) {
        const product = await Product.findById(inv.product);
        if (!product) continue;
        const physical = product.totalStock || 0;
        const avail = product.availableStock || 0;
        const reserved = Math.max(0, physical - avail);
        if (inv.reservedStock !== reserved || inv.physicalStock !== physical || inv.availableStock !== avail) {
            console.log(`  INVENTORY ${inv.product}: reserved ${inv.reservedStock}→${reserved}, physical ${inv.physicalStock}→${physical}`);
            await Inventory.updateOne({ _id: inv._id }, {
                $set: { physicalStock: physical, availableStock: avail, reservedStock: reserved }
            });
            inventoriesFixed++;
        }
    }
    console.log(`Inventories fixed: ${inventoriesFixed}`);

    console.log('\nRepair complete.');
    await mongoose.disconnect();
}

repair().catch(err => {
    console.error('Repair failed:', err);
    process.exit(1);
});
