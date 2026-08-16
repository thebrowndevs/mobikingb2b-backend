import { ApiError } from "../ApiError.js";

/**
 * Allocate physical stock for an order quantity increase.
 *
 * Order flow consumes BOTH:
 * - purchaseSet.availableStock
 * - purchaseSet.remainingStock
 *
 * The Variant totalStock/availableStock mutation itself is performed
 * atomically by the controller before calling this helper.
 */
export const allocateOrderPurchaseSets = ({
    variant,
    allocatedSets,
    quantity,
    selectedSetId = ""
}) => {
    let remaining = Number(quantity || 0);
    let totalCost = 0;

    const newlyAllocated = [];

    const sortedSets = variant.purchaseSets
        .map((set, index) => ({
            set,
            index
        }))
        .filter(
            ({ set }) =>
                Number(set.availableStock || 0) > 0
        )
        .sort(
            (a, b) =>
                Number(a.set.price || 0) -
                Number(b.set.price || 0)
        );

    for (const { set } of sortedSets) {
        if (remaining <= 0) break;

        const availableStock = Number(
            set.availableStock || 0
        );

        const take = Math.min(
            remaining,
            availableStock
        );

        if (take <= 0) continue;

        set.availableStock -= take;

        set.remainingStock = Math.max(
            0,
            Number(set.remainingStock || 0) - take
        );

        totalCost +=
            take * Number(set.price || 0);

        const allocation = {
            purchaseSetId: String(set._id),
            quantity: take,
            price: Number(set.price || 0)
        };

        newlyAllocated.push(allocation);

        const existing = allocatedSets.find(
            item =>
                String(item.purchaseSetId) ===
                String(set._id)
        );

        if (existing) {
            existing.quantity += take;
        } else {
            allocatedSets.push({
                ...allocation
            });
        }

        if (!selectedSetId) {
            selectedSetId = String(set._id);
        }

        remaining -= take;
    }

    if (remaining > 0) {
        throw new ApiError(
            400,
            `Unable to allocate ${quantity} physical units from purchase sets for variant "${variant.name}".`
        );
    }

    return {
        allocatedSets,
        newlyAllocated,
        selectedSetId,
        totalCost
    };
};


/**
 * Restore physical order quantity to the exact purchase
 * sets that were allocated to the order.
 *
 * Restores BOTH:
 * - purchaseSet.availableStock
 * - purchaseSet.remainingStock
 */
export const restoreOrderPurchaseSets = ({
    variant,
    allocatedSets,
    quantity
}) => {
    let remaining = Number(quantity || 0);

    let restoredCost = 0;
    let restoredQty = 0;

    for (const allocation of allocatedSets) {
        if (remaining <= 0) break;

        const allocatedQuantity = Number(
            allocation.quantity || 0
        );

        const restoreQuantity = Math.min(
            remaining,
            allocatedQuantity
        );

        if (restoreQuantity <= 0) {
            continue;
        }

        const set = variant.purchaseSets.id(
            allocation.purchaseSetId
        );

        if (!set) {
            console.warn(`[restoreOrderPurchaseSets] Purchase set ${allocation.purchaseSetId} was not found for variant "${variant.name}". Using fallback.`);
            continue;
        }

        set.availableStock +=
            restoreQuantity;

        set.remainingStock +=
            restoreQuantity;

        allocation.quantity -=
            restoreQuantity;

        restoredCost +=
            restoreQuantity *
            Number(allocation.price || 0);

        restoredQty += restoreQuantity;

        remaining -= restoreQuantity;
    }

    if (remaining > 0) {
        if (variant.purchaseSets && variant.purchaseSets.length > 0) {
            const firstSet = variant.purchaseSets[0];
            firstSet.availableStock += remaining;
            firstSet.remainingStock += remaining;
            restoredCost += remaining * Number(firstSet.price || 0);
            restoredQty += remaining;
            remaining = 0;
        } else {
            variant.purchaseSets.push({
                quantity: remaining,
                price: 0,
                availableStock: remaining,
                remainingStock: remaining
            });
            const firstSet = variant.purchaseSets[0];
            restoredCost += remaining * Number(firstSet.price || 0);
            restoredQty += remaining;
            remaining = 0;
        }
    }

    const remainingAllocations =
        allocatedSets.filter(
            allocation =>
                Number(allocation.quantity || 0) > 0
        );

    const remainingQuantity =
        remainingAllocations.reduce(
            (sum, allocation) =>
                sum +
                Number(allocation.quantity || 0),
            0
        );

    const remainingCost =
        remainingAllocations.reduce(
            (sum, allocation) =>
                sum +
                Number(allocation.quantity || 0) *
                Number(allocation.price || 0),
            0
        );

    const purchasePrice =
        remainingQuantity > 0
            ? Number(
                (
                    remainingCost /
                    remainingQuantity
                ).toFixed(3)
            )
            : 0;

    const restoredPurchasePrice =
        restoredQty > 0
            ? Number(
                (
                    restoredCost /
                    restoredQty
                ).toFixed(3)
            )
            : 0;

    const selectedSetId =
        remainingAllocations.length > 0
            ? String(
                remainingAllocations[0].purchaseSetId
            )
            : "";

    return {
        allocatedSets:
            remainingAllocations,
        purchasePrice,
        restoredPurchasePrice,
        selectedSetId
    };
};