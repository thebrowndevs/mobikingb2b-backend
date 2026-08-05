import { Stock } from "../models/stock.model.js";
import { ApiError } from "../utils/ApiError.js";

export const createStockEntry = async({
    type,
    vendor,
    variantName,
    purchasePrice,
    quantity,
    previousStock,
    updatedStock,
    productId,
    orderId
})=>{
    try {
        
        // Create stock entry (even for deduction)
            const newProductStock = await Stock.create({
                type,
                vendor,
                variantName,
                purchasePrice,
                quantity,
                previousStock,
                updatedStock,
                productId,
                orderId
            });
        
            console.log("New Product Stock Entry: ",newProductStock);
            if (!newProductStock) {
                throw new ApiError(500, "Could not create stock entry");
            }

            return newProductStock;
            
    } catch (err) {
        console.log("Product Stock Error: ",err);
    }
}