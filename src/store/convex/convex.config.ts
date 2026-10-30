import { defineApp } from "convex/server";
import alchemyState from "../component/convex.config.ts";

const app = defineApp();
app.use(alchemyState);

export default app;
