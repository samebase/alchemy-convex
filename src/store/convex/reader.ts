import { v, type Infer } from "convex/values";
import { env, internalMutation, query } from "./_generated/server.js";
import { readRunRecord, runRecord } from "./runRecord.ts";

const repositoryName = /^[^/]+\/[^/]+$/;

/** Only a deployment credential can exchange an approved repository for a read token. */
export const authorize = internalMutation({
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
});

const stage = v.object({
  name: v.string(),
  record: runRecord,
  deployedHeadCommit: v.union(v.string(), v.null()),
  resources: v.array(v.object({ fqn: v.string(), value: v.string() })),
  output: v.string(),
});

/** Alchemy encodes a secret as an object with __redacted__; discard that whole object's contents. */
function withoutSecrets(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) =>
    typeof value === "object" && value !== null && "__redacted__" in value
      ? { __redacted__: null }
      : value,
  );
}

/** A native subscription reads only the repository named in its verified capability. */
export const repository = query({
  args: {},
  returns: v.object({
    store: v.literal("found"),
    stacks: v.array(v.object({ name: v.string(), stages: v.array(stage) })),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (
      identity === null ||
      identity.scope !== "alchemy:read" ||
      typeof identity.repository !== "string" ||
      !repositoryName.test(identity.repository)
    ) {
      throw new Error("Alchemy repository read access is required.");
    }
    const name = identity.repository;
    // The exact name and its slash-prefixed children exclude names such as owner/app-other.
    // All four reads share the query transaction, including writes made while provisioning.
    const [rootResources, childResources, rootOutputs, childOutputs] = await Promise.all([
      ctx.db
        .query("resources")
        .withIndex("by_fqn", (q) => q.eq("stack", name))
        .collect(),
      ctx.db
        .query("resources")
        .withIndex("by_fqn", (q) => q.gte("stack", `${name}/`).lt("stack", `${name}0`))
        .collect(),
      ctx.db
        .query("outputs")
        .withIndex("by_stage", (q) => q.eq("stack", name))
        .collect(),
      ctx.db
        .query("outputs")
        .withIndex("by_stage", (q) => q.gte("stack", `${name}/`).lt("stack", `${name}0`))
        .collect(),
    ]);
    const stacks = new Map<string, Map<string, Infer<typeof stage>>>();
    for (const row of [...rootOutputs, ...childOutputs]) {
      const parsed = row.value === undefined ? null : withoutSecrets(row.value);
      const document =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
      const outputRecord =
        document !== null && "samebase.run" in document
          ? readRunRecord(document["samebase.run"])
          : null;
      const record = row.currentRun ?? outputRecord;
      if (record === null || record.repository !== name) continue;
      let output = parsed;
      if (document !== null && "samebase.run" in document) {
        const { "samebase.run": _record, ...rest } = document;
        output = rest;
      }
      let stages = stacks.get(row.stack);
      if (stages === undefined) {
        stages = new Map();
        stacks.set(row.stack, stages);
      }
      stages.set(row.stage, {
        name: row.stage,
        record,
        deployedHeadCommit: outputRecord?.repository === name ? outputRecord.headCommit : null,
        resources: [],
        output: JSON.stringify(output),
      });
    }
    for (const row of [...rootResources, ...childResources]) {
      stacks
        .get(row.stack)
        ?.get(row.stage)
        ?.resources.push({
          fqn: row.fqn,
          value: JSON.stringify(withoutSecrets(row.value)),
        });
    }
    return {
      store: "found" as const,
      stacks: [...stacks]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, stages]) => ({
          name,
          stages: [...stages.values()].sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          ),
        })),
    };
  },
});
