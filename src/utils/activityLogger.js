import { ActivityLog } from "../models/activity_log.model.js";

export const logActivity = async ({ orderId, quotationId, action, remarks, req, session }) => {
    try {
        const performedBy = req?.user?._id || null;
        const performedByName = req?.user?.name || "";
        const performedByRole = req?.user?.role || "";

        const logData = {
            orderId,
            quotationId,
            action,
            remarks: remarks || "",
            performedBy,
            performedByName,
            performedByRole
        };

        if (session) {
            await ActivityLog.create([logData], { session });
        } else {
            await ActivityLog.create(logData);
        }
    } catch (error) {
        console.error("Failed to write activity log:", error);
    }
};
