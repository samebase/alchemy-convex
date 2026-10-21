// The state functions of the alchemy-state project: one project for each
// Convex team, pushed by Convex.state() from this directory. Every function
// is internal: a public function of a root app answers anyone who knows the
// deployment URL, with no key (measured). An internal function answers only
// POST /api/function with a deploy key of the production deployment, the
// call that `convex run` makes.
//
// A stage holds one row for each resource of its stack, so the reads of one
// stage collect all rows. The function names are a wire contract: Samebase
// reads `stacks` and `getOutput` by name, and an older client calls an older
// set of names. Add functions; never rename or remove one.
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { STORE_VERSION } from "./version.ts";

/** The wire version of this store, compared with the client's STORE_VERSION. */
export const version = internalQuery({
  args: {},
  returns: v.number(),
  handler: async () => STORE_VERSION,
});

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

/** The sorted union of two lists of names. */
const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])].sort();

/**
 * The distinct names of one table in index order, with one index read for
 * each name: `first(after)` is the first row whose name is above `after`.
 */
const distinct = async (first: (after: string | undefined) => Promise<string | null>) => {
  const names: string[] = [];
  for (;;) {
    const next = await first(names.at(-1));
    if (next === null) return names;
    names.push(next);
  }
};

/** Stacks with at least one resource or one output, sorted. */
export const stacks = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) =>
    union(
      await distinct(
        async (after) =>
          (
            await ctx.db
              .query("resources")
              .withIndex("by_fqn", (q) => (after === undefined ? q : q.gt("stack", after)))
              .first()
          )?.stack ?? null,
      ),
      await distinct(
        async (after) =>
          (
            await ctx.db
              .query("outputs")
              .withIndex("by_stage", (q) => (after === undefined ? q : q.gt("stack", after)))
              .first()
          )?.stack ?? null,
      ),
    ),
});

/** Stages of a stack with at least one resource or one output, sorted. */
export const stages = internalQuery({
  args: { stack: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) =>
    union(
      await distinct(
        async (after) =>
          (
            await ctx.db
              .query("resources")
              .withIndex("by_fqn", (q) =>
                after === undefined
                  ? q.eq("stack", args.stack)
                  : q.eq("stack", args.stack).gt("stage", after),
              )
              .first()
          )?.stage ?? null,
      ),
      await distinct(
        async (after) =>
          (
            await ctx.db
              .query("outputs")
              .withIndex("by_stage", (q) =>
                after === undefined
                  ? q.eq("stack", args.stack)
                  : q.eq("stack", args.stack).gt("stage", after),
              )
              .first()
          )?.stage ?? null,
      ),
    ),
});

export const list = internalQuery({
  args: stage,
  returns: v.array(v.string()),
  handler: async (ctx, args) => (await rowsOf(ctx, args)).map((row) => row.fqn),
});

export const get = internalQuery({
  args: resource,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => (await rowOf(ctx, args))?.value ?? null,
});

/** Resources whose state has `status: "replaced"`. */
export const replaced = internalQuery({
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

export const set = internalMutation({
  args: { ...resource, value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args);
    if (row === null) await ctx.db.insert("resources", args);
    else await ctx.db.patch("resources", row._id, { value: args.value });
    return null;
  },
});

export const remove = internalMutation({
  args: resource,
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args);
    if (row !== null) await ctx.db.delete("resources", row._id);
    return null;
  },
});

/** Deletes the resources and outputs of one stage, or of every stage of the stack. */
export const removeStack = internalMutation({
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

export const getOutput = internalQuery({
  args: stage,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => (await outputOf(ctx, args))?.value ?? null,
});

export const setOutput = internalMutation({
  args: { ...stage, value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await outputOf(ctx, args);
    if (row === null) await ctx.db.insert("outputs", args);
    else await ctx.db.patch("outputs", row._id, { value: args.value });
    return null;
  },
});
