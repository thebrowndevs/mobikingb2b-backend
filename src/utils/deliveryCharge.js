/**
 * Centralized Common Delivery Charge Resolver for Mobiking B2B
 *
 * Calculates volume, volumetric weight, and shipping charges for given dimensions & quantity.
 * Formula:
 * - Single Volume (cm³) = length * breadth * height * volumeMultiplier (default 1.2)
 * - Volumetric Weight (kg) = volume / volumetricDivisor (default 5000)
 * - Billable charge: firstKgCharge for first kg + additionalKgCharge for each additional kg (ceil)
 *
 * @param {Object} params
 * @param {number} params.length - Length in cm
 * @param {number} params.breadth - Breadth in cm
 * @param {number} params.height - Height in cm
 * @param {number} [params.quantity=1] - Quantity of units
 * @param {Object} [params.config] - Configurable settings overrides
 * @param {number} [params.config.firstKgCharge=100] - Rate for first kg
 * @param {number} [params.config.additionalKgCharge=70] - Rate for additional kg
 * @param {number} [params.config.volumeMultiplier=1.2] - Packing volume multiplier
 * @param {number} [params.config.volumetricDivisor=5000] - Divisor for kg conversion
 * @returns {Object} Calculated metrics
 */
export const calculateProductDeliveryCharge = ({
    length = 0,
    breadth = 0,
    height = 0,
    quantity = 1,
    config = {}
}) => {
    const l = Math.max(0, Number(length) || 0);
    const b = Math.max(0, Number(breadth) || 0);
    const h = Math.max(0, Number(height) || 0);
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    const firstKg = Number(config?.firstKgCharge ?? 100);
    const addKg = Number(config?.additionalKgCharge ?? 60);
    const multiplier = Number(config?.volumeMultiplier ?? 1.2);
    const divisor = Number(config?.volumetricDivisor ?? 5000);

    // Single unit measurements
    const unitVolume = l * b * h * multiplier;
    const unitVolumetricWeight = divisor > 0 ? unitVolume / divisor : 0;

    // Total for given quantity
    const totalVolume = unitVolume * qty;
    const totalVolumetricWeight = unitVolumetricWeight * qty;

    const computeCharge = (weight) => {
        if (weight <= 0) return 0;
        if (weight <= 1) return firstKg;
        const additionalKg = Math.ceil(weight - 1);
        return firstKg + (additionalKg * addKg);
    };

    return {
        unitVolume: parseFloat(unitVolume.toFixed(2)),
        unitVolumetricWeight: parseFloat(unitVolumetricWeight.toFixed(3)),
        totalVolume: parseFloat(totalVolume.toFixed(2)),
        totalVolumetricWeight: parseFloat(totalVolumetricWeight.toFixed(3)),
        deliveryCharge: Math.round(computeCharge(totalVolumetricWeight)),
        unitBaseCharge: Math.round(computeCharge(unitVolumetricWeight))
    };
};

/**
 * Calculates total consignment volumetric weight and tiered delivery charge
 * across multiple items in an order or cart.
 *
 * @param {Object} params
 * @param {Array<Object>} params.items - Array of items with { product (or productId), quantity }
 * @param {Object} [params.config] - Configurable settings overrides
 * @returns {Object} { totalWeight, deliveryCharge, breakdown, itemWeights }
 */
export const calculateConsignmentDeliveryCharge = ({
    items = [],
    config = {}
}) => {
    const firstKg = Number(config?.firstKgCharge ?? 100);
    const addKg = Number(config?.additionalKgCharge ?? 60);
    const multiplier = Number(config?.volumeMultiplier ?? 1.2);
    const divisor = Number(config?.volumetricDivisor ?? 5000);

    let totalWeight = 0;
    const itemWeights = [];
    const productGroups = new Map();

    for (const item of items) {
        const product = item.product || item.productId || item;
        const prodId = String(product?._id || product || "");
        const qty = Math.max(1, parseInt(item.quantity, 10) || 1);

        let l = 0, b = 0, h = 0;
        if (product?.dimensions) {
            l = Math.max(0, Number(product.dimensions.length) || 0);
            b = Math.max(0, Number(product.dimensions.breadth) || 0);
            h = Math.max(0, Number(product.dimensions.height) || 0);
        }

        const unitVolume = l * b * h * multiplier;
        const unitWeight = divisor > 0 ? (unitVolume / divisor) : 0;
        const itemTotalWeight = unitWeight * qty;
        totalWeight += itemTotalWeight;

        if (prodId) {
            if (!productGroups.has(prodId)) {
                productGroups.set(prodId, { totalWeight: 0, items: [] });
            }
            const group = productGroups.get(prodId);
            group.totalWeight += itemTotalWeight;
            group.items.push(item);
        }

        itemWeights.push({
            productId: product?._id || product,
            dimensions: {
                length: l,
                breadth: b,
                height: h,
                volume: parseFloat(unitVolume.toFixed(2))
            },
            unitVolumetricWeight: parseFloat(unitWeight.toFixed(3)),
            totalVolumetricWeight: parseFloat(itemTotalWeight.toFixed(3)),
            quantity: qty
        });
    }

    let totalDeliveryCharge = 0;
    let totalAdditionalUnits = 0;

    for (const [prodId, group] of productGroups.entries()) {
        const pWeight = group.totalWeight;
        if (pWeight > 0) {
            if (pWeight <= 1.0) {
                totalDeliveryCharge += firstKg;
            } else {
                const addUnits = Math.ceil(pWeight - 1.0);
                totalAdditionalUnits += addUnits;
                totalDeliveryCharge += firstKg + (addUnits * addKg);
            }
        }
    }

    return {
        totalWeight: parseFloat(totalWeight.toFixed(3)),
        deliveryCharge: Math.round(totalDeliveryCharge),
        breakdown: {
            billableWeightKg: parseFloat(totalWeight.toFixed(3)),
            firstKgCharge: firstKg,
            additionalKgCharge: addKg,
            additionalKgUnits: totalAdditionalUnits,
            calculatedCharge: Math.round(totalDeliveryCharge)
        },
        itemWeights
    };
};
