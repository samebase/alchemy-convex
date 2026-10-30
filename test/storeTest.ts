// The store app of src/store/convex in convex-test, with the alchemyState
// component of src/store/component mounted as the app's convex.config.ts does.
/// <reference types="vite-plus/client" />
import { convexTest } from "convex-test";
import schema from "../src/store/component/schema.ts";

const app = import.meta.glob("../src/store/convex/**/*.ts");
const component = import.meta.glob("../src/store/component/**/*.ts");

export const storeTest = () => {
  const t = convexTest({ modules: app });
  t.registerComponent("alchemyState", schema, component);
  return t;
};
