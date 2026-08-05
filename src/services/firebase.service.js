import admin from "firebase-admin";
import crypto from "crypto";

let messagingInstance = null;

const initFirebase = () => {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert({
                project_id: process.env.FIREBASE_PROJECT_ID,
                client_email: process.env.FIREBASE_CLIENT_EMAIL,
                private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
            }),
        });
    }
    if (!messagingInstance) {
        messagingInstance = admin.messaging();
    }
};

/**
 * Sends a silent, data-only FCM message to a specific topic, single device token, or list of device tokens.
 * A data-only message does not contain a "notification" payload, meaning it does not show up as a visual alert
 * in the device UI, but triggers background event listeners/handlers in the app.
 *
 * @param {Object} params
 * @param {string} [params.topic] - Target topic (e.g. 'allUsers')
 * @param {string|string[]} [params.token] - Target FCM device token or array of tokens
 * @param {Object} [params.data] - Key-value pairs of custom payload data. All values must be strings.
 * @returns {Promise<any>} Response from Firebase (Message ID, multicast response, etc.)
 */
export const sendSilentNotification = async ({ topic, token, data = {} }) => {
    initFirebase();
    // Firebase Cloud Messaging requires all values in the data dictionary to be strings
    const sanitizedData = {};
    for (const [key, value] of Object.entries(data)) {
        sanitizedData[key] = String(value);
    }

    const baseMessage = {
        data: sanitizedData,
        android: {
            priority: "high",
        },
        apns: {
            payload: {
                aps: {
                    "content-available": 1,
                },
            },
            headers: {
                "apns-push-type": "background",
                "apns-priority": "5", // Must be '5' for content-available silent background updates
            },
        },
    };

    if (topic) {
        const message = { ...baseMessage, topic };
        return await messagingInstance.send(message);
    } else if (Array.isArray(token)) {
        if (token.length === 0) {
            return { successCount: 0, failureCount: 0 };
        }
        // Send to multiple tokens using sendEachForMulticast
        const message = { ...baseMessage, tokens: token };
        return await messagingInstance.sendEachForMulticast(message);
    } else if (token) {
        const message = { ...baseMessage, token };
        return await messagingInstance.send(message);
    } else {
        throw new Error("Target destination missing: either 'topic', 'token', or an array of tokens must be provided.");
    }
};

/**
 * Encrypts a route string using AES-256-CBC algorithm and the NOTIFICATION_CRYPTO_SECRET key.
 *
 * @param {string} route - The route string to encrypt
 * @returns {string} Encrypted string in format "ivHex:ciphertextHex"
 */
export const encryptRoute = (route) => {
    const algorithm = "aes-256-cbc";
    const secret = process.env.NOTIFICATION_CRYPTO_SECRET
    // || "mobiking-secret-key-12345";
    // Derive a 32-byte key from the secret
    const key = crypto.createHash("sha256").update(secret).digest();
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(route, "utf8", "hex");
    encrypted += cipher.final("hex");

    return `${iv.toString("hex")}:${encrypted}`;
};

/**
 * Encrypts the provided API route and broadcasts a silent reload notification in the background
 * to all active app installations listening on the "allUsers" topic.
 *
 * @param {string} route - The API route that needs to be reloaded (e.g. "/home/website")
 */
export const sendRouteReloadNotification = (route) => {
    // Run asynchronously in the background to prevent any latency in the main HTTP request thread
    setImmediate(async () => {
        try {
            const encryptedRoute = encryptRoute(route);
            console.log(`[FCM-SILENT] Broadcasting reload for route: ${route} (encrypted: ${encryptedRoute}) to allUsers`);

            const response = await sendSilentNotification({
                topic: "allUsers",
                data: {
                    event: "api_reload",
                    route: encryptedRoute
                }
            });
            console.log(`[FCM-SILENT] Broadcast successful for route: ${route}. Response Message ID: ${response}`);
        } catch (error) {
            console.error(`[FCM-SILENT] Broadcast failed for route: ${route}`, error);
        }
    });
};
