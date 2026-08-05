import fs from 'fs';
import path from 'path';

/**
 * Common utility to log data to a file in the logs directory
 * @param {string} filename - The name of the log file (e.g., 'borzo.log')
 * @param {string} action - Description of the action (e.g., 'WEBHOOK_RECEIVED')
 * @param {any} data - The data payload to log
 */
export const logToFile = (filename, action, data) => {
    try {
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        const logFile = path.join(logsDir, filename);

        const date = new Date();
        const options = { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
        const istTime = date.toLocaleString('en-IN', options).replace(/\//g, '-');

        let safeData;
        try {
            // Attempt to stringify the object
            safeData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
        } catch (e) {
            // Fallback for circular structures (like raw Axios response objects)
            safeData = data?.data ? JSON.stringify(data.data, null, 2) : String(data);
        }

        const logEntry = `\n[${istTime}] ACTION: ${action}\nDATA: ${safeData}\n---------------------------------------------------`;
        fs.appendFileSync(logFile, logEntry, 'utf8');
    } catch (error) {
        console.error('Failed to write log to file:', error.message);
    }
};
