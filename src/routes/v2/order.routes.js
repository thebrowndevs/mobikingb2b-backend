import { Router } from "express";
import { verifyJWT } from "../../middlewares/auth.middlewares.js";
import { shiprocketAuth } from "../../middlewares/shiprocket.middlewares.js";
import {
    createPosOrder,
    createOnlineOrderV2,
    phonepeCallbackV2,
    raisePartialReturnRequest,
    getPaginatedPartialRequests,
    getPartialReturnRequestById,
    acceptPartialReturnRequest,
    rejectPartialReturnRequest,
    holdPartialReturnRequest,
    reopenPartialReturnRequest,
    sendPartialReturnReply,
    getPartialReturnRequestsByOrderId,
    initiateOrderRefund
} from "../../controllers/v2/order.controller.js";
import {
    assignPartialReturnCourier,
    schedulePartialReturnPickup
} from "../../controllers/v2/shiprocket.controller.js";
import { generatePaymentLinkV2 } from "../../controllers/v2/paymentLinkV2.controller.js";

const router = Router();

router.route("/pos/new").post(verifyJWT, createPosOrder);
router.route("/online/new").post(verifyJWT, createOnlineOrderV2);
router.route("/online/phonepe-callback").all(phonepeCallbackV2);
router.route("/online/payment-link").post(verifyJWT, generatePaymentLinkV2);
router.route("/refund").post(verifyJWT, initiateOrderRefund);

/* ─────────────────────────────────────────────────────────────────────
   Partial Return Order Routes (v2)
   ───────────────────────────────────────────────────────────────────── */
router.route("/partial-return/raise").post(verifyJWT, shiprocketAuth, raisePartialReturnRequest);
router.route("/partial-return/requests").get(verifyJWT, getPaginatedPartialRequests);
router.route("/partial-return/requests/order/:orderId").get(verifyJWT, getPartialReturnRequestsByOrderId);
router.route("/partial-return/requests/:id").get(verifyJWT, getPartialReturnRequestById);
router.route("/partial-return/accept").post(verifyJWT, shiprocketAuth, acceptPartialReturnRequest);
router.route("/partial-return/reject").post(verifyJWT, rejectPartialReturnRequest);
router.route("/partial-return/hold").post(verifyJWT, holdPartialReturnRequest);
router.route("/partial-return/reopen").post(verifyJWT, reopenPartialReturnRequest);
router.route("/partial-return/reply").post(verifyJWT, sendPartialReturnReply);
router.route("/partial-return/courier/assign").post(verifyJWT, shiprocketAuth, assignPartialReturnCourier);
router.route("/partial-return/pickup/schedule").post(verifyJWT, shiprocketAuth, schedulePartialReturnPickup);

export default router;
