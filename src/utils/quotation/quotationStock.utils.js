import { Variant } from "../../models/variant.model.js";
import { Inventory } from "../../models/inventory.model.js";
import { Product } from "../../models/product.model.js";
import { ApiError } from "../ApiError.js";

/**
 * Atomically reserve additional Variant stock.
 * Variant.availableStock is the authoritative concurrency gate.
 */
export const reserveVariantStock = async ({
    variantId,
    productId,
    variantName,
    quantity,
    session
}) => {
    const query = variantId
        ? {
            _id: variantId,
            active: true,
            availableStock: { $gte: quantity }
        }
        : {
            productId,
            name: variantName,
            active: true,
            availableStock: { $gte: quantity }
        };

    const variant = await Variant.findOneAndUpdate(
        query,
        {
            $inc: {
                availableStock: -quantity
            }
        },
        {
            new: true,
            session
        }
    );

    if (!variant) {
        throw new ApiError(
            400,
            `Insufficient available stock for variant "${variantName}".`
        );
    }

    return {
        variant,
        previousAvailableStock:
            variant.availableStock + quantity,
        updatedAvailableStock:
            variant.availableStock
    };
};

/**
 * Atomically release Variant stock.
 */
export const releaseVariantStock = async ({
    variantId,
    productId,
    variantName,
    quantity,
    session
}) => {
    const query = variantId
        ? {
            _id: variantId,
            active: true
        }
        : {
            productId,
            name: variantName,
            active: true
        };

    const variant = await Variant.findOneAndUpdate(
        query,
        {
            $inc: {
                availableStock: quantity
            }
        },
        {
            new: true,
            session
        }
    );

    if (!variant) {
        throw new ApiError(
            400,
            `Could not find variant to restore stock for "${variantName}".`
        );
    }

    return {
        variant,
        previousAvailableStock:
            variant.availableStock - quantity,
        updatedAvailableStock:
            variant.availableStock
    };
};

/**
 * Atomically increase Inventory.reservedStock.
 */
export const reserveInventoryStock = async ({
    productId,
    quantity,
    session
}) => {
    const inventory = await Inventory.findOneAndUpdate(
        {
            product: productId
        },
        {
            $inc: {
                reservedStock: quantity
            }
        },
        {
            new: true,
            session
        }
    );

    if (!inventory) {
        throw new ApiError(
            500,
            `Inventory record not found for product ${productId}.`
        );
    }

    return inventory;
};

/**
 * Atomically decrease Inventory.reservedStock.
 *
 * Uses $max aggregation to clamp at 0 — the Inventory.reservedStock
 * can drift when transactions abort mid-way (e.g. nodemon restarts).
 * The real concurrency gate is Variant.availableStock in reserveVariantStock.
 * Run resync_inventory.js to repair the desynced values.
 */
export const releaseInventoryStock = async ({
    productId,
    quantity,
    session
}) => {
    const inventory = await Inventory.findOneAndUpdate(
        { product: productId },
        [
            {
                $set: {
                    reservedStock: {
                        $max: [
                            0,
                            { $subtract: ['$reservedStock', quantity] }
                        ]
                    }
                }
            }
        ],
        {
            returnDocument: 'after',
            updatePipeline: true,
            session
        }
    );

    if (!inventory) {
        throw new ApiError(
            500,
            `Inventory record not found for product ${productId}.`
        );
    }

    return inventory;
};


/**
 * Synchronize Product aggregate stock and Inventory.physicalStock
 * from all variants.
 *
 * DOES NOT modify Inventory.reservedStock.
 */
export const syncProductStock2 = async (
    productId,
    session
) => {
    const variants = await Variant.find({
        productId
    }).session(session);

    let totalStock = 0;
    let availableStock = 0;

    for (const variant of variants) {
        totalStock += Number(
            variant.totalStock || 0
        );

        availableStock += Number(
            variant.availableStock || 0
        );
    }

    const inventory = await Inventory.findOne({
        product: productId
    }).session(session);

    if (!inventory) {
        throw new ApiError(
            500,
            `Inventory record not found while syncing product ${productId}.`
        );
    }

    // if (
    //     Number(inventory.reservedStock || 0) >
    //     totalStock
    // ) {
    //     throw new ApiError(
    //         500,
    //         `Reserved stock exceeds physical stock for product ${productId}.`
    //     );
    // }

    await Product.findByIdAndUpdate(
        productId,
        {
            totalStock,
            availableStock
        },
        {
            session
        }
    );

    await Inventory.findOneAndUpdate(
        {
            product: productId
        },
        {
            $set: {
                physicalStock: totalStock
            }
        },
        {
            new: true,
            session
        }
    );

    return {
        totalStock,
        availableStock
    };
};