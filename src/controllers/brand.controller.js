import { Brand } from "../models/brand.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Brand Management Controllers
const createBrand = asyncHandler(async (req, res) => {
    const {
        name,
        image,
        active
    } = req.body;

    if (!name || active == undefined || active == null) {
        throw new ApiError(404, "Complete details not found to create brand");
    }

    const newBrand = await Brand.create({
        name,
        image,
        active
    });

    if (!newBrand) {
        throw new ApiError(500, "Could not create brand");
    }

    return res.status(201).json(
        new ApiResponse(201, newBrand, "Brand created successfully")
    )

});

const updateBrand = asyncHandler(async (req, res) => {
    const updates = req.body;
    const { brandId } = req?.body;

    if (!updates) {
        throw new ApiError(404, "Nothing found to update in brand");
    }

    if (!brandId) {
        throw new ApiError(500, "Could not find brand Id");
    }

    const foundBrand = await Brand.findById(brandId);
    if (!foundBrand) {
        throw new ApiError(500, "Brand not found");
    }

    const updatedBrand = await Brand.findByIdAndUpdate(
        brandId,
        {
            ...updates
        },
        { new: true }
    );

    if (!updatedBrand) {
        throw new ApiError(500, "Could not update brand");
    }

    return res.status(201).json(
        new ApiResponse(201, updatedBrand, "Brand updated successfully")
    )

});

const getBrands = asyncHandler(async (req, res) => {
    const { searchQuery, search, active } = req.query;
    let { page, limit } = req.query;

    const filter = {};
    if (active !== undefined && active !== null && active !== "" && active !== "all") {
        filter.active = active === "true" || active === true;
    } else {
        filter.active = true;
    }

    const query = searchQuery || search;
    if (query && query.trim()) {
        filter.name = { $regex: query.trim(), $options: "i" };
    }

    if (page !== undefined && limit !== undefined) {
        page = parseInt(page, 10) || 1;
        limit = parseInt(limit, 10) || 10;
        const skip = (page - 1) * limit;

        const totalBrands = await Brand.countDocuments(filter);
        const totalPages = Math.ceil(totalBrands / limit);

        const brands = await Brand.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        return res.status(200).json(
            new ApiResponse(200, {
                brands,
                pagination: {
                    totalBrands,
                    totalPages,
                    currentPage: page,
                    limit,
                    hasMore: page < totalPages
                }
            }, "Brands fetched successfully")
        );
    }

    const allBrands = await Brand.find(filter).sort({ createdAt: -1 });

    return res.status(200).json(
        new ApiResponse(200, allBrands, "Brands fetched successfully")
    );
});

const getBrandsAdmin = asyncHandler(async (req, res) => {
    const { searchQuery, search, active } = req.query;
    let { page, limit } = req.query;

    const filter = {};
    if (active !== undefined && active !== null && active !== "" && active !== "all") {
        filter.active = active === "true" || active === true;
    }

    const query = searchQuery || search;
    if (query && query.trim()) {
        filter.name = { $regex: query.trim(), $options: "i" };
    }

    if (page !== undefined && limit !== undefined) {
        page = parseInt(page, 10) || 1;
        limit = parseInt(limit, 10) || 10;
        const skip = (page - 1) * limit;

        const totalBrands = await Brand.countDocuments(filter);
        const totalPages = Math.ceil(totalBrands / limit);

        const brands = await Brand.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        return res.status(200).json(
            new ApiResponse(200, {
                brands,
                pagination: {
                    totalBrands,
                    totalPages,
                    currentPage: page,
                    limit,
                    hasMore: page < totalPages
                }
            }, "Brands fetched successfully for admin")
        );
    }

    const allBrands = await Brand.find(filter).sort({ createdAt: -1 });

    return res.status(200).json(
        new ApiResponse(200, allBrands, "Brands fetched successfully for admin")
    );
});

export {
    createBrand,
    updateBrand,
    getBrands,
    getBrandsAdmin
}
