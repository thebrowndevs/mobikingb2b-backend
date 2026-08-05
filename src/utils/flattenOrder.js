// For flattening the order data to make it exportable as csv
export const flattenOrder = (orders) => {
    const rows = [];

    orders.forEach((order) => {
        order.items?.forEach((item, index) => {
            if (index > 0) {
                rows.push({
                    _id: order._id,
                    orderId: order.orderId,
                    createdAt: "",
                    type: "",
                    method: "",
                    status: "",
                    shippingStatus: "",
                    paymentStatus: "",
                    paymentDate: "",
                    name: "",
                    phoneNo: "",
                    userId: "",

                    //items
                    itemNo: index + 1,
                    productId: item?.productId?._id || "",
                    // name_item: item?.productId?.name || "",
                    fullName: item?.fullName || item?.productId?.fullName || "",
                    variant: item?.variantName || "",
                    quantity: item?.quantity ?? "",
                    price: item?.price ?? "",

                    //other details

                    subtotal: "",
                    deliveryCharge: "",
                    discount: "",
                    orderAmount: "",
                    gst: "",
                    isAppOrder: "",
                    abondonedOrder: "",
                    pickupScheduled: "",
                    length: "",
                    breadth: "",
                    height: "",
                    weight: "",
                    updatedAt: "",
                });
            } else {
                rows.push(
                    {
                        _id: order._id,
                        orderId: order.orderId,
                        createdAt: order.createdAt,
                        type: order.type,
                        method: order.method,
                        status: order.status,
                        shippingStatus: order.shippingStatus,
                        paymentStatus: order.paymentStatus,
                        paymentDate: order.paymentDate || "",
                        name: order.name,
                        phoneNo: order.phoneNo,
                        userId: order.userId?._id || "",

                        //items
                        itemNo: index + 1,
                        productId: item?.productId?._id || "",
                        // name_item: item?.productId?.name || "",
                        fullName: item?.fullName || item?.productId?.fullName || "",
                        variant: item?.variantName || "",
                        quantity: item?.quantity ?? "",
                        price: item?.price ?? "",

                        //other details

                        subtotal: order.subtotal,
                        deliveryCharge: order.deliveryCharge,
                        discount: order.discount,
                        orderAmount: order.orderAmount,
                        gst: order.gst,
                        isAppOrder: order.isAppOrder,
                        abondonedOrder: order.abondonedOrder,
                        pickupScheduled: order.pickupScheduled,
                        length: order.length,
                        breadth: order.breadth,
                        height: order.height,
                        weight: order.weight,
                        updatedAt: order.updatedAt,
                    }
                )
            }
        });
    });

    return rows;
};