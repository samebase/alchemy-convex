// The functions of the state store, for each app that serves the store. Two
// apps do: the store app of this package (src/store/convex), which
// Convex.state() pushes to the samebase project of a team, and the base app of
// a team, which mounts the alchemyState component next to its own components
// in the same project. A push replaces every function of a deployment, so both
// apps serve these functions with the same names. Exported as
// `@samebase/alchemy-convex/state/functions`.
//
// Each `state:*` function forwards to the component function of the same
// name, with the same results; an absent `run` or `stage` goes to the
// component as null. These names and arguments are the wire contract of
// STORE_VERSION. Samebase reads `stacks`, `getOutput`, `readStack`, and
// `reader:repository` by name: a renamed function is a version bump of the
// store and of Samebase.
import { internalMutationGeneric, internalQueryGeneric, queryGeneric } from "convex/server";
import { type Infer, v } from "convex/values";
import type { ComponentApi } from "./component/_generated/component.js";
import { env } from "./component/_generated/server.js";
import { repositoryReply } from "./component/reader.js";
import { runRecord } from "./component/runRecord.js";
import { stackReply } from "./component/state.js";
import { STORE_VERSION } from "./convex/version.js";

/**
 * The app that serves the store. `seed`: the store app of this package, which
 * Convex.state() pushes. `base`: the base app of the team, which
 * Convex.state() never pushes over.
 */
const storeHost = v.union(v.literal("seed"), v.literal("base"));

/**
 * The internal `state:*` functions over the mounted component `alchemyState`.
 * `state:host` answers `host`, the app that serves them. Export each one
 * by name from the app's `convex/state.ts`.
 */
export const stateFunctions = (alchemyState: ComponentApi, host: Infer<typeof storeHost>) => {
  const state = alchemyState.state;
  return {
    /** The wire version of this store, compared with the client's STORE_VERSION. */
    version: internalQueryGeneric({
      args: {},
      returns: v.number(),
      handler: async () => STORE_VERSION,
    }),

    /** The app that serves this store. Convex.state() reads it before it pushes over an older store. */
    host: internalQueryGeneric({
      args: {},
      returns: storeHost,
      handler: async () => host,
    }),

    /** Stacks with at least one resource or one output, sorted. */
    stacks: internalQueryGeneric({
      args: {},
      returns: v.array(v.string()),
      handler: (ctx) => ctx.runQuery(state.stacks, {}),
    }),

    /** Stages of a stack with at least one resource or one output, sorted. */
    stages: internalQueryGeneric({
      args: { stack: v.string() },
      returns: v.array(v.string()),
      handler: (ctx, args) => ctx.runQuery(state.stages, { stack: args.stack }),
    }),

    list: internalQueryGeneric({
      args: { stack: v.string(), stage: v.string() },
      returns: v.array(v.string()),
      handler: (ctx, args) => ctx.runQuery(state.list, { stack: args.stack, stage: args.stage }),
    }),

    get: internalQueryGeneric({
      args: { stack: v.string(), stage: v.string(), fqn: v.string() },
      returns: v.union(v.string(), v.null()),
      handler: (ctx, args) =>
        ctx.runQuery(state.get, { stack: args.stack, stage: args.stage, fqn: args.fqn }),
    }),

    /** Resources whose state has `status: "replaced"`. */
    replaced: internalQueryGeneric({
      args: { stack: v.string(), stage: v.string() },
      returns: v.array(v.string()),
      handler: (ctx, args) =>
        ctx.runQuery(state.replaced, { stack: args.stack, stage: args.stage }),
    }),

    set: internalMutationGeneric({
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
    }),

    remove: internalMutationGeneric({
      args: { stack: v.string(), stage: v.string(), fqn: v.string(), run: v.optional(runRecord) },
      returns: v.null(),
      handler: (ctx, args) =>
        ctx.runMutation(state.remove, {
          stack: args.stack,
          stage: args.stage,
          fqn: args.fqn,
          run: args.run ?? null,
        }),
    }),

    /** Deletes the resources and outputs of one stage, or of every stage of the stack. */
    removeStack: internalMutationGeneric({
      args: { stack: v.string(), stage: v.optional(v.string()) },
      returns: v.null(),
      handler: (ctx, args) =>
        ctx.runMutation(state.removeStack, { stack: args.stack, stage: args.stage ?? null }),
    }),

    getOutput: internalQueryGeneric({
      args: { stack: v.string(), stage: v.string() },
      returns: v.union(v.string(), v.null()),
      handler: (ctx, args) =>
        ctx.runQuery(state.getOutput, { stack: args.stack, stage: args.stage }),
    }),

    setOutput: internalMutationGeneric({
      args: { stack: v.string(), stage: v.string(), value: v.string(), run: v.optional(runRecord) },
      returns: v.null(),
      handler: (ctx, args) =>
        ctx.runMutation(state.setOutput, {
          stack: args.stack,
          stage: args.stage,
          value: args.value,
          run: args.run ?? null,
        }),
    }),

    /** Every stage of a stack with its resources, output, and current record, in one call. Since store version 2. */
    readStack: internalQueryGeneric({
      args: { stack: v.string() },
      returns: stackReply,
      handler: (ctx, args) => ctx.runQuery(state.readStack, { stack: args.stack }),
    }),
  };
};

const repositoryName = /^[^/]+\/[^/]+$/;

/**
 * The `reader:*` functions over the mounted component `alchemyState`. Export
 * each one by name from the app's `convex/reader.ts`. They stay in the app:
 * `authorize` signs and `repository` verifies with `ctx.auth`, which a
 * component does not have. The rows and the redaction are in the component.
 * The token audience is `${CONVEX_CLOUD_URL}/alchemy-reader`, the application
 * id of authConfig.ts. CONVEX_CLOUD_URL is a system variable of the
 * deployment, the same for the app and the component, so the typed `env` of
 * the component's codegen gives it.
 */
export const readerFunctions = (alchemyState: ComponentApi) => ({
  /** Only a deployment credential can exchange an approved repository for a read token. */
  authorize: internalMutationGeneric({
    args: { repository: v.string(), subject: v.string() },
    returns: v.object({ token: v.string() }),
    handler: async (ctx, args) => {
      if (!repositoryName.test(args.repository) || args.subject === "") {
        throw new Error("A repository and subject are required.");
      }
      return {
        token: await ctx.auth.signJwt({
          expiresInSeconds: 300,
          claims: {
            sub: args.subject,
            aud: `${env.CONVEX_CLOUD_URL}/alchemy-reader`,
            repository: args.repository,
            scope: "alchemy:read",
          },
        }),
      };
    },
  }),

  /** A native subscription reads only the repository named in its verified capability. */
  repository: queryGeneric({
    args: {},
    returns: repositoryReply,
    handler: async (ctx) => {
      const identity = await ctx.auth.getUserIdentity();
      // Only a token of the deployment's own issuer reads, the one that `authorize` signs: a base
      // can accept other providers too, and a token of one of those with the same claims does not.
      if (
        identity === null ||
        identity.issuer !== env.CONVEX_CLOUD_URL ||
        identity.scope !== "alchemy:read" ||
        typeof identity.repository !== "string" ||
        !repositoryName.test(identity.repository)
      ) {
        throw new Error("Alchemy repository read access is required.");
      }
      return await ctx.runQuery(alchemyState.reader.repository, {
        repository: identity.repository,
      });
    },
  }),
});
