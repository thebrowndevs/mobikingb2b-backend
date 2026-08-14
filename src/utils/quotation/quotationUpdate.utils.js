import { ApiError } from "../ApiError.js";

export const buildOldItemsMap = (
    quotation
) => {
    const map = new Map();

    for (const item of quotation.items) {
        const key = item.variantId
            ? String(item.variantId)
            : `${String(item.productId)}_${item.variantName}`;

        map.set(key, {
            quantity: Number(
                item.quantity || 0
            ),
            stockIds: [
                ...(item.stockIds || [])
            ],
            price: Number(
                item.price || 0
            ),
            discount: Number(
                item.discount || 0
            ),
            discountPercent: Number(
                item.discountPercent ||
                0
            ),
            discountType:
                item.discountType ||
                "flat",
            purchasePrice: Number(
                item.purchasePrice || 0
            ),
            purchaseSetId:
                item.purchaseSetId ||
                "",
            purchaseSets: (
                item.purchaseSets || []
            ).map(set => ({
                purchaseSetId: String(
                    set.purchaseSetId
                ),
                quantity: Number(
                    set.quantity || 0
                ),
                price: Number(
                    set.price || 0
                )
            })),
            variantId:
                item.variantId
        });
    }

    return map;
};

export const validateAndGetItemKey = ({
    reqItem,
    seenVariantKeys
}) => {
    if (!reqItem.productId) {
        throw new ApiError(
            400,
            "Product ID is required for every quotation item."
        );
    }

    if (
        !reqItem.variantId &&
        !reqItem.variantName
    ) {
        throw new ApiError(
            400,
            "Variant ID or variant name is required for every quotation item."
        );
    }

    const key = reqItem.variantId
        ? String(reqItem.variantId)
        : `${String(reqItem.productId)}_${reqItem.variantName}`;

    if (
        seenVariantKeys.has(key)
    ) {
        throw new ApiError(
            400,
            `Duplicate variant "${reqItem.variantName}" in quotation items.`
        );
    }

    seenVariantKeys.add(key);

    return key;
};

export const calculateItemDelta = ({
    oldInfo,
    quantity
}) => {
    const oldQuantity = Number(
        oldInfo?.quantity || 0
    );

    const newQuantity = Number(
        quantity || 0
    );

    return {
        oldQuantity,
        newQuantity,
        diff:
            newQuantity -
            oldQuantity
    };
};