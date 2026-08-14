import { Stock } from "../../models/stock.model.js";

export const buildPendingStockLog = ({
    quotation,
    variant,
    productId,
    type,
    quantity,
    purchasePrice,
    previousStock,
    updatedStock,
    price,
    discount,
    itemQuantity
}) => ({
    quotationId:
        quotation.quotationId,
    quotationRef:
        quotation._id,
    type,
    category: "virtual",
    variantId:
        variant._id,
    variantName:
        variant.name,
    purchasePrice:
        Number(purchasePrice || 0),
    quantity:
        Number(quantity || 0),
    previousStock:
        Number(previousStock || 0),
    updatedStock:
        Number(updatedStock || 0),
    previousPhysicalStock:
        Number(
            variant.totalStock || 0
        ),
    updatedPhysicalStock:
        Number(
            variant.totalStock || 0
        ),
    productId,

    /*
     * Keep current application's selling-price
     * contract untouched until frontend/backend
     * discount semantics have been verified.
     */
    priceContext: {
        price,
        discount,
        quantity: itemQuantity
    }
});

export const insertPendingStockLogs =
    async ({
        pendingLogs,
        productStockMap,
        session
    }) => {
        const results = [];

        for (const pending of pendingLogs) {
            const productStockResult =
                productStockMap.get(
                    String(
                        pending.productId
                    )
                );

            const totalProductStock =
                Number(
                    productStockResult
                        ?.totalStock || 0
                );

            /*
             * IMPORTANT:
             * Keep the current formula exactly as it exists
             * in the application until frontend/backend
             * contract is verified.
             */
            const price =
                Number(
                    pending
                        .priceContext
                        ?.price || 0
                );

            const discount =
                Number(
                    pending
                        .priceContext
                        ?.discount || 0
                );

            const quantity =
                Number(
                    pending
                        .priceContext
                        ?.quantity || 1
                );

            /*
             * sellingPrice is per-unit.
             * `discount` from priceContext is already a per-unit flat
             * discount amount (same contract as item.discount on the
             * quotation), so no division by quantity is needed.
             */
            const sellingPrice =
                price - discount;

            const [log] =
                await Stock.create(
                    [
                        {
                            ...pending,
                            priceContext:
                                undefined,
                            totalProductStock,
                            sellingPrice
                        }
                    ],
                    {
                        session
                    }
                );

            results.push({
                log,
                itemStockIdsRef:
                    pending.itemStockIdsRef ||
                    null
            });
        }

        return results;
    };

/**
 * When a quotation item's unit price or discount changes,
 * all existing stock log entries linked to that item are
 * re-stamped with the updated selling price.
 *
 * This is intentional for P&L accuracy: every stock entry
 * for an item reflects the price at which it was sold to
 * the customer, and that price is the current quotation price.
 *
 * NOTE: newly inserted logs from this same session already
 * have the correct sellingPrice set at insertion time, so
 * this updateMany is a harmless overwrite for those entries.
 */
export const syncStockLogSellingPrices =
    async ({
        items,
        quotationRef,
        session
    }) => {
        for (const item of items) {
            const finalUnitSellingPrice =
                Number(item.price || 0) -
                Number(item.discount || 0);

            const queryConditions = [];
            if (quotationRef) {
                const cond = { quotationRef };
                if (item.variantId) {
                    cond.variantId = item.variantId;
                } else {
                    if (item.productId) {
                        cond.productId = item.productId;
                    }
                    if (item.variantName) {
                        cond.variantName = item.variantName;
                    }
                }
                queryConditions.push(cond);
            }

            if (item.stockIds && item.stockIds.length > 0) {
                queryConditions.push({
                    _id: {
                        $in: item.stockIds
                    }
                });
            }

            if (queryConditions.length === 0) {
                continue;
            }

            await Stock.updateMany(
                {
                    $or: queryConditions
                },
                {
                    $set: {
                        sellingPrice:
                            finalUnitSellingPrice,
                        purchasePrice:
                            Number(item.purchasePrice || 0)
                    }
                },
                { session }
            );
        }
    };