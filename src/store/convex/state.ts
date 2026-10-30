// The state functions of the alchemy-state-store project of a team: one project for each
// Convex team, pushed by Convex.state() from this directory. These raw state
// functions are internal. reader.ts exposes authenticated, redacted reads.
//
// The rows are in the alchemyState component (src/store/component). Each
// function here forwards to the component function of the same name, with the
// same results; an absent `run` or `stage` goes to the component as null.
// These names and arguments are the wire contract of STORE_VERSION. Samebase
// reads `stacks`, `getOutput`, and `readStack` by name: a renamed function is
// a version bump of the store and of Samebase.
import { v } from "convex/values";
import { runRecord } from "../component/runRecord.ts";
import { stackReply } from "../component/state.ts";
import { components } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { STORE_VERSION } from "./version.ts";

const state = components.alchemyState.state;

/** The wire version of this store, compared with the client's STORE_VERSION. */
export const version = internalQuery({
  args: {},
  returns: v.number(),
  handler: async () => STORE_VERSION,
});

/** Stacks with at least one resource or one output, sorted. */
export const stacks = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: (ctx) => ctx.runQuery(state.stacks, {}),
});

/** Stages of a stack with at least one resource or one output, sorted. */
export const stages = internalQuery({
  args: { stack: v.string() },
  returns: v.array(v.string()),
  handler: (ctx, args) => ctx.runQuery(state.stages, { stack: args.stack }),
});

export const list = internalQuery({
  args: { stack: v.string(), stage: v.string() },
  returns: v.array(v.string()),
  handler: (ctx, args) => ctx.runQuery(state.list, { stack: args.stack, stage: args.stage }),
});

export const get = internalQuery({
  args: { stack: v.string(), stage: v.string(), fqn: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, args) =>
    ctx.runQuery(state.get, { stack: args.stack, stage: args.stage, fqn: args.fqn }),
});

/** Resources whose state has `status: "replaced"`. */
export const replaced = internalQuery({
  args: { stack: v.string(), stage: v.string() },
  returns: v.array(v.string()),
  handler: (ctx, args) => ctx.runQuery(state.replaced, { stack: args.stack, stage: args.stage }),
});

export const set = internalMutation({
  args: {
    stack: v.string(),
    stage: v.string(),
    fqn: v.string(),
    value: v.string(),
    run: v.optional(runRecord),
  },
  returns: v.null(),
  handler: (ctx, args) =>
    ctx.runMutation(state.set, {
      stack: args.stack,
      stage: args.stage,
      fqn: args.fqn,
      value: args.value,
      run: args.run ?? null,
    }),
});

export const remove = internalMutation({
  args: { stack: v.string(), stage: v.string(), fqn: v.string(), run: v.optional(runRecord) },
  returns: v.null(),
  handler: (ctx, args) =>
    ctx.runMutation(state.remove, {
      stack: args.stack,
      stage: args.stage,
      fqn: args.fqn,
      run: args.run ?? null,
    }),
});

/** Deletes the resources and outputs of one stage, or of every stage of the stack. */
export const removeStack = internalMutation({
  args: { stack: v.string(), stage: v.optional(v.string()) },
  returns: v.null(),
  handler: (ctx, args) =>
    ctx.runMutation(state.removeStack, { stack: args.stack, stage: args.stage ?? null }),
});

export const getOutput = internalQuery({
  args: { stack: v.string(), stage: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, args) => ctx.runQuery(state.getOutput, { stack: args.stack, stage: args.stage }),
});

export const setOutput = internalMutation({
  args: { stack: v.string(), stage: v.string(), value: v.string(), run: v.optional(runRecord) },
  returns: v.null(),
  handler: (ctx, args) =>
    ctx.runMutation(state.setOutput, {
      stack: args.stack,
      stage: args.stage,
      value: args.value,
      run: args.run ?? null,
    }),
});

/** Every stage of a stack with its resources, output, and current record, in one call. Since store version 2. */
export const readStack = internalQuery({
  args: { stack: v.string() },
  returns: stackReply,
  handler: (ctx, args) => ctx.runQuery(state.readStack, { stack: args.stack }),
});
