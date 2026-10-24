// The state functions of the alchemy-state project: one project for each
// Convex team, pushed by Convex.state() from this directory. These raw state
// functions are internal. reader.ts exposes authenticated, redacted reads.
//
// A stage holds one row for each resource of its stack, so the reads of one
// stage collect all rows. Samebase reads `stacks`, `getOutput`, and
// `readStack` by name: a renamed function is a version bump of the store and
// of Samebase.
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { runRecord } from "./runRecord.ts";
import type { RunRecord } from "../../RunRecord.ts";
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

/** A resource write and its current run become visible in one transaction. */
const writeCurrentRun = async (
  ctx: MutationCtx,
  args: { stack: string; stage: string; run?: RunRecord | undefined },
) => {
  if (args.run === undefined) return;
  const output = await outputOf(ctx, args);
  if (output === null)
    await ctx.db.insert("outputs", { stack: args.stack, stage: args.stage, currentRun: args.run });
  else await ctx.db.patch("outputs", output._id, { currentRun: args.run });
};

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
  args: { ...resource, value: v.string(), run: v.optional(runRecord) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args);
    if (row === null)
      await ctx.db.insert("resources", {
        stack: args.stack,
        stage: args.stage,
        fqn: args.fqn,
        value: args.value,
      });
    else await ctx.db.patch("resources", row._id, { value: args.value });
    await writeCurrentRun(ctx, args);
    return null;
  },
});

export const remove = internalMutation({
  args: { ...resource, run: v.optional(runRecord) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args);
    if (row !== null) await ctx.db.delete("resources", row._id);
    await writeCurrentRun(ctx, args);
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
  args: { ...stage, value: v.string(), run: v.optional(runRecord) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await outputOf(ctx, args);
    if (row === null)
      await ctx.db.insert("outputs", { stack: args.stack, stage: args.stage, value: args.value });
    else await ctx.db.patch("outputs", row._id, { value: args.value });
    await writeCurrentRun(ctx, args);
    return null;
  },
});

/**
 * One call for a reader: every stage of a stack in name order, each with its
 * resources in fqn order and its output, as the JSON texts that the rows
 * hold. A stage with an output and no resource is listed with an empty
 * resource list; a stage with resources and no output with `output: null`.
 * One function reads at most 16 MiB (Convex limit): a stack whose rows go
 * beyond that fails here and is read with `stages`, `list`, `get`, and
 * `getOutput` instead. Since store version 2.
 */
export const readStack = internalQuery({
  args: { stack: v.string() },
  returns: v.object({
    stages: v.array(
      v.object({
        stage: v.string(),
        resources: v.array(v.object({ fqn: v.string(), value: v.string() })),
        output: v.union(v.string(), v.null()),
        record: v.union(runRecord, v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    // Both indexes order by stack, then stage, then (for resources) fqn.
    const resources = await ctx.db
      .query("resources")
      .withIndex("by_fqn", (q) => q.eq("stack", args.stack))
      .collect();
    const outputs = await ctx.db
      .query("outputs")
      .withIndex("by_stage", (q) => q.eq("stack", args.stack))
      .collect();
    const stages = union(
      [...new Set(resources.map((row) => row.stage))],
      [...new Set(outputs.map((row) => row.stage))],
    );
    return {
      stages: stages.map((stage) => {
        const output = outputs.find((row) => row.stage === stage);
        return {
          stage,
          resources: resources
            .filter((row) => row.stage === stage)
            .map((row) => ({ fqn: row.fqn, value: row.value })),
          output: output?.value ?? null,
          record: output?.currentRun ?? null,
        };
      }),
    };
  },
});
