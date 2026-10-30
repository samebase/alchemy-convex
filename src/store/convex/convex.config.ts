import { defineApp } from "convex/server";
import alchemyState from "../component/convex.config.js";

const app = defineApp();
app.use(alchemyState);

export default app;
