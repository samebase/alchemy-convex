import { authConfig } from "../authConfig.js";
import { env } from "./_generated/server.js";

export default authConfig(env.CONVEX_CLOUD_URL);
