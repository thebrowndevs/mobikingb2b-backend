// controllers/query.controller.js
import mongoose from "mongoose";
import { Query } from "../models/query.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { User } from "../models/user.model.js";
import { ROLES } from "../constants.js";
import { Order } from "../models/order.model.js";


export const raiseQueryByUser = asyncHandler(async (req, res) => {
    const { title, description, orderId } = req.body;

    // Ensure user is authenticated and has correct role
    const user = req.user;

    if (!user || user.role !== "user") {
        throw new ApiError(403, "Unauthorized: Only customers can raise queries");
    }

    if (!title || !description) {
        throw new ApiError(400, "Title and description are required");
    }

    // 1️⃣ Create new query
    const newQuery = new Query({
        orderId,
        title,
        description,
        raisedBy: user._id,
        assignedTo: null,
        raisedAt: new Date(),
        replies: []
    });

    const savedQuery = await newQuery.save();

    // 2️⃣ Push query ID into user's `queries` array
    await User.findByIdAndUpdate(user._id, {
        $push: { queries: savedQuery._id }
    });

    // 2️⃣ Push query ID into order's `query'
    const updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
            query: savedQuery._id
        },
        { new: true }
    ).populate({ path: "userId", select: "-password -refreshToken" })
        .populate({
            path: "items.productId",
            model: "Product",
            populate: { path: "category", model: "SubCategory" },
        })
        .populate("addressId")
        .exec();;

    if (!updatedOrder) {
        throw new ApiError(500, "Could not attach query to order");
    }


    // 3️⃣ Return response
    return res.status(201).json(
        new ApiResponse(201, { updatedOrder, savedQuery }, "Query raised successfully")
    );
});

export const addReplyToQuery = asyncHandler(async (req, res) => {
    const { queryId, message } = req.body;
    const user = req.user;

    // Validate input
    if (!queryId || !message) {
        throw new ApiError(400, "Query ID and message are required");
    }

    // Fetch query
    const query = await Query.findById(queryId);

    if (!query) {
        throw new ApiError(404, "Query not found");
    }

    // Check if query is not assigned yet
    // if (!query?.assignedTo) {
    //     throw new ApiError(403, "Query not assigned yet");
    // }

    // Add reply
    const reply = {
        message,
        messagedBy: user._id,
        messagedAt: new Date()
    };

    query.replies.push(reply);
    const updatedQuery = await query.save();

    // Populate before sending
    const populated = await Query.findById(updatedQuery._id)
        .populate("raisedBy", "name email phone role")
        .populate("assignedTo", "name email phone role")
        .populate("replies.messagedBy", "name email phone role")
        .populate({
            path: "orderId",
            populate: {
                path: "items.productId",
                model: "Product"
            }
        });

    return res.status(200).json(
        new ApiResponse(200, populated, "Reply added to query successfully")
    );
});

export const assignQueriesInBulk = asyncHandler(async (req, res) => {
    const { queryIds, userId } = req.body;

    // Validate input
    if (!Array.isArray(queryIds) || queryIds.length === 0 || !userId) {
        throw new ApiError(400, "queryIds[] and userId are required");
    }

    // Validate assignee user
    const assignee = await User.findById(userId).select("_id name email role");
    if (!assignee) {
        throw new ApiError(404, "Assignee user not found");
    }

    if (assignee?.role == ROLES.USER) {
        throw new ApiError(404, "Query can not be assigned to customer");
    }

    // Filter valid ObjectIds
    const validIds = queryIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

    if (validIds.length === 0) {
        throw new ApiError(400, "No valid queryIds provided");
    }

    // Assign queries that are not already assigned
    await Query.updateMany(
        { _id: { $in: validIds }, assignedTo: { $in: [null, undefined] } },
        {
            $set: {
                assignedTo: assignee._id,
                assignedAt: new Date()
            }
        },
        { new: true }
    );

    return res.status(200).json(
        new ApiResponse(200, assignee, "Queries assigned successfully")
    );
});

export const closeQuery = asyncHandler(async (req, res) => {
    const { queryId
        // , closingMessage 
    } = req.body;
    const requester = req.user; // injected by auth middleware

    /* 1️⃣  Basic checks */
    if (!queryId) {
        throw new ApiError(400, "queryId and closingMessage are required");
    }

    if (["user"].includes(requester.role)) {
        throw new ApiError(403, "Only Admin/Employees can resolve queries");
    }

    /* 2️⃣  Fetch query */
    const query = await Query.findById(queryId);

    if (!query) throw new ApiError(404, "Query not found");

    if (query?.isResolved) {
        throw new ApiError(409, "Query is already resolved");
    }

    // if (!query?.assignedTo) {
    //     throw new ApiError(409, "Cannot resolve an unassigned query");
    // }

    /* 3️⃣  Build resolution reply */
    // const resolutionReply = {
    //     message: closingMessage,
    //     messagedBy: requester._id,
    //     messagedAt: new Date()
    // };

    /* 4️⃣  Update query */
    // query.replies.push(resolutionReply);
    query.isResolved = true;
    query.resolvedAt = new Date();

    const saved = await query.save();

    /* 5️⃣  Populate for response */
    const populated = await Query.findById(saved._id)
        .populate("raisedBy", "name email phone role")
        .populate("assignedTo", "name email phone role")
        .populate("replies.messagedBy", "name email phone role")
        .populate({
            path: "orderId",
            populate: {
                path: "items.productId",
                model: "Product"
            }
        });

    return res.status(200).json(
        new ApiResponse(200, populated, "Query resolved successfully")
    );
});

export const addRatingToQuery = asyncHandler(async (req, res) => {
    const { queryId, rating, review } = req.body;
    const user = req.user;

    // 1️⃣ Validate input
    if (!queryId || !rating || !review) {
        throw new ApiError(400, "Query ID, rating and review are required");
    }

    // 2️⃣ Ensure only users can rate
    if (!user || user.role !== "user") {
        throw new ApiError(403, "Only users can submit ratings");
    }

    // 3️⃣ Fetch the query
    const query = await Query.findById(queryId);

    if (!query) {
        throw new ApiError(404, "Query not found");
    }

    // 4️⃣ Ensure user owns the query
    if (!query.raisedBy.equals(user._id)) {
        throw new ApiError(403, "You can only rate your own queries");
    }

    // 5️⃣ Allow rating only if query is resolved
    if (!query.isResolved) {
        throw new ApiError(409, "You can only rate resolved queries");
    }

    // 6️⃣ Prevent duplicate rating
    if (query.rating) {
        throw new ApiError(409, "Rating already submitted for this query");
    }

    // 7️⃣ Update rating and review
    query.rating = rating;
    if (review) query.review = review;

    const updatedQuery = await query.save();

    // Populate before sending
    const populated = await Query.findById(updatedQuery._id)
        .populate("raisedBy", "name email phone role")
        .populate("assignedTo", "name email phone role")
        .populate("replies.messagedBy", "name email phone role")
        .populate({
            path: "orderId",
            populate: {
                path: "items.productId",
                model: "Product"
            }
        });

    return res.status(200).json(
        new ApiResponse(200, populated, "Rating submitted successfully")
    );
});

export const getQueries = asyncHandler(async (req, res) => {
    const { assignedTo } = req.query;

    // Build dynamic filter
    const filter = {};

    // Only return user-specific queries if role is 'user'
    if (assignedTo) filter.assignedTo = assignedTo;

    // Fetch and populate user details
    const queries = await Query.find(
        filter
    )
        .populate("raisedBy", "name email phone role")
        .populate("assignedTo", "name email phone role")
        .populate("replies.messagedBy", "name email phone role")
        .populate({
            path: "orderId",
            populate: {
                path: "items.productId",
                model: "Product"
            }
        })
        .sort({ createdAt: -1 });

    return res.status(200).json(
        new ApiResponse(200, queries, "Queries fetched successfully")
    );
});

export const getQueryById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) throw new ApiError(400, "Valid Query id required")

    // Fetch and populate query details
    const query = await Query.findById(id)
        .populate("raisedBy", "name email phone role")
        .populate("assignedTo", "name email phone role")
        .populate("replies.messagedBy", "name email phone role")
        .populate({
            path: "orderId",
            populate: {
                path: "items.productId",
                model: "Product"
            }
        });

    if (!query) {
        throw new ApiError(404, "Query not found");
    }

    return res.status(200).json(
        new ApiResponse(200, query, "Query details fetched successfully")
    );
});

export const getQueriesForLoggedInUser = asyncHandler(async (req, res) => {
    const userId = req.user?._id;

    const queries = await Query.find({ raisedBy: userId })
        .populate("raisedBy", "name email phone role")
        .populate("assignedTo", "name email phone role")
        .populate("replies.messagedBy", "name email phone role")
        .populate({
            path: "orderId",
            populate: {
                path: "items.productId",
                model: "Product"
            }
        })
        .sort({ createdAt: -1 });

    return res.status(200).json(
        new ApiResponse(200, queries, "Queries fetched successfully")
    );
});