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
    const addKg = Number(config?.additionalKgCharge ?? 70);
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
