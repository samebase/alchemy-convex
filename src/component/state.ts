// The state functions. A component function is not part of the public API of
// the app: only POST /api/function with a deploy key reaches it, and that key
// needs `deployment:data:view` for a query and `deployment:data:write` for a
// mutation (measured).
//
// A stage holds one row for each resource of its stack, so the reads of one
// stage collect all rows.
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";

const stage = { stack: v.string(), stage: v.string() };
const resource = { ...stage, fqn: v.string() };

const rowOf = (ctx: QueryCtx, args: { stack: string; stage: string; fqn: string }) =>
  ctx.db
    .query("resources")
    .withIndex("by_fqn", (q) =>
      q.eq("stack", args.stack).eq("stage", args.stage).eq("fqn", args.fqn),
    )
    .unique();

const rowsOf = (ctx: QueryCtx, args: { stack: string; stage: string }) =>
  ctx.db
    .query("resources")
    .withIndex("by_fqn", (q) => q.eq("stack", args.stack).eq("stage", args.stage))
    .collect();

const outputOf = (ctx: QueryCtx, args: { stack: string; stage: string }) =>
  ctx.db
    .query("outputs")
    .withIndex("by_stage", (q) => q.eq("stack", args.stack).eq("stage", args.stage))
    .unique();

/** Stacks with at least one resource, in index order: one index read for each stack. */
export const stacks = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const names: string[] = [];
    for (;;) {
      const last = names.at(-1);
      const next = await ctx.db
        .query("resources")
        .withIndex("by_fqn", (q) => (last === undefined ? q : q.gt("stack", last)))
        .first();
      if (next === null) return names;
      names.push(next.stack);
    }
  },
});

/** Stages of a stack with at least one resource, in index order. */
export const stages = query({
  args: { stack: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const names: string[] = [];
    for (;;) {
      const last = names.at(-1);
      const next = await ctx.db
        .query("resources")
        .withIndex("by_fqn", (q) =>
          last === undefined
            ? q.eq("stack", args.stack)
            : q.eq("stack", args.stack).gt("stage", last),
        )
        .first();
      if (next === null) return names;
      names.push(next.stage);
    }
  },
});

export const list = query({
  args: stage,
  returns: v.array(v.string()),
  handler: async (ctx, args) => (await rowsOf(ctx, args)).map((row) => row.fqn),
});

export const get = query({
  args: resource,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => (await rowOf(ctx, args))?.value ?? null,
});

/** Resources whose state has `status: "replaced"`. */
export const replaced = query({
  args: stage,
  returns: v.array(v.string()),
  handler: async (ctx, args) =>
    (await rowsOf(ctx, args))
      .map((row) => row.value)
      .filter((value) => {
        const parsed: unknown = JSON.parse(value);
        return (
          typeof parsed === "object" &&
          parsed !== null &&
          "status" in parsed &&
          parsed.status === "replaced"
        );
      }),
});

export const set = mutation({
  args: { ...resource, value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args);
    if (row === null) await ctx.db.insert("resources", args);
    else await ctx.db.patch("resources", row._id, { value: args.value });
    return null;
  },
});

export const remove = mutation({
  args: resource,
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args);
    if (row !== null) await ctx.db.delete("resources", row._id);
    return null;
  },
});

/** Deletes the resources and outputs of one stage, or of every stage of the stack. */
export const removeStack = mutation({
  args: { stack: v.string(), stage: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { stack } = args;
    const resources = await ctx.db
      .query("resources")
      .withIndex("by_fqn", (q) =>
        args.stage === undefined
          ? q.eq("stack", stack)
          : q.eq("stack", stack).eq("stage", args.stage),
      )
      .collect();
    const outputs = await ctx.db
      .query("outputs")
      .withIndex("by_stage", (q) =>
        args.stage === undefined
          ? q.eq("stack", stack)
          : q.eq("stack", stack).eq("stage", args.stage),
      )
      .collect();
    for (const row of resources) await ctx.db.delete("resources", row._id);
    for (const row of outputs) await ctx.db.delete("outputs", row._id);
    return null;
  },
});

export const getOutput = query({
  args: stage,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => (await outputOf(ctx, args))?.value ?? null,
});

export const setOutput = mutation({
  args: { ...stage, value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await outputOf(ctx, args);
    if (row === null) await ctx.db.insert("outputs", args);
    else await ctx.db.patch("outputs", row._id, { value: args.value });
    return null;
  },
});
