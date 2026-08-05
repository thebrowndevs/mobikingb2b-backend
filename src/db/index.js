import mongoose from "mongoose";
import { DB_NAME } from "../constants.js";
import { initCounter } from "../utils/counter.js";


const connectDB = async () => {
    try {
        let connectionURI = process.env.MONGODB_URI || "";
        if (connectionURI.endsWith("/")) {
            connectionURI = connectionURI.slice(0, -1);
        }
        
        const dbName = process.env.DB_NAME || DB_NAME;
        const urlParts = connectionURI.split('/');
        const hasDbName = urlParts.length > 3 && urlParts[3].split('?')[0] !== "";
        
        if (!hasDbName && dbName) {
            connectionURI = `${connectionURI}/${dbName}`;
        }

        const connectionInstance = await mongoose.connect(connectionURI);
        await initCounter();
        console.log(`\n MongoDB Database: ${dbName}`);
        console.log(`\n MongoDB connected !! DB HOST: ${connectionInstance.connection.host}`);
    } catch (error) {
        console.log("MONGODB connection FAILED ", error);
        process.exit(1)
    }
}

export default connectDB