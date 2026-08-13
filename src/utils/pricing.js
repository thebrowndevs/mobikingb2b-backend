import { Product } from "../models/product.model.js";
import { ApiError } from "./ApiError.js";

export const determineSlabForQuantity = (product, quantity) => {
    if (!product.sellingPrice) return null;
    if (product.sellingPrice.type === "fixed") {
        if (product.sellingPrice.slabs && product.sellingPrice.slabs.length > 0) {
            return { quantity: product.sellingPrice.slabs[0].quantity, price: product.sellingPrice.slabs[0].price };
        }
        return { quantity: 1, price: product.basePrice || 0 };
    }

    const slabs = product.sellingPrice.slabs || [];
    if (slabs.length === 0) return { quantity: 1, price: product.basePrice || 0 };

    const sortedSlabs = [...slabs].sort((a, b) => a.quantity - b.quantity);

    let matchedSlab = sortedSlabs[0];
    for (const slab of sortedSlabs) {
        if (quantity >= slab.quantity) {
            matchedSlab = slab;
        } else {
            break;
        }
    }
    return matchedSlab;
};

export const syncItemDiscount = (flat, percent, basePrice, discountType = "flat") => {
    let itemFlat = Number(flat || 0);
    let itemPercent = Number(percent || 0);
    const activeType = discountType || (percent > 0 && flat === 0 ? "percentage" : "flat");

    if (basePrice > 0) {
        if (activeType === "percentage") {
            itemFlat = parseFloat(((basePrice * itemPercent) / 100).toFixed(2));
        } else {
            itemPercent = parseFloat(((itemFlat / basePrice) * 100).toFixed(2));
        }
    }

    return {
        discount: parseFloat(itemFlat.toFixed(2)),
        discountPercent: parseFloat(itemPercent.toFixed(2)),
        discountType: activeType
    };
};

export const syncItemDiscountWithType = (item, activePrice) => {
    const discountType = item.discountType || (item.discountPercent > 0 && item.discount === 0 ? "percentage" : "flat");
    let itemFlat = Number(item.discount || 0);
    let itemPercent = Number(item.discountPercent || 0);

    if (activePrice > 0) {
        if (discountType === "percentage") {
            itemFlat = parseFloat(((activePrice * itemPercent) / 100).toFixed(2));
        } else {
            itemPercent = parseFloat(((itemFlat / activePrice) * 100).toFixed(2));
        }
    }

    item.discount = parseFloat(itemFlat.toFixed(2));
    item.discountPercent = parseFloat(itemPercent.toFixed(2));
    item.discountType = discountType;
};

export const syncGlobalDiscountWithType = (entity, subtotalFixed) => {
    const discountType = entity.discountType || (entity.discountPercent > 0 && entity.discount === 0 ? "percentage" : "flat");
    let flatDiscount = Number(entity.discount || 0);
    let percentDiscount = Number(entity.discountPercent || 0);

    if (discountType === "percentage") {
        flatDiscount = parseFloat(((subtotalFixed * percentDiscount) / 100).toFixed(2));
    } else {
        percentDiscount = subtotalFixed > 0 ? parseFloat(((flatDiscount / subtotalFixed) * 100).toFixed(2)) : 0;
    }

    entity.discount = parseFloat(flatDiscount.toFixed(2));
    entity.discountPercent = parseFloat(percentDiscount.toFixed(2));
    entity.discountType = discountType;
};

/**
 * Recalculate quotation totals for Website / App creation
 * Always recalculates unit price according to matching quantity slabs.
 */
export const recalculateQuotationTotalsWebsite = async (quotation, session, keepDeliveryCharge = false) => {
    let subtotal = 0;
    const categoryCharges = new Map();

    const productQuantities = new Map();
    for (const item of quotation.items) {
        const prodIdStr = item.productId.toString();
        productQuantities.set(prodIdStr, (productQuantities.get(prodIdStr) || 0) + item.quantity);
    }

    for (const item of quotation.items) {
        const product = await Product.findById(item.productId)
            .session(session)
            .populate("category")
            .exec();

        if (!product) {
            throw new ApiError(404, `Product not found for item: ${item.productId}`);
        }

        const totalProductQty = productQuantities.get(item.productId.toString()) || item.quantity;
        const matchedSlab = determineSlabForQuantity(product, totalProductQty);

        let basePrice = 0;
        if (matchedSlab) {
            item.appliedSlab = {
                quantity: matchedSlab.quantity,
                price: matchedSlab.price
            };
            basePrice = matchedSlab.price;
        } else {
            basePrice = product.sellingPrice?.slabs?.[0]?.price || product.basePrice || 0;
        }

        item.price = basePrice;
        syncItemDiscountWithType(item, basePrice);

        subtotal += (item.price - item.discount) * item.quantity;

        if (product.category) {
            const categoryId = product.category._id.toString();
            const deliveryCharge = product.category.deliveryCharge || 0;
            if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
                categoryCharges.set(categoryId, deliveryCharge);
            }
        }
    }

    if (!keepDeliveryCharge) {
        const values = Array.from(categoryCharges.values());
        const totalDeliveryCharge = Math.max(...values, 0);
        quotation.deliveryCharge = parseFloat(totalDeliveryCharge.toFixed(2));
    } else {
        quotation.deliveryCharge = parseFloat((quotation.deliveryCharge || 0).toFixed(2));
    }

    const subtotalFixed = parseFloat(subtotal.toFixed(2));
    quotation.subtotal = subtotalFixed;

    // Sync global discount
    syncGlobalDiscountWithType(quotation, subtotalFixed);
    quotation.orderAmount = parseFloat((Math.max(0, subtotalFixed - quotation.discount) + quotation.deliveryCharge).toFixed(2));
};

/**
 * Recalculate quotation totals for B2B Admin updates
 * Respects customized prices.
 */
export const recalculateQuotationTotalsAdmin = async (quotation, session, keepReceivedPrices = true, keepDeliveryCharge = false) => {
    let subtotal = 0;
    const categoryCharges = new Map();

    const productQuantities = new Map();
    for (const item of quotation.items) {
        const prodIdStr = item.productId.toString();
        productQuantities.set(prodIdStr, (productQuantities.get(prodIdStr) || 0) + item.quantity);
    }

    for (const item of quotation.items) {
        const product = await Product.findById(item.productId)
            .session(session)
            .populate("category")
            .exec();

        if (!product) {
            throw new ApiError(404, `Product not found for item: ${item.productId}`);
        }

        const totalProductQty = productQuantities.get(item.productId.toString()) || item.quantity;
        const matchedSlab = determineSlabForQuantity(product, totalProductQty);

        let basePrice = 0;
        if (matchedSlab) {
            const currentAppliedSlabQty = item.appliedSlab ? item.appliedSlab.quantity : null;
            if (currentAppliedSlabQty === matchedSlab.quantity && item.appliedSlab.price !== undefined) {
                basePrice = item.appliedSlab.price;
            } else {
                item.appliedSlab = {
                    quantity: matchedSlab.quantity,
                    price: matchedSlab.price
                };
                basePrice = matchedSlab.price;
            }
        } else {
            basePrice = item.appliedSlab ? item.appliedSlab.price : (product.sellingPrice?.slabs?.[0]?.price || product.basePrice || 0);
        }

        const activePrice = (keepReceivedPrices && item.price !== undefined && item.price !== null && item.price > 0)
            ? item.price
            : basePrice;

        item.price = activePrice;
        syncItemDiscountWithType(item, activePrice);

        subtotal += (item.price - item.discount) * item.quantity;

        if (product.category) {
            const categoryId = product.category._id.toString();
            const deliveryCharge = product.category.deliveryCharge || 0;
            if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
                categoryCharges.set(categoryId, deliveryCharge);
            }
        }
    }

    if (!keepDeliveryCharge) {
        const values = Array.from(categoryCharges.values());
        const totalDeliveryCharge = Math.max(...values, 0);
        quotation.deliveryCharge = parseFloat(totalDeliveryCharge.toFixed(2));
    } else {
        quotation.deliveryCharge = parseFloat((quotation.deliveryCharge || 0).toFixed(2));
    }

    const subtotalFixed = parseFloat(subtotal.toFixed(2));
    quotation.subtotal = subtotalFixed;

    // Sync global discount
    syncGlobalDiscountWithType(quotation, subtotalFixed);
    quotation.orderAmount = parseFloat((Math.max(0, subtotalFixed - quotation.discount) + quotation.deliveryCharge).toFixed(2));
};

/**
 * Recalculate order totals (uses active/customized item prices)
 */
export const recalculateOrderTotals = async (order, session, keepDeliveryCharge = false) => {
    let subtotal = 0;
    const categoryCharges = new Map();

    for (const item of order.items) {
        const p = await Product.findById(item.productId)
            .session(session)
            .populate("category");

        if (p) {
            syncItemDiscountWithType(item, item.price);
            subtotal += (item.price - (item.discount || 0)) * item.quantity;
            if (p.category) {
                const categoryId = p.category._id.toString();
                const deliveryCharge = p.category.deliveryCharge || 0;
                if (deliveryCharge > 0 && !categoryCharges.has(categoryId)) {
                    categoryCharges.set(categoryId, deliveryCharge);
                }
            }
        }
    }

    if (!keepDeliveryCharge) {
        const values = Array.from(categoryCharges.values());
        const totalDeliveryCharge = Math.max(...values, 0);
        order.deliveryCharge = parseFloat(totalDeliveryCharge.toFixed(2));
    } else {
        order.deliveryCharge = parseFloat((order.deliveryCharge || 0).toFixed(2));
    }

    const subtotalFixed = parseFloat(subtotal.toFixed(2));
    order.subtotal = subtotalFixed;

    // Sync global discount
    syncGlobalDiscountWithType(order, subtotalFixed);
    order.orderAmount = parseFloat((Math.max(0, subtotalFixed - order.discount) + order.deliveryCharge).toFixed(2));
    order.remainingAmount = Math.max(0, order.orderAmount - (order.amountPaid || 0));

    if (order.remainingAmount <= 0) {
        order.paymentStatus = "Paid";
        order.paymentDate = new Date();
    } else {
        order.paymentStatus = "Pending";
    }
};
