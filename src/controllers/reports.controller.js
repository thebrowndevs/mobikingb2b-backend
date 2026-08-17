// controllers/dashboard.controller.js

import mongoose from "mongoose";
import { Order } from "../models/order.model.js";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Stock } from "../models/stock.model.js";
import { Product } from "../models/product.model.js";
import { Category } from "../models/category.model.js";
import { SubCategory } from "../models/sub_category.model.js";
import { Group } from "../models/group.model.js";
import { Brand } from "../models/brand.model.js";
import { Payment } from "../models/payment.model.js";

// Selective fields for reporting to prevent server crashes on large data
const REPORT_POPULATE_CONFIG = {
  User: "name phoneNo email fullName",
  Product: "name fullName sku price",
  Category: "name",
  SubCategory: "name",
  Brand: "name",
  Group: "name",
  Order: "orderId",
  Coupon: "couponCode discount",
  Address: "city state address pincode",
  Variant: "name totalStock availableStock",
  Query: "isResolved",
};

// function getDateRangeArray(days) {
//   const dates = [];
//   const today = new Date();
//   for (let i = days - 1; i >= 0; i--) {
//     const d = new Date(today);
//     d.setDate(today.getDate() - i);
//     dates.push(d.toISOString().split("T")[0]); // 'YYYY-MM-DD'
//   }
//   return dates;
// }

const generateDateRangeArray = (startDate, endDate) => {
  const dates = [];

  console.log(startDate, endDate)
  const current = new Date(Date.UTC(
    new Date(startDate).getUTCFullYear(),
    new Date(startDate).getUTCMonth(),
    new Date(startDate).getUTCDate()
  ));

  const end = new Date(Date.UTC(
    new Date(endDate).getUTCFullYear(),
    new Date(endDate).getUTCMonth(),
    new Date(endDate).getUTCDate()
  ));

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10)); // YYYY-MM-DD
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
};

// 1. Total Customers
export const getTotalCustomers = async (req, res) => {
  try {
    const totalCustomers = await User.countDocuments({ role: "user" });
    return res.status(200).json(
      new ApiResponse(200, { totalCustomers }, "Total customers fetched")
    );
  } catch (err) {
    console.error("Error fetching customers:", err);
    return res.status(500).json(new ApiError(500, "Internal server error"));
  }
};

// 2. Total Orders
export const getTotalOrders = async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    return res.status(200).json(new ApiResponse(200, { totalOrders }, "Total orders fetched"));
  } catch (err) {
    console.error("Error fetching orders:", err);
    return res.status(500).json(new ApiError(500, "Internal server error"));
  }
};

// 3. Total Sales
export const getTotalSales = async (req, res) => {
  try {
    const agg = await Order.aggregate([
      {
        $match: {
          abondonedOrder: false,
          status: {
            $nin: ["Rejected", "Cancelled", "Returned", "Replaced", "Hold"]
          }
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$orderAmount" }
        }
      }
    ]);

    const totalSales = agg[0]?.totalSales || 0;
    return res.status(200).json(new ApiResponse(200, { totalSales }, "Total sales fetched"));
  } catch (err) {
    console.error("Error fetching total sales:", err);
    return res.status(500).json(new ApiError(500, "Internal server error"));
  }
};

// 4. Sales in Date Range
export const getSalesInRange = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) throw new ApiError(400, "Start and end date required");

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const agg = await Order.aggregate([
      {
        $match: {
          abondonedOrder: false,
          status: {
            $nin: ["Rejected", "Cancelled", "Returned", "Replaced", "Hold"]
          },
          createdAt: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          salesInRange: { $sum: "$orderAmount" }
        }
      }
    ]);

    const salesInRange = agg[0]?.salesInRange || 0;
    return res.status(200).json(new ApiResponse(200, { salesInRange }, "Sales in range fetched"));
  } catch (err) {
    console.error("Error fetching sales in range:", err);
    return res.status(err.statusCode || 500).json(new ApiError(err.statusCode || 500, err.message));
  }
};

export const getDailyOrderCounts = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Start and end date are required");
  }

  const from = new Date(startDate);
  const to = new Date(new Date(endDate).setHours(23, 59, 59, 999));

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new ApiError(400, "Invalid date format");
  }

  const days = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

  const agg = await Order.aggregate([
    {
      $match: {
        createdAt: { $gte: from, $lte: to },
        abondonedOrder: false,
        status: { $nin: ["Rejected", "Cancelled", "Returned", "Replaced", "Hold"] }
      }
    },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        },
        count: { $sum: 1 }
      }
    }
  ]);

  // Map aggregation result to daily count object
  const countMap = {};
  agg.forEach(entry => {
    countMap[entry._id.day] = entry.count;
  });

  // Step 3: Generate complete date range
  const dates = generateDateRangeArray(startDate, endDate);
  const dailyCounts = dates.map(date => countMap[date] || 0);

  return res.status(200).json(
    new ApiResponse(200, { dates, dailyCounts }, "Daily order counts")
  );
});

export const getDailyOrderSourceCounts = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Start and end date are required");
  }

  const from = new Date(startDate);
  const to = new Date(new Date(endDate).setHours(23, 59, 59, 999));
  const days = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

  const agg = await Order.aggregate([
    {
      $match: {
        createdAt: { $gte: from, $lte: to },
        abondonedOrder: false,
        status: { $nin: ["Rejected", "Cancelled", "Returned", "Replaced", "Hold"] }
      }
    },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          type: "$type",
          isAppOrder: "$isAppOrder"
        },
        count: { $sum: 1 }
      }
    }
  ]);

  // Map to { [day]: { app: 0, website: 0, pos: 0 } }
  const dataMap = {};
  for (const { _id, count } of agg) {
    const day = _id.day;
    if (!dataMap[day]) {
      dataMap[day] = { app: 0, website: 0, pos: 0 };
    }

    if (_id.type === "Regular" && _id.isAppOrder === true) dataMap[day].app += count;
    if (_id.type === "Regular" && _id.isAppOrder === false) dataMap[day].website += count;
    if (_id.type === "Pos") dataMap[day].pos += count;
  }

  // Fill missing days
  // const dates = getDateRangeArray(days);
  const dates = generateDateRangeArray(startDate, endDate);
  const appOrders = [];
  const websiteOrders = [];
  const posOrders = [];

  for (const date of dates) {
    const row = dataMap[date] || { app: 0, website: 0, pos: 0 };
    appOrders.push(row.app);
    websiteOrders.push(row.website);
    posOrders.push(row.pos);
  }

  // for (const date of dates) {
  //   const row = dataMap[date] || { app: 0, website: 0, pos: 0 };
  //   appOrders.push(row.app);
  //   websiteOrders.push(row.website);
  //   posOrders.push(row.pos);
  // }

  return res.status(200).json(
    new ApiResponse(200, { dates, appOrders, websiteOrders, posOrders }, "Order source counts by day")
  );
});

export const getDailyCustomerSignupCounts = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Start and end date are required");
  }

  const from = new Date(startDate);
  const to = new Date(new Date(endDate).setHours(23, 59, 59, 999));

  const agg = await User.aggregate([
    {
      $match: {
        createdAt: { $gte: from, $lte: to },
        role: "user"
      }
    },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        },
        count: { $sum: 1 }
      }
    }
  ]);

  // Convert aggregation result to a map
  const countMap = {};
  for (const entry of agg) {
    countMap[entry._id.day] = entry.count;
  }

  // Generate full range of dates between from and to
  const dates = generateDateRangeArray(from, to);

  // Fill counts with either value or 0
  const customerCounts = dates.map(date => countMap[date] || 0);

  return res.status(200).json(
    new ApiResponse(200, { dates, customerCounts }, "Daily customer signup counts")
  );
});

export const getDailySalesInRange = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    throw new ApiError(400, "Start and end date required");
  }

  const from = new Date(startDate);
  const to = new Date(new Date(endDate).setHours(23, 59, 59, 999));
  const days = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

  // Step 1: Aggregate sales by day
  const agg = await Order.aggregate([
    {
      $match: {
        abondonedOrder: false,
        status: {
          $nin: ["Rejected", "Cancelled", "Returned", "Replaced", "Hold"]
        },
        createdAt: { $gte: from, $lte: to }
      }
    },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        },
        total: { $sum: "$orderAmount" }
      }
    }
  ]);

  // // Step 2: Map data to date → sales
  // const salesMap = {};
  // for (const { _id, total } of agg) {
  //   salesMap[_id.day] = total;
  // }

  // // Step 3: Generate ordered date array and fill values
  // const dates = getDateRangeArray(days);
  // const salesCounts = dates.map(date => salesMap[date] || 0);

  // Step 2: Map data to date → sales
  const salesMap = {};
  for (const { _id, total } of agg) {
    salesMap[_id.day] = total;
  }

  // Step 3: Generate full range of dates and map to sales
  const dates = generateDateRangeArray(startDate, endDate);
  const salesCounts = dates.map(date => salesMap[date] || 0);

  return res.status(200).json(
    new ApiResponse(200, { dates, salesCounts }, "Daily sales data fetched")
  );
});

/**
 * @route   POST /api/v1/universal/columns
 * @body    { model: "ModelName", columns: ["field1", "field2"] }
 */
export const fetchModelColumns = asyncHandler(async (req, res) => {
  const {
    model, columns,
    startDate, endDate,
    dateField = "createdAt", // Default to createdAt, but allow shippedAt for labels
    status, paymentStatus, method, type, //Order Based Filters
    filterBy, category, group, brandIds //Product Based Filters
  } = req.body;

  if (!model || !Array.isArray(columns) || columns.length === 0) {
    throw new ApiError(400, "Model name and columns array are required");
  }

  // Get the model dynamically from mongoose
  const Model = mongoose.models[model];
  if (!Model) {
    throw new ApiError(404, `Model '${model}' not found`);
  }

  // Detect reference fields to populate
  const schemaPaths = Model.schema.paths;
  const populateFields = [];
  for (const col of columns) {
    let lookupCol = col;
    if (model === "User" && ["businessActive", "businessVerified", "businessApproved", "gstVerified", "businessName", "businessEmail", "businessPhone", "gstNumber", "businessAddress", "businessStatus", "rejectionReason", "approvedAt", "rejectedAt", "approvedBy", "rejectedBy"].includes(col)) {
      lookupCol = "business";
    }
    const path = schemaPaths[lookupCol];
    if (!path) {
      console.warn(`⚠️ Column '${col}' not found in schema of model '${model}'`);
      continue;
    }

    const ref = path.options?.ref || path.embeddedSchemaType?.options?.ref || path.caster?.options?.ref || (path.options?.type && Array.isArray(path.options.type) && path.options.type[0]?.ref);

    if (ref) {
      populateFields.push({ path: lookupCol, ref });
    }
  }

  console.log("Model:", model, "Columns:", columns, "Detected Populate Fields:", populateFields);

  // Build projection


  // Build filter (createdAt only)
  let filter = {};

  // console.log(Model)

  //Order Model filter
  if (model == "Order") {
    if (status && status.length) filter.status = { $in: status };
    // console.log(filter)
    if (paymentStatus && paymentStatus.length) filter.paymentStatus = { $in: paymentStatus };
    if (method && method.length) filter.method = { $in: method };
    // console.log("columns:",columns)
    if (columns.includes("gst")) {
      console.log("gst:", columns)
      filter.gst = { $exists: true, $ne: null, $ne: "" }
    }
    if (columns.includes("discount") && !columns.includes("coupon") && !columns.includes("couponCode") && !columns.includes("couponType")) {
      filter.discount = { $gt: 0 };
    }
    if (columns.includes("coupon") || columns.includes("couponCode") || columns.includes("couponType")) {
      filter.couponCode = { $exists: true, $ne: "" }
      if (!columns.includes("discount")) {
        columns.push("discount")
      }
    }
    if (type && type !== "all") {
      switch (type) {
        case "pos":
          filter.type = "Pos";
          filter.abondonedOrder = false;
          break;
        case "web":
          filter.type = "Regular";
          filter.isAppOrder = false;
          filter.abondonedOrder = false;
          break;
        case "app":
          filter.type = "Regular";
          filter.isAppOrder = true;
          filter.abondonedOrder = false;
          break;
        case "web&pos":
          filter.isAppOrder = false;
          filter.abondonedOrder = false;
          break;
        case "app&pos":
          filter = {
            $or: [
              { type: "Pos" },                              // All POS orders
              { type: "Regular", isAppOrder: true, abondonedOrder: false }         // Only Regular orders that are app
            ]
          };
          break;
        case "regular":
          filter.type = "Regular";
          filter.abondonedOrder = false;
          break;
        case "abandoned":
          filter.abondonedOrder = true;
          break;
      }
    }
  }

  //Product Model filter
  if (model == "Product") {
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
      filter.category = { $in: category };
    }

    if (brandIds) {
      // Ensure it's always an array
      if (!Array.isArray(brandIds)) {
        brandIds = [brandIds];
      }

      filter.brand = { $in: brandIds.map(id => new mongoose.Types.ObjectId(id)) }

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
    }

    // Filter by group
    if (group) {
      filter.groups = { $in: group };
    }
  }

  if (model == "User") {

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
  }

  // Apply createdAt filter ONLY for Order, User, Product to keep metadata (Brand/Category) visible
  const modelsWithDateFilter = ["Order", "User", "Product"];
  if (startDate && endDate && modelsWithDateFilter.includes(model)) {
    const start = new Date(`${startDate}T00:00:00+05:30`);
    const end = new Date(`${endDate}T23:59:59.999+05:30`);
    filter[dateField] = { $gte: start, $lte: end };
  }

  let activeColumns = [...columns];
  let loadPayments = false;
  if (model === "Order" && columns.includes("payments")) {
    loadPayments = true;
    activeColumns = activeColumns.filter(c => c !== "payments");
  }

  // Map virtual fields to actual schema fields for query projection
  activeColumns = activeColumns.map(col => {
    if (model === "User" && ["businessActive", "businessVerified", "businessApproved", "gstVerified", "businessName", "businessEmail", "businessPhone", "gstNumber", "businessAddress", "businessStatus", "rejectionReason", "approvedAt", "rejectedAt", "approvedBy", "rejectedBy"].includes(col)) {
      return "business";
    }
    return col;
  });

  const projection = activeColumns.join(" ");
  // Build query
  let query = Model.find(filter, projection).lean();

  if (model === "User" && (columns.includes("approvedBy") || columns.includes("rejectedBy"))) {
    const pathsToPopulate = [];
    if (columns.includes("approvedBy")) pathsToPopulate.push({ path: "business.approvedBy", select: "name email phoneNo fullName" });
    if (columns.includes("rejectedBy")) pathsToPopulate.push({ path: "business.rejectedBy", select: "name email phoneNo fullName" });
    query = query.populate(pathsToPopulate);
  }

  if (model === "Order" && activeColumns.includes("items")) {
    query = query.populate({
      path: "items.productId",
      select: "fullName name sku price"
    });
  }
  for (const field of populateFields) {

    switch (model) {
      case "Order":
        if (field.ref === "User") continue;
        break;

      case "User":
      case "Product":
        if (field.ref === "Order") continue;
        break;

      case "SubCategory":
      case "Group":
        if (field.ref === "Product") continue;
        break;

      case "Category":
        if (field.ref === "SubCategory") continue;
        break;

      default:
        break;
    }

    const selectFields = REPORT_POPULATE_CONFIG[field.ref] || "name fullName orderId sku";
    query = query.populate({ path: field.path, select: selectFields });
  }

  let data = await query.exec();

  if (loadPayments && data.length > 0) {
    const orderIds = data.map(o => o._id);
    const payments = await Payment.find({ orderRef: { $in: orderIds } }).lean();
    data = data.map(order => {
      order.payments = payments.filter(p => String(p.orderRef) === String(order._id));
      return order;
    });
  }

  return res
    .status(200)
    .json(new ApiResponse(200, data, `${model} columns fetched successfully`));
});

// export const fetchModelColumns = asyncHandler(async (req, res) => {
//   const { model, columns } = req.body;

//   if (!model || !Array.isArray(columns) || columns.length === 0) {
//     throw new ApiError(400, "Model name and columns array are required");
//   }

//   // Get the model dynamically from mongoose
//   const Model = mongoose.models[model];
//   if (!Model) {
//     throw new ApiError(404, `Model '${model}' not found`);
//   }

//   // Detect reference fields to populate
//   const schemaPaths = Model.schema.paths;
//   const populateFields = [];

//   for (const col of columns) {
//     const path = schemaPaths[col];
//     if (!path) {
//       console.warn(`⚠️ Column '${col}' not found in schema of model '${model}'`);
//       continue;
//     }

//     // console.log(path)
//     // Check if the field is an ObjectId with a ref
//     if (
//       path.instance === "ObjectId" &&
//       path.options &&
//       typeof path.options.ref === "string"
//     ) {
//       populateFields.push(col);
//     }
//   }

//   // Build projection: "field1 field2"
//   const projection = columns.join(" ");

//   // Build query
//   let query = Model.find({}, projection);
//   for (const field of populateFields) {
//     query = query.populate(field);
//   }

//   // const data = await query.limit(100).exec(); // optional limit
//   const data = await query.exec(); // optional limit

//   return res
//     .json(new ApiResponse(200, data, `${model} columns fetched successfully`));
// });

/*
export const getProductSalesReport = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.body;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Start date and end date are required");
  }

  // 0. Parse dates in IST (UTC+5:30)
  const start = new Date(`${startDate}T00:00:00+05:30`);
  const end = new Date(`${endDate}T23:59:59.999+05:30`);

  // 1. Fetch Aggregated Purchase Sets (Stock-In)
  const purchaseSets = await Stock.aggregate([
    {
      $match: {
        type: "stock-in",
        createdAt: { $gte: start, $lte: end },
        productId: { $ne: null },
        quantity: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: { productId: "$productId", price: { $ifNull: ["$purchasePrice", 0] } },
        totalQty: { $sum: "$quantity" },
        totalVal: { $sum: { $multiply: ["$quantity", { $ifNull: ["$purchasePrice", 0] }] } }
      }
    },
    {
      $project: {
        productId: "$_id.productId",
        type: "Purchase Set",
        unitPrice: "$_id.price",
        quantity: "$totalQty",
        totalValue: "$totalVal"
      }
    }
  ]);

  // 2. Fetch Aggregated Sales Sets (Orders)
  const salesSets = await Order.aggregate([
    {
      $match: {
        createdAt: { $gte: start, $lte: end },
        status: "Delivered",
        abondonedOrder: false
      }
    },
    { $unwind: "$items" },
    {
      $match: {
        "items.productId": { $ne: null },
        "items.quantity": { $gt: 0 }
      }
    },
    {
      $group: {
        _id: { productId: "$items.productId", price: "$items.price" },
        totalQty: { $sum: "$items.quantity" },
        totalVal: { $sum: { $multiply: ["$items.quantity", "$items.price"] } }
      }
    },
    {
      $project: {
        productId: "$_id.productId",
        type: "Sale Set",
        unitPrice: "$_id.price",
        quantity: "$totalQty",
        totalValue: "$totalVal"
      }
    }
  ]);

  // 3. Union and Enrich with Product Details (Bulk Fetching Fix for Performance)
  const combinedSets = [...purchaseSets, ...salesSets];
  const productIds = Array.from(new Set(combinedSets.map(set => String(set.productId))));

  // Fetch all relevant products in ONE query
  const products = await Product.find({ _id: { $in: productIds } })
    .populate("brand", "name")
    .populate("groups", "name")
    .lean();

  // 4. Fetch Last Purchase Price for each product (Irrespective of Date)
  const lastPurchasePrices = await Stock.aggregate([
    {
      $match: {
        type: "stock-in",
        productId: { $in: productIds.map(id => new mongoose.Types.ObjectId(id)) }
      }
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$productId",
        lastPrice: { $first: { $ifNull: ["$purchasePrice", 0] } }
      }
    }
  ]);

  const productMap = new Map(products.map(p => [String(p._id), p]));
  const lastPriceMap = new Map(lastPurchasePrices.map(lp => [String(lp._id), lp.lastPrice]));

  const enrichedData = combinedSets.map(set => {
    const product = productMap.get(String(set.productId));
    const isSaleSet = set.type === "Sale Set";
    const lastPurchasePrice = isSaleSet ? (lastPriceMap.get(String(set.productId)) || 0) : "";

    return {
      productName: product?.fullName || product?.name || "Unknown Product",
      sku: product?.sku || "N/A",
      group: product?.brand?.name || product?.groups?.[0]?.name || "N/A",
      setType: set.type,
      unitPrice: set.unitPrice,
      quantity: set.quantity,
      totalValue: set.totalValue,
      lastPurchasePrice
    };
  });

  // Sort by product name for grouping sets together in Excel
  enrichedData.sort((a, b) => a.productName.localeCompare(b.productName));

  return res
    .status(200)
    .json(new ApiResponse(200, enrichedData, "Product sets report fetched successfully"));
});
*/

export const getProductSalesReport = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.body;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Start date and end date are required");
  }

  // 0. Parse dates in IST (UTC+5:30)
  const start = new Date(`${startDate}T00:00:00+05:30`);
  const end = new Date(`${endDate}T23:59:59.999+05:30`);

  // 1. Fetch Aggregated Purchase Sets (Stock-In)
  const purchaseSets = await Stock.aggregate([
    {
      $match: {
        type: "stock-in",
        createdAt: { $gte: start, $lte: end },
        productId: { $ne: null },
        quantity: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: { productId: "$productId", price: { $ifNull: ["$purchasePrice", 0] } },
        totalQty: { $sum: "$quantity" },
        totalVal: { $sum: { $multiply: ["$quantity", { $ifNull: ["$purchasePrice", 0] }] } }
      }
    },
    {
      $project: {
        productId: "$_id.productId",
        type: { $literal: "Purchase Set" },
        unitPrice: { $literal: 0 },
        purchasePrice: "$_id.price",
        quantity: "$totalQty",
        totalValue: { $literal: 0 },
        totalCost: "$totalVal"
      }
    }
  ]);

  // 2. Fetch Aggregated Sales Sets directly from Stock Logs (handling additions, removals, cancels, and returns)
  const salesSets = await Stock.aggregate([
    {
      $match: {
        createdAt: { $gte: start, $lte: end },
        type: { $in: ["purchase", "add-item", "remove-item", "return", "cancel", "reject", "cancelled", "rejected"] },
        productId: { $ne: null }
      }
    },
    {
      $project: {
        productId: 1,
        sellingPrice: { $ifNull: ["$sellingPrice", 0] },
        purchasePrice: { $ifNull: ["$purchasePrice", 0] },
        quantity: 1,
        netQty: {
          $cond: {
            if: { $in: ["$type", ["purchase", "add-item"]] },
            then: "$quantity",
            else: { $multiply: ["$quantity", -1] }
          }
        },
        netVal: {
          $multiply: [
            { $ifNull: ["$sellingPrice", 0] },
            {
              $cond: {
                if: { $in: ["$type", ["purchase", "add-item"]] },
                then: "$quantity",
                else: { $multiply: ["$quantity", -1] }
              }
            }
          ]
        },
        netCost: {
          $multiply: [
            { $ifNull: ["$purchasePrice", 0] },
            {
              $cond: {
                if: { $in: ["$type", ["purchase", "add-item"]] },
                then: "$quantity",
                else: { $multiply: ["$quantity", -1] }
              }
            }
          ]
        }
      }
    },
    {
      $group: {
        _id: {
          productId: "$productId",
          price: "$sellingPrice",
          purchasePrice: "$purchasePrice"
        },
        totalQty: { $sum: "$netQty" },
        totalVal: { $sum: "$netVal" },
        totalCostVal: { $sum: "$netCost" }
      }
    },
    {
      $project: {
        productId: "$_id.productId",
        type: { $literal: "Sale Set" },
        unitPrice: "$_id.price",
        purchasePrice: "$_id.purchasePrice",
        quantity: "$totalQty",
        totalValue: "$totalVal",
        totalCost: "$totalCostVal"
      }
    }
  ]);

  // 3. Union and Enrich with Product Details
  const combinedSets = [...purchaseSets, ...salesSets];
  const productIds = Array.from(new Set(combinedSets.map(set => String(set.productId))));

  // Fetch all relevant products in ONE query
  const products = await Product.find({ _id: { $in: productIds } })
    .populate("brand", "name")
    .populate("groups", "name")
    .lean();

  // 4. Fetch Last Purchase Price for each product (Irrespective of Date)
  const lastPurchasePrices = await Stock.aggregate([
    {
      $match: {
        type: "stock-in",
        productId: { $in: productIds.map(id => new mongoose.Types.ObjectId(id)) }
      }
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$productId",
        lastPrice: { $first: { $ifNull: ["$purchasePrice", 0] } }
      }
    }
  ]);

  const productMap = new Map(products.map(p => [String(p._id), p]));
  const lastPriceMap = new Map(lastPurchasePrices.map(lp => [String(lp._id), lp.lastPrice]));

  const enrichedData = combinedSets.map(set => {
    const product = productMap.get(String(set.productId));
    const isSaleSet = set.type === "Sale Set";
    const lastPurchasePrice = isSaleSet ? (lastPriceMap.get(String(set.productId)) || 0) : "";
    const netProfit = isSaleSet ? (set.totalValue - set.totalCost) : "";

    return {
      productName: product?.fullName || product?.name || "Unknown Product",
      sku: product?.sku || "N/A",
      group: product?.brand?.name || product?.groups?.[0]?.name || "N/A",
      setType: set.type,
      unitPrice: set.unitPrice,
      purchasePrice: set.purchasePrice,
      quantity: set.quantity,
      totalValue: set.totalValue,
      totalCost: set.totalCost,
      netProfit,
      lastPurchasePrice
    };
  });

  // Sort by product name for grouping sets together in Excel
  enrichedData.sort((a, b) => a.productName.localeCompare(b.productName));

  return res
    .status(200)
    .json(new ApiResponse(200, enrichedData, "Product sets report fetched successfully"));
});

export const getStockFlowReport = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { startDate, endDate } = req.body;

  if (!productId) {
    throw new ApiError(400, "Product ID is required");
  }

  let filter = { productId: new mongoose.Types.ObjectId(productId) };

  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00+05:30`);
    const end = new Date(`${endDate}T23:59:59.999+05:30`);
    filter.createdAt = { $gte: start, $lte: end };
  }

  const stockLogs = await Stock.find(filter)
    .populate("productId", "name fullName sku")
    .sort({ createdAt: -1 })
    .lean();

  const formattedLogs = stockLogs.map(log => ({
    logId: log._id ? String(log._id) : "N/A",
    date: log.createdAt ? new Date(log.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "N/A",
    productId: log.productId?._id ? String(log.productId._id) : (log.productId ? String(log.productId) : "N/A"),
    productName: log.productId?.fullName || log.productId?.name || "N/A",
    sku: log.productId?.sku || "N/A",
    variantId: log.variantId ? String(log.variantId) : "N/A",
    variantName: log.variantName || "N/A",
    type: log.type,
    category: log.category || "N/A",
    quantity: log.quantity,
    previousStock: log.previousStock ?? "N/A",
    updatedStock: log.updatedStock ?? "N/A",
    previousPhysicalStock: log.previousPhysicalStock ?? "N/A",
    updatedPhysicalStock: log.updatedPhysicalStock ?? "N/A",
    totalProductStock: log.totalProductStock ?? "N/A",
    purchasePrice: log.purchasePrice ?? "N/A",
    sellingPrice: log.sellingPrice ?? "N/A",
    orderId: log.orderId || "N/A",
    quotationId: log.quotationId || "N/A",
    vendor: log.vendor || "N/A",
    isScratchy: log.isScratchy ? "True" : "False"
  }));

  return res
    .status(200)
    .json(new ApiResponse(200, formattedLogs, "Stock flow report fetched successfully"));
});
