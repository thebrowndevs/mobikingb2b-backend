import { Product } from "../models/product.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { SubCategory } from "../models/sub_category.model.js";
import mongoose from "mongoose";

// export const searchProducts = asyncHandler(async (req, res) => {
//   const query = req.query.q?.trim();
//   const priceTo = req.query.priceTo?.trim();
//   const priceFrom = req.query.priceFrom?.trim();

//   if (!query || query.length < 2) {
//     throw new ApiError(400, "Search query must be at least 2 characters");
//   }

//   const regex = new RegExp(query, "i"); // Case-insensitive partial match

//   const filter = {
//     $or: [{ name: regex }, { fullName: regex }]
//   };

//   // Optional active filter
//   filter.active = true;

//   const products = await Product.find(filter)
//     .populate("orders stock groups category") // optional populate
//     .lean();

//   return res.status(200).json(
//     new ApiResponse(200, products, "Products fetched successfully")
//   );
// });

export const getSearchSuggestions = asyncHandler(async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) {
    throw new ApiError(400, "Query is required");
  }

  const regex = new RegExp(query, "i"); // case-insensitive

  // 1️⃣ Fetch product tags
  const products = await Product.find(
    { tags: regex }, // match inside tags
    "tags"           // only fetch tags
  );

  // 2️⃣ Fetch subcategory tags
  const subCategories = await SubCategory.find(
    { tags: regex },
    "tags"
  );

  // 3️⃣ Flatten & dedupe tags
  const productTags = [...new Set(products.flatMap(p => p.tags))];
  const subCategoryTags = [...new Set(subCategories.flatMap(sc => sc.tags))];

  // 4️⃣ Filter by regex (in case some tags slipped in)
  const filteredProductTags = productTags.filter(tag => regex.test(tag));
  const filteredSubCategoryTags = subCategoryTags.filter(tag => regex.test(tag));

  // 5️⃣ Build suggestions
  const suggestions = {
    productSuggestions: filteredProductTags,
    subCategorySuggestions: filteredSubCategoryTags
  };

  return res.status(200).json(
    new ApiResponse(200, { query, suggestions }, "Suggestions fetched successfully")
  );
});

/**
 * Cursor-based search: client sends lastIndex (index of last item returned) and limit.
 * Server returns products and pagination { lastIndex, limit, returned, total, hasMore }.
 */
export const searchProductsPaginated = asyncHandler(async (req, res) => {
  const query = req.query.q?.trim();
  const searchKey = req.query?.searchKey?.trim();
  const priceTo = parseFloat(req.query.priceTo);
  const priceFrom = parseFloat(req.query.priceFrom);
  const orderBy = req.query?.orderBy?.toLowerCase();

  // cursor params
  const lastIndex = Math.max(-1, parseInt(req.query.lastIndex, 10) || -1); // -1 => start
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const start = lastIndex + 1;

  if (!query && !searchKey) {
    throw new ApiError(400, "Search query or search key not found");
  }
  if (query && query.length < 2) {
    throw new ApiError(400, "Search query must be at least 2 characters");
  }

  // Parse brand IDs
  let brandIds = req.query?.brand;
  let objectIds = [];
  if (brandIds) {
    if (!Array.isArray(brandIds)) brandIds = [brandIds];
    objectIds = brandIds
      .filter(Boolean)
      .map(id => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null))
      .filter(Boolean);
  }

  if (orderBy) {
    // ----------------------------------------------------
    // CASE A: Price sorting requested -> Use Aggregation Pipeline
    // ----------------------------------------------------
    const matchStage = { active: true };

    if (searchKey) {
      const regex = new RegExp(searchKey, "i");
      matchStage.tags = regex;
    } else if (query) {
      const words = query.split(/\s+/).filter(Boolean);
      const regexArray = words.map(word => new RegExp(word, "i"));
      matchStage.$or = [
        { $and: regexArray.map(r => ({ name: r })) },
        { $and: regexArray.map(r => ({ fullName: r })) }
      ];
    }

    if (objectIds.length > 0) {
      matchStage.brand = { $in: objectIds };
    }

    // price filter for latestPrice
    const priceFilter = {};
    if (!isNaN(priceFrom)) priceFilter.$gte = priceFrom;
    if (!isNaN(priceTo)) priceFilter.$lte = priceTo;

    // Pipeline helper that extracts latest price (last index element)
    const addLatestPriceStage = {
      $addFields: {
        latestPrice: {
          $let: {
            vars: {
              latestPriceObj: { $arrayElemAt: ["$sellingPrice", -1] }
            },
            in: { $ifNull: ["$$latestPriceObj.price", 0] }
          }
        }
      }
    };

    // 1) Compute total matching documents
    const countPipeline = [
      { $match: matchStage },
      addLatestPriceStage,
      ...(Object.keys(priceFilter).length > 0 ? [{ $match: { latestPrice: priceFilter } }] : []),
      { $count: "total" }
    ];

    const countResult = await Product.aggregate(countPipeline).exec();
    const total = (countResult[0] && countResult[0].total) ? countResult[0].total : 0;

    // if start beyond total, return empty array with pagination
    if (start >= total) {
      return res.status(200).json(new ApiResponse(200, {
        products: [],
        pagination: {
          lastIndex,
          limit,
          returned: 0,
          total,
          hasMore: false
        }
      }, "Products fetched successfully"));
    }

    // 2) Fetch products, sort, and paginate
    const pipeline = [
      { $match: matchStage },
      addLatestPriceStage,
      ...(Object.keys(priceFilter).length > 0 ? [{ $match: { latestPrice: priceFilter } }] : []),
      {
        $project: {
          orders: 0,
          stock: 0,
          groups: 0,
          category: 0
        }
      },
      {
        $sort: {
          latestPrice: orderBy === "desc" ? -1 : 1,
          totalStock: -1,
          _id: 1
        }
      },
      { $skip: start },
      { $limit: limit }
    ];

    const products = await Product.aggregate(pipeline, { allowDiskUse: true }).exec();

    const returned = Array.isArray(products) ? products.length : 0;
    const newLastIndex = start + returned - 1;
    const hasMore = (start + returned) < total;

    return res.status(200).json(new ApiResponse(200, {
      products,
      pagination: {
        lastIndex: newLastIndex,
        limit,
        returned,
        total,
        hasMore
      }
    }, "Products fetched successfully"));
  } else {
    // ----------------------------------------------------
    // CASE B: Default sorting -> Use Standard Mongoose Query
    // ----------------------------------------------------
    const matchQuery = { active: true };

    if (searchKey) {
      const regex = new RegExp(searchKey, "i");
      matchQuery.tags = regex;
    } else if (query) {
      const words = query.split(/\s+/).filter(Boolean);
      const regexArray = words.map(word => new RegExp(word, "i"));
      matchQuery.$or = [
        { $and: regexArray.map(r => ({ name: r })) },
        { $and: regexArray.map(r => ({ fullName: r })) }
      ];
    }

    if (objectIds.length > 0) {
      matchQuery.brand = { $in: objectIds };
    }

    // price filter for latestPrice (latest index value in sellingPrice array)
    const exprConditions = [];
    const latestPriceExpr = { $arrayElemAt: ["$sellingPrice.price", -1] };

    if (!isNaN(priceFrom)) {
      exprConditions.push({ $gte: [latestPriceExpr, priceFrom] });
    }
    if (!isNaN(priceTo)) {
      exprConditions.push({ $lte: [latestPriceExpr, priceTo] });
    }
    if (exprConditions.length > 0) {
      matchQuery.$expr = exprConditions.length === 1 ? exprConditions[0] : { $and: exprConditions };
    }

    // 1) Compute total matching documents using countDocuments
    const total = await Product.countDocuments(matchQuery);

    // if start beyond total, return empty array with pagination
    if (start >= total) {
      return res.status(200).json(new ApiResponse(200, {
        products: [],
        pagination: {
          lastIndex,
          limit,
          returned: 0,
          total,
          hasMore: false
        }
      }, "Products fetched successfully"));
    }

    // 2) Fetch products with the query, sort, and skip/limit pagination
    const products = await Product.find(matchQuery)
      .select("-orders -stock -groups -category")
      .sort({ totalStock: -1, _id: 1 })
      .skip(start)
      .limit(limit)
      .lean()
      .exec();

    const returned = Array.isArray(products) ? products.length : 0;
    const newLastIndex = start + returned - 1;
    const hasMore = (start + returned) < total;

    return res.status(200).json(new ApiResponse(200, {
      products,
      pagination: {
        lastIndex: newLastIndex,
        limit,
        returned,
        total,
        hasMore
      }
    }, "Products fetched successfully"));
  }
});


export const searchProducts = asyncHandler(async (req, res) => {
  const query = req.query.q?.trim();
  const searchKey = req.query?.searchKey?.trim();
  const priceTo = parseFloat(req.query.priceTo);
  const priceFrom = parseFloat(req.query.priceFrom);
  const orderBy = req.query?.orderBy?.toLowerCase() || "asc"; // ✅ default ascending

  if (!query && !searchKey) {
    throw new ApiError(400, "Search query or search key not found");
  }

  if (query && query.length < 2) {
    throw new ApiError(400, "Search query must be at least 2 characters");
  }

  // ✅ Always enforce active products
  let matchStage = { $and: [{ active: true }] };

  if (searchKey) {
    const regex = new RegExp(searchKey, "i");
    matchStage.$and.push({ tags: regex });
  } else if (query) {
    // ✅ Tokenize query and build regex for each word
    const words = query.split(/\s+/).filter(Boolean);
    const regexArray = words.map(word => new RegExp(word, "i"));

    matchStage.$and.push({
      $or: [
        { $and: regexArray.map(r => ({ name: r })) },
        { $and: regexArray.map(r => ({ fullName: r })) },
        { $or: regexArray.map(r => ({ "categoryDoc.name": r })) }
      ]
    });
  }

  // --- Brand filter (multiple brandIds) ---
  let brandIds = req.query?.brand;
  if (brandIds) {
    if (!Array.isArray(brandIds)) {
      brandIds = [brandIds];
    }
    matchStage.$and.push({
      brand: { $in: brandIds.map(id => new mongoose.Types.ObjectId(id)) }
    });
  }

  // --- Price filter ---
  const priceFilter = {};
  if (!isNaN(priceFrom)) priceFilter.$gte = priceFrom;
  if (!isNaN(priceTo)) priceFilter.$lte = priceTo;

  // Build root words regex for category match to support singular/plural matches
  let categoryRegex = "";
  if (query) {
    const words = query.split(/\s+/).filter(Boolean);
    const rootWords = words.map(w => {
      let root = w.toLowerCase();
      if (root.endsWith("es")) root = root.slice(0, -2);
      else if (root.endsWith("s") && !root.endsWith("ss")) root = root.slice(0, -1);
      return root;
    }).filter(word => word.length > 2);

    const isAudioQuery = rootWords.some(w =>
      ["headphone", "earphone", "neckband", "earbud", "airpod", "headset", "audio", "sound", "wireless", "bluetooth"].includes(w)
    );

    if (isAudioQuery) {
      categoryRegex = "wireless|bluetooth|neckband|earphone|headphone|earbud|airpod|headset|audio";
    } else {
      categoryRegex = rootWords.join("|");
    }
  }

  const pipeline = [
    {
      $lookup: {
        from: "subcategories",
        localField: "category",
        foreignField: "_id",
        as: "categoryDoc"
      }
    },
    { $match: matchStage },
    {
      $addFields: {
        latestPrice: {
          $let: {
            vars: {
              sortedPrices: { $sortArray: { input: "$sellingPrice", sortBy: { createdAt: -1 } } }
            },
            in: { $arrayElemAt: ["$$sortedPrices.price", 0] }
          }
        },
        hasStock: { $cond: [{ $gt: ["$totalStock", 0] }, 1, 0] },
        isCategoryMatch: {
          $cond: {
            if: {
              $and: [
                { $ne: [categoryRegex, ""] },
                {
                  $regexMatch: {
                    input: { $ifNull: [{ $arrayElemAt: ["$categoryDoc.name", 0] }, ""] },
                    regex: categoryRegex,
                    options: "i"
                  }
                }
              ]
            },
            then: 1,
            else: 0
          }
        }
      }
    },
    ...(Object.keys(priceFilter).length > 0
      ? [{ $match: { latestPrice: priceFilter } }]
      : []),
    {
      $project: {
        orders: 0,      // exclude orders
        stock: 0,  // exclude totalStock
        groups: 0,
        category: 0,
        categoryDoc: 0
      }
    },
    {
      $sort: { isCategoryMatch: -1, hasStock: -1, latestPrice: orderBy === "desc" ? -1 : 1 }
    }
  ];

  const products = await Product.aggregate(pipeline, { allowDiskUse: true });

  return res.status(200).json(
    new ApiResponse(200, products, "Products fetched successfully")
  );
});

// export const searchProducts = asyncHandler(async (req, res) => {
//   const query = req.query.q?.trim();
//   const searchKey = req.query?.searchKey?.trim();
//   const priceTo = parseFloat(req.query.priceTo);
//   const priceFrom = parseFloat(req.query.priceFrom);
//   const orderBy = req.query?.orderBy?.toLowerCase() || "asc"; // ✅ default ascending

//   if (!query && !searchKey) {
//     throw new ApiError(400, "Search query or search key not found");
//   }

//   if (query && query.length < 2) {
//     throw new ApiError(400, "Search query must be at least 2 characters");
//   }

//   let matchStage = {};

//   if (searchKey) {
//     const regex = new RegExp(searchKey, "i"); // Case-insensitive partial match
//     // console.log(searchKey, regex);
//     matchStage = {
//       $and: [
//         { active: true },
//         {
//           tags: regex
//         }
//       ]
//     }
//   } else if (query) {
//     const regex = new RegExp(query, "i"); // Case-insensitive partial match
//     matchStage = {
//       $and: [
//         { active: true },
//         { $or: [{ name: regex }, { fullName: regex }] }
//       ]
//     };
//   }

//   // --- Brand filter (multiple brandIds) ---
//   let brandIds = req.query?.brand;
//   if (brandIds) {
//     // Ensure it's always an array
//     if (!Array.isArray(brandIds)) {
//       brandIds = [brandIds];
//     }

//     matchStage.$and.push({
//       brand: { $in: brandIds.map(id => new mongoose.Types.ObjectId(id)) }
//     });
//   }

//   // --- Price filter ---
//   const priceFilter = {};
//   if (!isNaN(priceFrom)) priceFilter.$gte = priceFrom;
//   if (!isNaN(priceTo)) priceFilter.$lte = priceTo;

//   const pipeline = [
//     { $match: matchStage },
//     // Keep only the latest sellingPrice entry
//     {
//       $addFields: {
//         latestPrice: {
//           $let: {
//             vars: {
//               sortedPrices: { $sortArray: { input: "$sellingPrice", sortBy: { createdAt: -1 } } }
//             },
//             in: { $arrayElemAt: ["$$sortedPrices.price", 0] }
//           }
//         }
//       }
//     },
//     ...(Object.keys(priceFilter).length > 0
//       ? [{ $match: { latestPrice: priceFilter } }]
//       : []),
//     // {
//     //   $lookup: {
//     //     from: "orders",
//     //     localField: "orders",
//     //     foreignField: "_id",
//     //     as: "orders"
//     //   }
//     // },
//     // {
//     //   $lookup: {
//     //     from: "stocks",
//     //     localField: "stock",
//     //     foreignField: "_id",
//     //     as: "stock"
//     //   }
//     // },
//     {
//       $lookup: {
//         from: "groups",
//         localField: "groups",
//         foreignField: "_id",
//         as: "groups"
//       }
//     },
//     {
//       $lookup: {
//         from: "subcategories",
//         localField: "category",
//         foreignField: "_id",
//         as: "category"
//       }
//     },
//     {
//       $sort: { latestPrice: orderBy === "desc" ? -1 : 1 }
//     }
//   ];

//   const products = await Product.aggregate(pipeline, { allowDiskUse: true });

//   return res.status(200).json(
//     new ApiResponse(200, products, "Products fetched successfully")
//   );
// });
