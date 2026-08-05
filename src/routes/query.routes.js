import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    addRatingToQuery,
    addReplyToQuery,
    assignQueriesInBulk,
    closeQuery,
    getQueries,
    getQueriesForLoggedInUser,
    getQueryById,
    raiseQueryByUser
} from "../controllers/query.controller.js";
import { getPaginatedQueries } from "../controllers/pagination.controller.js";

const router = Router()

//Product Routes
router.route("/raiseQuery").post(verifyJWT, raiseQueryByUser);
router.route("/reply").post(verifyJWT, addReplyToQuery);
router.route("/assign").post(verifyJWT, assignQueriesInBulk);
router.route("/close").post(verifyJWT, closeQuery);
router.route("/rate").post(verifyJWT, addRatingToQuery);
router.route("/").get(verifyJWT, getQueries);
router.route("/my").get(verifyJWT, getQueriesForLoggedInUser);
router.route("/all/paginated").get(verifyJWT, getPaginatedQueries);
router.route("/:id").get(verifyJWT, getQueryById);

export default router