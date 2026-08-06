import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Order } from "../models/order.model.js";
import { Product } from "../models/product.model.js";
import { User } from "../models/user.model.js";
import { Query } from "../models/query.model.js";
import { Coupon } from "../models/coupon.model.js";
import { Brand } from "../models/brand.model.js";

export const getSalesDataController = asyncHandler(async (req, res) => {
  const startDate = req?.query?.startDate;
  const endDate = req?.query?.endDate;

  const salesFilter = { abondonedOrder: false };

  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00+05:30`);
    const end = new Date(`${endDate}T23:59:59.999+05:30`);
    salesFilter.createdAt = { $gte: start, $lte: end };
  }

  salesFilter.status = {
    $nin: ["Rejected", "Cancelled", "Returned", "Replaced", "Hold"]
  };

  const [
    allOrder, websiteOrder, appOrder, posOrder,
    codOrder, onlineOrder, cashOrder, upiOrder
  ] = await Promise.all([
    Order.aggregate([
      { $match: salesFilter },
      { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: "$orderAmount" } } }
    ], { allowDiskUse: true }),

    Order.aggregate([
      { $match: { ...salesFilter, type: "Regular", isAppOrder: false } },
      { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: "$orderAmount" } } }
    ], { allowDiskUse: true }),

    Order.aggregate([
      { $match: { ...salesFilter, type: "Regular", isAppOrder: true } },
      { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: "$orderAmount" } } }
    ], { allowDiskUse: true }),

    Order.aggregate([
      { $match: { ...salesFilter, type: "Pos" } },
      { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: "$orderAmount" } } }
    ], { allowDiskUse: true }),

    Order.aggregate([
      { $match: { ...salesFilter, method: "COD" } },
      { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: "$orderAmount" } } }
    ], { allowDiskUse: true }),

    Order.aggregate([
      { $match: { ...salesFilter, method: "Online" } },
      { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: "$orderAmount" } } }
    ], { allowDiskUse: true }),

    Order.aggregate([
      { $match: { ...salesFilter, method: "Cash" } },
      { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: "$orderAmount" } } }
    ], { allowDiskUse: true }),

    Order.aggregate([
      { $match: { ...salesFilter, method: "UPI" } },
      { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: "$orderAmount" } } }
    ], { allowDiskUse: true }),
  ]);

  const salesData = {
    allOrder: allOrder[0],
    websiteOrder: websiteOrder[0],
    appOrder: appOrder[0],
    posOrder: posOrder[0],
    codOrder: codOrder[0],
    onlineOrder: onlineOrder[0],
    cashOrder: cashOrder[0],
    upiOrder: upiOrder[0]
  };

  return res.status(200).json(new ApiResponse(200, salesData, "Sales data fetched successfully"));
});

/**
 * PAGINATED ORDERS CONTROLLER
 */
export const getPaginatedOrders = asyncHandler(async (req, res) => {
  const status = req?.query?.status;
  const type = req?.query?.type;
  const startDate = req?.query?.startDate;
  const endDate = req?.query?.endDate;
  const searchQuery = req?.query?.searchQuery?.trim();
  const queryParameter = req?.query?.queryParameter;

  const page = Math.max(1, parseInt(req?.query?.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req?.query?.limit) || 10));
  const skip = (page - 1) * limit;

  const filter = {};
  const searchFilter = {};
  const countFilter = {};

  filter.abondonedOrder = false;
  countFilter.abondonedOrder = false;

  if (status && status !== "all") filter.status = status;

  if (type && type !== "all") {
    switch (type) {
      case "pos":
        filter.type = "Pos";
        break;
      case "web":
        filter.type = "Regular";
        filter.isAppOrder = false;
        break;
      case "app":
        filter.type = "Regular";
        filter.isAppOrder = true;
        break;
      case "abandoned":
        filter.abondonedOrder = true;
        break;
    }
  }

  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00+05:30`);
    const end = new Date(`${endDate}T23:59:59.999+05:30`);
    filter.createdAt = { $gte: start, $lte: end };
    countFilter.createdAt = { $gte: start, $lte: end };
  }

  if (searchQuery && queryParameter === "customer") {
    const regex = new RegExp(searchQuery, "i");
    searchFilter.$or = [
      { name: regex },
      { email: regex },
      { phoneNo: regex }
    ];
    delete filter['createdAt'];
  } else if (searchQuery && queryParameter === "order") {
    searchFilter.orderId = new RegExp(`^${searchQuery}`, "i");
    delete filter['createdAt'];
  } else if (searchQuery) {
    const regex = new RegExp(searchQuery, "i");
    searchFilter.$or = [
      { orderId: new RegExp(`^${searchQuery}`, "i") },
      { name: regex },
      { email: regex },
      { phoneNo: regex }
    ];
    delete filter['createdAt'];
  }

  const [
    totalCount,
    newCount, acceptedCount, rejectedCount, holdCount, shippedCount, cancelledCount, deliveredCount,
    allOrderCount, posOrderCount, websiteOrderCount, appOrderCount, abandonedOrderCount
  ] = await Promise.all([
    Order.countDocuments(filter),
    Order.countDocuments({ ...filter, status: "New" }),
    Order.countDocuments({ ...filter, status: "Accepted" }),
    Order.countDocuments({ ...filter, status: "Rejected" }),
    Order.countDocuments({ ...filter, status: "Hold" }),
    Order.countDocuments({ ...filter, status: "Shipped" }),
    Order.countDocuments({ ...filter, status: "Cancelled" }),
    Order.countDocuments({ ...filter, status: "Delivered" }),
    Order.countDocuments(countFilter),
    Order.countDocuments({ ...countFilter, type: "Pos" }),
    Order.countDocuments({ ...countFilter, type: "Regular", isAppOrder: false }),
    Order.countDocuments({ ...countFilter, type: "Regular", isAppOrder: true }),
    Order.countDocuments({ ...countFilter, abondonedOrder: true }),
  ]);

  const totalPages = Math.ceil(totalCount / limit);

  const orders = await Order.find({ ...filter, ...searchFilter })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate({
      path: "userId",
      model: "User",
      select: "name email phoneNo orders",
      populate: {
        path: "orders",
        model: "Order",
        select: "_id status"
      }
    })
    .populate({
      path: "partialReturnRequests",
      model: "PartialRequest",
      select: "_id status isRaised raisedAt isResolved resolvedAt reason"
    })
    .populate({
      path: "items.productId",
      model: "Product",
      select: "fullName",
      // populate: {
      //   path: "partialReturnRequests",
      //   model: "PartialRequest",
      //   select: "_id status"
      // }
    })
    .populate({
      path: "coupon",
      model: "Coupon",
      select: "code type value percent"
    })
    .populate({
      path: "callAttempts.history.employeeId",
      model: "User",
      select: "name email role"
    })
    .lean();

  return res.status(200).json(
    new ApiResponse(200, {
      orders,
      totalCount,
      newCount, acceptedCount, rejectedCount, holdCount,
      shippedCount, cancelledCount, deliveredCount,
      allOrderCount, posOrderCount, websiteOrderCount,
      appOrderCount, abandonedOrderCount,
      pagination: {
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    }, "Orders fetched successfully")
  );
});

export const getPaginatedBrands = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;

  const parsedPage = Math.max(1, parseInt(page));
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (parsedPage - 1) * parsedLimit;

  //   const filter = { active: true };
  const filter = {};

  const [brands, totalCount] = await Promise.all([
    Brand.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .lean(),
    Brand.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalCount / parsedLimit);

  return res.status(200).json(
    new ApiResponse(200, {
      brands,
      totalCount,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        totalPages,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1,
      },
    }, "Brands fetched successfully")
  );
});

export const getPaginatedProducts = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    filterBy,
    category,
    group,
    type,
    startDate,
    endDate,
  } = req.query;
  const searchQuery = req?.query?.searchQuery?.trim();

  const parsedPage = Math.max(1, parseInt(page));
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (parsedPage - 1) * parsedLimit;

  const filter = {};

  // Filter by active
  if (filterBy !== undefined) {
    switch (filterBy) {
      case "Active":
        filter.active = true;
        break;

      case "Inactive":
        filter.active = false;
        break;

      case "InStock":
        filter.totalStock = { $gt: 0 }; // Changed from $gte: 1 for clarity
        break;

      case "OutOfStock":
        filter.totalStock = { $lte: 0 };
        break;

      case "zero":
        filter.totalStock = { $eq: 0 }; // More robust than just 0
        break;
    }
  }

  // Filter by category
  if (category) {
    filter.category = category;
  }

  // Filter by group
  if (group) {
    filter.groups = { $in: group };
  }

  // Filter by date range
  if (startDate && endDate) {
    filter.createdAt = {
      $gte: new Date(`${startDate}T00:00:00+05:30`),
      $lte: new Date(`${endDate}T23:59:59.999+05:30`),
    };
  }

  if (searchQuery) {
    // ✅ Tokenize query and build regex for each word
    const words = searchQuery.split(/\s+/).filter(Boolean);
    const regexArray = words.map(word => new RegExp(word, "i"));

    filter.$or = [
      { $and: regexArray.map(r => ({ name: r })) },
      { $and: regexArray.map(r => ({ fullName: r })) }
    ];

    delete filter['createdAt'];
  }

  // TYPE: fast, slow, non
  if (type) {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    let productIds = [];

    if (type === "fast") {
      // Products ordered 2+ times in last 1 week
      const fastProducts = await Order.aggregate([
        { $match: { createdAt: { $gte: oneWeekAgo } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            count: { $sum: 1 }
          }
        },
        { $match: { count: { $gte: 2 } } },
        { $project: { _id: 1 } }
      ]);
      productIds = fastProducts.map(p => p._id);

    } else if (type === "slow") {
      // Products ordered 1+ times in last 1 month, but 0 in last 1 week
      const monthProducts = await Order.aggregate([
        { $match: { createdAt: { $gte: oneMonthAgo } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            count: { $sum: 1 }
          }
        }
      ]);

      const weekProducts = await Order.aggregate([
        { $match: { createdAt: { $gte: oneWeekAgo } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId"
          }
        }
      ]);

      const weekProductIds = new Set(weekProducts.map(p => String(p._id)));

      productIds = monthProducts
        .filter(p => !weekProductIds.has(String(p._id)))
        .map(p => p._id);

    } else if (type === "non") {
      // Products not ordered in last 1 month
      const recentProducts = await Order.aggregate([
        { $match: { createdAt: { $gte: oneMonthAgo } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.productId" } }
      ]);

      const recentProductIds = new Set(recentProducts.map(p => String(p._id)));

      const allOrderedProducts = await Order.aggregate([
        { $unwind: "$items" },
        { $group: { _id: "$items.productId" } }
      ]);

      productIds = allOrderedProducts
        .filter(p => !recentProductIds.has(String(p._id)))
        .map(p => p._id);
    }

    // Apply product ID filter
    filter._id = { $in: productIds };
  }

  const [products, totalCount] = await Promise.all([
    Product.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      // .populate("category", "name slug")
      // .populate("orders stock groups category")
      .populate("stock category variants")
      .populate({
        path: "category",
        model: "SubCategory",
        select: "name _id"
      })
      .select("-orders -stock")
      .lean(),

    Product.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalCount / parsedLimit);

  return res.status(200).json(
    new ApiResponse(200, {
      products,
      totalCount,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        totalPages,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1,
      },
    }, "Products fetched successfully")
  );
});

export const getPaginatedProductsForAdmin = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    filterBy,
    category,
    group,
    type,
    startDate,
    endDate,
  } = req.query;
  const searchQuery = req?.query?.searchQuery?.trim();

  const parsedPage = Math.max(1, parseInt(page));
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (parsedPage - 1) * parsedLimit;

  const filter = {};

  // Filter by active
  if (filterBy !== undefined) {
    switch (filterBy) {
      case "Active":
        filter.active = true;
        break;

      case "Inactive":
        filter.active = false;
        break;

      case "InStock":
        filter.totalStock = { $gt: 0 }; // Changed from $gte: 1 for clarity
        break;

      case "OutOfStock":
        filter.totalStock = { $lte: 0 };
        break;

      case "zero":
        filter.totalStock = { $eq: 0 }; // More robust than just 0
        break;
    }
  }

  // Filter by category
  if (category) {
    filter.category = category;
  }

  // Filter by group
  if (group) {
    filter.groups = { $in: group };
  }

  // Filter by date range
  if (startDate && endDate) {
    filter.createdAt = {
      $gte: new Date(`${startDate}T00:00:00+05:30`),
      $lte: new Date(`${endDate}T23:59:59.999+05:30`),
    };
  }

  if (searchQuery) {
    // ✅ Tokenize query and build regex for each word
    const words = searchQuery.split(/\s+/).filter(Boolean);
    const regexArray = words.map(word => new RegExp(word, "i"));

    filter.$or = [
      { $and: regexArray.map(r => ({ name: r })) },
      { $and: regexArray.map(r => ({ fullName: r })) }
    ];
    delete filter['createdAt'];
  }

  // TYPE: fast, slow, non
  if (type) {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    let productIds = [];

    if (type === "fast") {
      // Products ordered 2+ times in last 1 week
      const fastProducts = await Order.aggregate([
        { $match: { createdAt: { $gte: oneWeekAgo } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            count: { $sum: 1 }
          }
        },
        { $match: { count: { $gte: 2 } } },
        { $project: { _id: 1 } }
      ]);
      productIds = fastProducts.map(p => p._id);

    } else if (type === "slow") {
      // Products ordered 1+ times in last 1 month, but 0 in last 1 week
      const monthProducts = await Order.aggregate([
        { $match: { createdAt: { $gte: oneMonthAgo } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            count: { $sum: 1 }
          }
        }
      ]);

      const weekProducts = await Order.aggregate([
        { $match: { createdAt: { $gte: oneWeekAgo } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId"
          }
        }
      ]);

      const weekProductIds = new Set(weekProducts.map(p => String(p._id)));

      productIds = monthProducts
        .filter(p => !weekProductIds.has(String(p._id)))
        .map(p => p._id);

    } else if (type === "non") {
      // Products not ordered in last 1 month
      const recentProducts = await Order.aggregate([
        { $match: { createdAt: { $gte: oneMonthAgo } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.productId" } }
      ]);

      const recentProductIds = new Set(recentProducts.map(p => String(p._id)));

      const allOrderedProducts = await Order.aggregate([
        { $unwind: "$items" },
        { $group: { _id: "$items.productId" } }
      ]);

      productIds = allOrderedProducts
        .filter(p => !recentProductIds.has(String(p._id)))
        .map(p => p._id);
    }

    // Apply product ID filter
    filter._id = { $in: productIds };
  }

  const [products, totalCount] = await Promise.all([
    Product.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      // .populate("category", "name slug")
      // .populate("orders stock groups category")
      .populate("stock category variants")
      .populate({
        path: "category",
        model: "SubCategory",
        select: "name _id"
      })
      .select("-orders")
      .lean(),

    Product.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalCount / parsedLimit);

  return res.status(200).json(
    new ApiResponse(200, {
      products,
      totalCount,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        totalPages,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1,
      },
    }, "Products fetched successfully")
  );
});

export const getPaginatedUsers = asyncHandler(async (req, res) => {
  const { role, startDate, endDate, type } = req.query;
  const searchQuery = req?.query?.searchQuery?.trim();

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  const filter = {};

  if (role && role !== "all") {
    filter.role = role;
  }

  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00+05:30`);
    const end = new Date(`${endDate}T23:59:59.999+05:30`);
    filter.createdAt = { $gte: start, $lte: end };
  }

  if (searchQuery) {
    const regex = new RegExp(searchQuery, "i");
    filter.$or = [
      { name: regex },
      { email: regex },
      { phoneNo: regex }
    ];
    delete filter['createdAt'];
  }

  /* ========== Special TYPE Filtering (Frequent / OneOrder / NoOrder) ========== */
  let userIdsToIncludeOrExclude = [];

  if (type === "frequent") {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const frequentUsers = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: oneWeekAgo },
        }
      },
      {
        $group: {
          _id: "$userId",
          orderCount: { $sum: 1 }
        }
      },
      {
        $match: {
          orderCount: { $gte: 2 }
        }
      }
    ]);

    userIdsToIncludeOrExclude = frequentUsers.map(u => u._id);
    filter._id = { $in: userIdsToIncludeOrExclude };

  } else if (type === "oneOrder") {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    const oneOrderUsers = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: twoMonthsAgo }
        }
      },
      {
        $group: {
          _id: "$userId",
          orderCount: { $sum: 1 }
        }
      },
      {
        $match: {
          orderCount: 1
        }
      }
    ]);

    userIdsToIncludeOrExclude = oneOrderUsers.map(u => u._id);
    filter._id = { $in: userIdsToIncludeOrExclude };

  } else if (type === "noOrder") {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    // Find users with orders
    const usersWithOrders = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: twoMonthsAgo }
        }
      },
      {
        $group: {
          _id: "$userId"
        }
      }
    ]);

    const usersWithOrdersIds = usersWithOrders.map(u => u._id);
    filter._id = { $nin: usersWithOrdersIds };
  }

  /* ========== Fetch Users with Pagination ========== */
  const [users, totalCount] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("-password -refreshToken")
      .lean(),
    User.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalCount / limit);

  return res.status(200).json(
    new ApiResponse(200, {
      users,
      totalCount,
      pagination: {
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    }, "Users fetched successfully")
  );
});

export const getPaginatedQueries = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    isResolved,
    startDate,
    endDate,
  } = req.query;
  const searchQuery = req?.query?.searchQuery?.trim();

  const parsedPage = Math.max(1, parseInt(page));
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (parsedPage - 1) * parsedLimit;

  const filter = {};

  // Filter by active
  if (isResolved !== undefined) {
    filter.isResolved = isResolved === 'true' || isResolved === true;
  }

  // Filter by date range
  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00+05:30`);
    const end = new Date(`${endDate}T23:59:59.999+05:30`);
    filter.createdAt = {
      $gte: start,
      $lte: end,
    };
  }

  if (searchQuery) {
    delete filter['createdAt'];
    const words = searchQuery.split(/\s+/).filter(Boolean);
    const regexArray = words.map(word => new RegExp(word, "i"));

    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: "orders",
          localField: "orderId",
          foreignField: "_id",
          as: "orderData"
        }
      },
      {
        $match: {
          $or: [
            { $and: regexArray.map(r => ({ title: r })) },
            { $and: regexArray.map(r => ({ description: r })) },
            { $and: regexArray.map(r => ({ desciption: r })) },
            { $and: regexArray.map(r => ({ "orderData.orderId": r })) }
          ]
        }
      }
    ];

    const [queries, countResult] = await Promise.all([
      Query.aggregate([
        ...pipeline,
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: parsedLimit },
        {
          $lookup: {
            from: "users",
            localField: "raisedBy",
            foreignField: "_id",
            as: "raisedBy"
          }
        },
        { $unwind: { path: "$raisedBy", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            title: 1,
            raisedAt: 1,
            createdAt: 1,
            isResolved: 1,
            rating: 1,
            "raisedBy._id": 1,
            "raisedBy.name": 1,
            "raisedBy.email": 1,
            "raisedBy.phone": 1,
            "raisedBy.role": 1
          }
        }
      ]),
      Query.aggregate([...pipeline, { $count: "count" }])
    ]);

    const totalCount = countResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / parsedLimit);

    return res.status(200).json(
      new ApiResponse(200, {
        queries,
        totalCount,
        pagination: {
          page: parsedPage,
          limit: parsedLimit,
          totalPages,
          hasNextPage: parsedPage < totalPages,
          hasPrevPage: parsedPage > 1,
        },
      }, "Queries fetched successfully")
    );
  }

  const [queries, totalCount] = await Promise.all([
    Query.find(filter)
      .select("title raisedBy raisedAt createdAt isResolved rating")
      .populate("raisedBy", "name email phone role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .lean(),

    Query.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalCount / parsedLimit);

  return res.status(200).json(
    new ApiResponse(200, {
      queries,
      totalCount,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        totalPages,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1,
      },
    }, "Queries fetched successfully")
  );
});

export const getPaginatedCoupons = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    startDate,
    endDate,
  } = req.query;

  const searchQuery = req?.query?.searchQuery?.trim();

  const parsedPage = Math.max(1, parseInt(page));
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (parsedPage - 1) * parsedLimit;

  const filter = {};

  // Date range filter
  if (startDate && endDate) {
    filter.createdAt = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  // Search filter (code only, you can add more fields)
  if (searchQuery) {
    const regex = new RegExp(searchQuery, "i");
    filter.$or = [
      { code: regex }
    ];
    delete filter['createdAt'];
  }

  const [coupons, totalCount] = await Promise.all([
    Coupon.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .lean(),
    Coupon.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalCount / parsedLimit);

  return res.status(200).json(
    new ApiResponse(200, {
      coupons,
      totalCount,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        totalPages,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1,
      },
    }, "Coupons fetched successfully")
  );
});