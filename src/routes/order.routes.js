import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { shiprocketAuth } from "../middlewares/shiprocket.middlewares.js";
import {
    createCodOrder,
    createOnlineOrder, verifyPayment,
    getAllOrders, getAllOrdersByUser,
    acceptOrder,
    preShiprocketCancel,
    createdCancel,
    awbCancel,
    postPickupCancel,
    inTransitCancel,
    deliveredCancel,
    createPosOrder,
    preShiprocketReject,
    createdReject,
    awbReject,
    holdAbandonedOrder,
    getOrdersByDate,
    getOrderById,
    updateOrder,
    addItemQuantityInOrder,
    removeItemQuantityInOrder,
    getFilteredOrdersByDate,
    returnOrder,
    getOrdersByRequestType,
    createManualOrder,
    reviewOrder,
    returnOrderV2,
    restoreOrderStock,
    markAsDeliveredManually,
    recordCallAttempt,
    addOrderPayment,
    editOrderPayment,
    getOrderPayments,
    generatePaymentRecordLink,
    manualShipOrder,
    updateManualShippingStatus,
    systemCreatedCancel
} from "../controllers/order.controller.js";
import {
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
} from "../controllers/v2/order.controller.js";
import {
    assignPartialReturnCourier,
    schedulePartialReturnPickup
} from "../controllers/v2/shiprocket.controller.js";
import {
    assignBestCourier,
    assignReturnCourier,
    generateLabelAndManifestBackground,
    schedulePickup,
    scheduleReturnOrderPickup,
    shiprocketWebhook,
    verifyShiprocketToken,
    getCourierServiceability
} from "../controllers/shiprocket.controller.js";
import { getPaginatedOrders, getSalesDataController } from "../controllers/pagination.controller.js";

const router = Router()

//Place Order Routes
router.route("/pos/new").post(verifyJWT, createPosOrder);
router.route("/manual/new").post(verifyJWT, createManualOrder);
router.route("/cod/new").post(verifyJWT, createCodOrder);
router.route("/online/new").post(verifyJWT, createOnlineOrder);
router.route("/online/verify").post(verifyJWT, verifyPayment);
// router.route("/online/restore").post(verifyJWT, restoreOrderStock);
router.route("/user").get(verifyJWT, getAllOrdersByUser);
router.route("/review").post(verifyJWT, reviewOrder);

// Payments & manual shipping routes
router.route("/payments/add").post(verifyJWT, addOrderPayment);
router.route("/payments/edit/:paymentId").put(verifyJWT, editOrderPayment);
router.route("/payments/list/:orderId").get(verifyJWT, getOrderPayments);
router.route("/payments/generate-link").post(verifyJWT, generatePaymentRecordLink);
router.route("/manual-ship").post(verifyJWT, manualShipOrder);
router.route("/manual-ship/status").post(verifyJWT, updateManualShippingStatus);

router.route("/:_id").put(verifyJWT, updateOrder);
router.route("/items/add").post(verifyJWT, addItemQuantityInOrder);
router.route("/items/remove").post(verifyJWT, removeItemQuantityInOrder);
router.route("/details/:_id").get(verifyJWT, getOrderById);
router.route("/custom/filtered").get(verifyJWT, getFilteredOrdersByDate);
router.route("/custom").get(verifyJWT, getOrdersByDate);
router.route("/").get(verifyJWT, getAllOrders);
//Paginated Orders
router.route("/sales").get(verifyJWT, getSalesDataController);
router.route("/paginated").get(verifyJWT, getPaginatedOrders);
router.route("/request").get(verifyJWT, getOrdersByRequestType);

//Admin Order Routes
router.route("/hold").post(verifyJWT, holdAbandonedOrder);
router.route("/accept").post(
    verifyJWT,
    shiprocketAuth,
    acceptOrder,
    assignBestCourier,
    schedulePickup,
    generateLabelAndManifestBackground
);

router.route("/mark-delivered-manually").post(verifyJWT, markAsDeliveredManually);
router.route("/call-attempt/:_id").post(verifyJWT, recordCallAttempt);

router.route("/schedulePickup").post(
    verifyJWT,
    shiprocketAuth,
    schedulePickup,
    generateLabelAndManifestBackground
);

router.route("/reject").post(
    verifyJWT,
    shiprocketAuth,
    preShiprocketReject,
    createdReject,
    awbReject
)

router.route("/cancel").post(
    verifyJWT,
    systemCreatedCancel
)

// LEGACY RETURN FLOW (DO NOT USE)
// router.route('/return').post(
//     verifyJWT,
//     shiprocketAuth,
//     returnOrder
// )
// router.route('/return/accept').post(
//     verifyJWT,
//     shiprocketAuth,
//     returnOrderV2,
// )
// router.route('/return/courier/assign').post(
//     verifyJWT,
//     shiprocketAuth,
//     assignReturnCourier,
// )
// router.route('/return/pickup/schedule').post(
//     verifyJWT,
//     shiprocketAuth,
//     scheduleReturnOrderPickup
// )

/* ─────────────────────────────────────────────────────────────────────
   Partial Return Order Routes (v1 migrated)
   ───────────────────────────────────────────────────────────────────── */
router.route("/partial-return/raise").post(verifyJWT,
    // shiprocketAuth, 
    raisePartialReturnRequest);
router.route("/partial-return/requests").get(verifyJWT, getPaginatedPartialRequests);
router.route("/partial-return/requests/order/:orderId").get(verifyJWT, getPartialReturnRequestsByOrderId);
router.route("/partial-return/requests/:id").get(verifyJWT, getPartialReturnRequestById);
router.route("/partial-return/accept").post(verifyJWT,
    // shiprocketAuth, 
    acceptPartialReturnRequest);
router.route("/partial-return/reject").post(verifyJWT, rejectPartialReturnRequest);
router.route("/partial-return/hold").post(verifyJWT, holdPartialReturnRequest);
router.route("/partial-return/reopen").post(verifyJWT, reopenPartialReturnRequest);
router.route("/partial-return/reply").post(verifyJWT, sendPartialReturnReply);
router.route("/partial-return/courier/assign").post(verifyJWT,
    // shiprocketAuth, 
    assignPartialReturnCourier);
router.route("/partial-return/pickup/schedule").post(verifyJWT, shiprocketAuth, schedulePartialReturnPickup);

// Track order routes
router.route('/webhook').post(
    verifyShiprocketToken,
    shiprocketWebhook
);

router.route('/shiprocket/serviceability').get(
    verifyJWT,
    shiprocketAuth,
    getCourierServiceability
)

export default router;