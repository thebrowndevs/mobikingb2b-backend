import { Variant } from "../../models/variant.model.js";
import { ApiError } from "../ApiError.js";


/**
 * Atomically consume physical stock for a new order.
 *
 * Variant:
 *   totalStock      -= quantity
 *   availableStock  -= quantity
 */
export const reserveOrderVariantStock =
    async ({
        variantId,
        quantity,
        session
    }) => {
        const variant =
            await Variant.findOneAndUpdate(
                {
                    _id:
                        variantId,

                    active:
                        true,

                    totalStock:
                    {
                        $gte:
                            quantity
                    },

                    availableStock:
                    {
                        $gte:
                            quantity
                    }
                },
                {
                    $inc: {
                        totalStock:
                            -quantity,

                        availableStock:
                            -quantity
                    }
                },
                {
                    new:
                        true,
                    session
                }
            );

        if (!variant) {
            throw new ApiError(
                409,
                "Insufficient stock. Please refresh your cart and try again."
            );
        }

        return {
            variant,

            previousAvailableStock:
                variant.availableStock +
                quantity,

            updatedAvailableStock:
                variant.availableStock,

            previousPhysicalStock:
                variant.totalStock +
                quantity,

            updatedPhysicalStock:
                variant.totalStock
        };
    };


/**
 * Consume physical quantity from purchase sets.
 *
 * Unlike quotation allocation, an order consumes:
 *
 *   purchaseSet.availableStock
 *   purchaseSet.remainingStock
 */
export const allocateOrderPurchaseSets =
    ({
        variant,
        quantity
    }) => {
        let remaining =
            Number(quantity);

        let totalCost = 0;

        let selectedSetId =
            "";

        const allocatedSets =
            [];

        const sortedSets =
            variant.purchaseSets
                .filter(
                    set =>
                        Number(
                            set.availableStock ||
                            0
                        ) > 0
                )
                .sort(
                    (a, b) =>
                        Number(
                            a.price ||
                            0
                        ) -
                        Number(
                            b.price ||
                            0
                        )
                );

        for (
            const set of
            sortedSets
        ) {
            if (
                remaining <=
                0
            ) {
                break;
            }

            const available =
                Number(
                    set.availableStock ||
                    0
                );

            const take =
                Math.min(
                    remaining,
                    available
                );

            if (
                take <=
                0
            ) {
                continue;
            }

            set.availableStock -=
                take;

            set.remainingStock =
                Math.max(
                    0,
                    Number(
                        set.remainingStock ||
                        0
                    ) -
                    take
                );

            totalCost +=
                take *
                Number(
                    set.price ||
                    0
                );

            allocatedSets.push({
                purchaseSetId:
                    String(
                        set._id
                    ),
                quantity:
                    take,
                price:
                    Number(
                        set.price ||
                        0
                    )
            });

            if (
                !selectedSetId
            ) {
                selectedSetId =
                    String(
                        set._id
                    );
            }

            remaining -=
                take;
        }

        /*
         * NEVER fabricate missing batch allocation.
         */
        if (
            remaining > 0
        ) {
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