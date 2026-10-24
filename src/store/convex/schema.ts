import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { runRecord } from "./runRecord.ts";

// `value` is the JSON text of Alchemy's encodeState(...): the same text that
// Alchemy's local state writes to a file. A Convex object would reject keys
// that Alchemy state can hold, such as keys that start with "$".
export default defineSchema({
  resources: defineTable({
    stack: v.string(),
    stage: v.string(),
    fqn: v.string(),
    value: v.string(),
  }).index("by_fqn", ["stack", "stage", "fqn"]),
  outputs: defineTable({
    stack: v.string(),
    stage: v.string(),
    value: v.optional(v.string()),
    currentRun: v.optional(runRecord),
  }).index("by_stage", ["stack", "stage"]),
});
