import { Variant } from "../../models/variant.model.js";
import { ApiError } from "../ApiError.js";


/**
 * Deep clone quotation purchase-set allocations.
 */
export const clonePurchaseSets = (
    purchaseSets = []
) =>
    purchaseSets.map(set => ({
        purchaseSetId: String(
            set.purchaseSetId
        ),
        quantity: Number(
            set.quantity || 0
        ),
        price: Number(
            set.price || 0
        )
    }));

/**
 * Reserve additional purchase-set quantities.
 *
 * Uses the existing Variant.purchaseSets.availableStock
 * and allocates exactly `quantity`.
 */
export const allocatePurchaseSets = ({
    variant,
    allocatedSets,
    quantity,
    selectedSetId = ""
}) => {
    let remaining = quantity;
    let totalCost = 0;

    const sortedSets =
        variant.purchaseSets
            .map((set, index) => ({
                set,
                index
            }))
            .filter(
                ({ set }) =>
                    Number(
                        set.availableStock || 0
                    ) > 0
            )
            .sort(
                (a, b) =>
                    Number(a.set.price || 0) -
                    Number(b.set.price || 0)
            );

    for (const { set } of sortedSets) {
        if (remaining <= 0) {
            break;
        }

        const available = Number(
            set.availableStock || 0
        );

        const take = Math.min(
            remaining,
            available
        );

        if (take <= 0) {
            continue;
        }

        set.availableStock -= take;

        totalCost +=
            take *
            Number(set.price || 0);

        const existing =
            allocatedSets.find(
                item =>
                    String(
                        item.purchaseSetId
                    ) === String(set._id)
            );

        if (existing) {
            existing.quantity += take;
        } else {
            allocatedSets.push({
                purchaseSetId: String(
                    set._id
                ),
                quantity: take,
                price: Number(
                    set.price || 0
                )
            });
        }

        if (!selectedSetId) {
            selectedSetId = String(
                set._id
            );
        }

        remaining -= take;
    }

    if (remaining > 0) {
        throw new ApiError(
            400,
            `Unable to allocate ${quantity} units from purchase sets for variant "${variant.name}".`
        );
    }

    return {
        allocatedSets,
        selectedSetId,
        totalCost
    };
};

/**
 * Restore quantity to the exact purchase-set allocations
 * currently held by the quotation.
 *
 * Returns:
 *   purchasePrice        — weighted avg of units REMAINING in quotation (for item update)
 *   restoredPurchasePrice — weighted avg of units REMOVED (for stock log P&L)
 *   allocatedSets        — remaining (non-zero) allocations
 *   selectedSetId        — first remaining set id
 */
export const restorePurchaseSets = ({
    variant,
    allocatedSets,
    quantity
}) => {
    let remaining = quantity;

    // Track cost of units being restored/removed — for stock log purchase price
    let restoredCost = 0;
    let restoredQty = 0;

    for (const allocation of allocatedSets) {
        if (remaining === 0) {
            break;
        }

        const allocQty = Number(allocation.quantity || 0);
        const restoreQuantity = Math.min(remaining, allocQty);

        // Always track restored cost from the allocation record
        // (even if the set is no longer in the variant — data may be desynced)
        restoredCost += restoreQuantity * Number(allocation.price || 0);
        restoredQty += restoreQuantity;

        const set =
            variant.purchaseSets.id(
                allocation.purchaseSetId
            );

        if (!set) {
            /*
             * Purchase set no longer exists in the variant
             * (deleted or desynced from prior aborted transaction).
             * Skip variant mutation — variant.availableStock is
             * already handled by releaseVariantStock.
             */
            console.warn(
                `[restorePurchaseSets] Purchase set ${allocation.purchaseSetId} not found for variant "${variant.name}" — skipping variant mutation.`
            );
            allocation.quantity -= restoreQuantity;
            remaining -= restoreQuantity;
            continue;
        }

        set.availableStock +=
            restoreQuantity;

        allocation.quantity -=
            restoreQuantity;

        remaining -=
            restoreQuantity;
    }

    if (remaining > 0) {
        /*
         * allocatedSets don't cover the full quantity —
         * data is desynced from a prior aborted transaction.
         * Log a warning and continue. The variant's
         * availableStock is already correct.
         */
        console.warn(
            `[restorePurchaseSets] Could not account for ${remaining} of ${quantity} units for variant "${variant.name}" in purchase sets — data desynced. Run inventory resync.`
        );
    }

    // Price of units that were REMOVED — for the stock log (P&L)
    const restoredPurchasePrice =
        restoredQty > 0
            ? Number((restoredCost / restoredQty).toFixed(3))
            : 0;

    const remainingAllocations =
        allocatedSets.filter(
            allocation =>
                Number(
                    allocation.quantity
                ) > 0
        );

    const remainingQuantity =
        remainingAllocations.reduce(
            (sum, allocation) =>
                sum +
                Number(
                    allocation.quantity ||
                    0
                ),
            0
        );

    const remainingCost =
        remainingAllocations.reduce(
            (sum, allocation) =>
                sum +
                Number(
                    allocation.quantity ||
                    0
                ) *
                Number(
                    allocation.price ||
                    0
                ),
            0
        );

    // Price of units that REMAIN — for the quotation item purchasePrice
    const purchasePrice =
        remainingQuantity > 0
            ? Number(
                (
                    remainingCost /
                    remainingQuantity
                ).toFixed(3)
            )
            : 0;

    const selectedSetId =
        remainingAllocations.length > 0
            ? String(
                remainingAllocations[0]
                    .purchaseSetId
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

/**
 * Weighted purchase price when additional quantity
 * is added.
 */
export const calculateWeightedPurchasePrice =
    ({
        oldPurchasePrice,
        oldQuantity,
        newPurchasePrice,
        newQuantity
    }) => {
        const totalQuantity =
            oldQuantity + newQuantity;

        if (totalQuantity <= 0) {
            return 0;
        }

        return Number(
            (
                (
                    oldPurchasePrice *
                    oldQuantity +
                    newPurchasePrice *
                    newQuantity
                ) /
                totalQuantity
            ).toFixed(3)
        );
    };

/**
 * Persist purchaseSets only.
 *
 * IMPORTANT:
 * availableStock has already been modified atomically
 * using $inc and must NOT be rewritten here.
 */
export const savePurchaseSets = async ({
    variantId,
    purchaseSets,
    session
}) => {
    const result =
        await Variant.updateOne(
            {
                _id: variantId
            },
            {
                $set: {
                    purchaseSets
                }
            },
            {
                session
            }
        );

    if (result.matchedCount === 0) {
        throw new ApiError(
            500,
            `Failed to update purchase sets for variant ${variantId}.`
        );
    }
};