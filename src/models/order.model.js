import mongoose from "mongoose";
import { itemsSchema } from "./cart.model.js";
import { Counter } from "./counter.model.js";
import { ORDER_TYPES } from "../constants.js";

const requestSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: [
            "Cancel",
            "Warranty",
            "Return"
        ]
    },
    isRaised: { type: Boolean, default: false },
    raisedAt: { type: String },
    isResolved: { type: Boolean, default: false },
    status: {
        type: String,
        enum: [
            "Pending",
            "Accepted",
            "Rejected"
        ],
        default: "Pending"
    },
    resolvedAt: { type: String },
    reason: { type: String },
}, { timestamps: true }, { _id: false })

const orderSchema = new mongoose.Schema(
    {
        /****************  CORE ORDER STATES  *****************/
        status: {
            type: String,
            // enum: [
            //     "New",
            //     "Accepted",
            //     "Rejected",
            //     "Shipped",
            //     "Delivered",
            //     "Cancelled",
            //     "Returned",
            //     "Return Cancelled",
            //     "RTO Initiated",
            //     "RTO Delivered",
            //     "RTO Acknowledged",
            //     "Replaced",
            //     "Hold"
            // ],
            default: "New"
        },
        reason: { type: String },
        comments: { type: String },
        shippingStatus: {
            type: String,
            // enum: [
            //     "Pending",
            //     "PENDING",
            //     "Courier Assigned",
            //     "Pickup Scheduled",
            //     "In Transit",
            //     "IN TRANSIT",
            //     "Shipped",
            //     "Delivered",
            //     "CANCELLED",
            //     "Cancelled"
            // ],
            default: "Pending"
        },
        scans: {
            type: mongoose.Schema.Types.Mixed,
            default: []
        },
        orderState: {
            type: String,
            enum: ["Reserved", "Confirmed", "Abandoned"],
        },
        paymentStatus: {
            type: String,
            enum: ["Pending", "Paid"],
            default: "Pending"
        },
        paymentDate: {
            type: Date,
        },
        isReviewed: {
            type: Boolean,
            default: false
        },

        callAttempts: {

            noOfAttempts: {
                type: Number,
                default: 0
            },
            history: [{
                attemptNo: Number,
                date: Date,
                employeeId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User"
                },
                remarks: String
            }]
        },

        /****************  SHIPROCKET FIELDS  *****************/
        // shipmentId: String,  // Shiprocket shipment_id
        // shiprocketOrderId: String,  // Shiprocket order_id
        // shiprocketChannelId: String,  // Channel order ref
        awbCode: String,  // Air‑way bill
        courierName: String,
        courierAssignedAt: Date,
        trackingUrl: {
            type: String,
            default: ""
        },

        pickupScheduled: {
            type: Boolean,
            default: false
        },

        stockIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Stock'
        }],

        _restockDone: {
            type: Boolean,
            default: false
        },

        // pickupTokenNumber: String,  // “2025‑06‑14”
        pickupDate: String,  // “2025‑06‑14”
        expectedDeliveryDate: String,  // “2025‑06‑14”
        // pickupSlot: String,  // e.g. “14:00‑18:00”
        shippingLabelUrl: String,  // e.g. “14:00‑18:00”
        shippingManifestUrl: String,  // e.g. “14:00‑18:00”

        deliveredAt: String,    // set when status → Delivered
        acceptedAt: Date,
        acceptedReason: String,
        shippedAt: Date,
        shippingReason: String,
        labelGeneratedAt: Date,
        manifestGeneratedAt: Date,
        shiprocketOrderCreatedAt: Date,


        /****************  RTO FIELDS  *****************/

        rtoInitiatedAt: { type: String },   // set when RTO starts
        rtoDeliveredAt: { type: String },   // set when RTO parcel returns


        /****************  RETURN FIELDS  *****************/

        returnScans: {
            type: mongoose.Schema.Types.Mixed,
            default: []
        },
        returnData: {
            type: mongoose.Schema.Types.Mixed,
            // default: {}
        },
        returnDeliveredAt: { type: String },   // set when RTO parcel returns
        returnOrderRef: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order'
        }],
        partialReturnRequests: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PartialRequest'
        }],

        /****************  PAYMENT FIELDS  *****************/
        gateway: {
            type: String,
            enum: ["razorpay", "phonepe"],
            required: false
        },
        razorpayOrderId: String,
        razorpayPaymentId: String,
        phonepeOrderId: String,
        phonepePaymentId: String,
        phonepeRawResponse: mongoose.Schema.Types.Mixed,
        phonepeUtr: String,
        phonepePaymentMode: String,
        refundId: String,
        refundAmount: Number,
        refundStatus: {
            type: String,
            enum: ["Pending", "Success", "Failed"]
        },
        refundReason: String,
        refundedAt: Date,
        refundedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },

        /****************  ORDER REQUESTS  *****************/
        requests: [requestSchema],

        /****************  ORDER METADATA  *****************/
        orderId: {
            type: String,
            required: true,
            unique: [true, "Order Id already used"]
        },
        type: {
            type: String,
            enum: ["Regular", "Pos", "Partial Return", "Manual"],
            default: "Regular"
        },
        method: {
            type: String,
            enum: ["COD", "Online", "UPI", "Cash", "Mixed"],
            // default: "COD"
        },
        paymentMode: {
            type: String,
            enum: ["complete", "parcel"]
        },
        shippingPartner: {
            type: String
        },
        latitude: {
            type: Number
        },
        longitude: {
            type: Number
        },
        isAppOrder: {
            type: Boolean,
            default: false
        },
        abondonedOrder: {
            type: Boolean,
            default: false
        },

        /****************  PRICING  *****************/
        coupon: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Coupon",
        },
        couponCode: { type: String },
        couponType: { type: String },
        orderAmount: { type: Number, required: true },
        amountPaid: { type: Number, default: 0 },
        remainingAmount: { type: Number, default: 0 },
        shippingType: { type: String, enum: ["Manual", "Partner"], default: "Manual" },
        deliveryCharge: { type: Number, default: 0 },
        discount: { type: Number, default: 0 },
        discountPercent: { type: Number, default: 0 },
        discountType: {
            type: String,
            enum: ["flat", "percentage"],
            default: "flat"
        },
        gst: { type: String },
        subtotal: Number,

        /****************  CUSTOMER INFO  *****************/
        name: String,
        email: String,
        phoneNo: String,

        /****************  ADDRESS  *****************/
        address: String,
        address2: String,
        city: String,
        state: String,
        pincode: String,
        country: String,
        addressId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Address"
        },

        /****************  RELATIONS  *****************/
        quotationId: {
            type: String
        },
        quotationRef: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Quotation"
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        /****************  QUERIES  *****************/
        query: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Query",
            // required: true
        },

        /************** Product/Itesm Details *******************/
        items: [itemsSchema],
        length: {
            type: Number,
            default: 19
        },
        breadth: {
            type: Number,
            default: 16
        },
        height: {
            type: Number,
            default: 6
        },
        weight: {
            type: Number,
            default: 0.5
        },
    },
    { timestamps: true }
);

orderSchema.index({ createdAt: -1 });
// orderSchema.pre("save", async function (next) {
//     if (this.isNew && !this.orderId && !this.abondonedOrder && this.type != ORDER_TYPES.PARTIAL_RETURN) { // only for new orders that are not abandoned
//         const counter = await Counter.findOneAndUpdate(
//             { _id: "quotationId" },
//             { $inc: { seq: 1 } },
//             { new: true, upsert: true, setDefaultsOnInsert: true }
//         ).lean();  // lean() improves concurrency performance
//         this.orderId = counter.seq;
//         console.log("Order Id: ", this.orderId);
//     }
//     next();
// });

orderSchema.statics.generateNextOrderId = async function () {
    const counter = await Counter.findOneAndUpdate(
        { _id: "quotationId" },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    console.log("Order Id: ", counter.seq);
    return counter.seq;
};

export const Order = mongoose.model("Order", orderSchema);