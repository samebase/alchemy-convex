// The redacted read of one repository. The app checks the reader's verified
// token and passes the repository that the token names: a component has no
// `ctx.auth`.
import { v, type Infer } from "convex/values";
import { query } from "./_generated/server.js";
import { runRecord, validate } from "./runRecord.js";

const stage = v.object({
  name: v.string(),
  record: runRecord,
  deployedHeadCommit: v.union(v.string(), v.null()),
  resources: v.array(v.object({ fqn: v.string(), value: v.string() })),
  output: v.string(),
});

/** The reply of {@link repository}. */
export const repositoryReply = v.object({
  store: v.literal("found"),
  stacks: v.array(v.object({ name: v.string(), stages: v.array(stage) })),
});

/** Alchemy encodes a secret as an object with __redacted__; discard that whole object's contents. */
function withoutSecrets(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) =>
    typeof value === "object" && value !== null && "__redacted__" in value
      ? { __redacted__: null }
      : value,
  );
}

/** The stacks of `repository`: the stack of that name and the stacks below `repository + "/"`. */
export const repository = query({
  args: { repository: v.string() },
  returns: repositoryReply,
  handler: async (ctx, args) => {
    const name = args.repository;
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
      const record = row.currentRun;
      if (record === undefined || record.repository !== name) continue;
      // The output keeps the record of the last completed deploy under `samebase.run`.
      let output = row.value === undefined ? null : withoutSecrets(row.value);
      let deployed: unknown = null;
      if (typeof output === "object" && output !== null && "samebase.run" in output) {
        ({ "samebase.run": deployed, ...output } = output);
      }
      let stages = stacks.get(row.stack);
      if (stages === undefined) {
        stages = new Map();
        stacks.set(row.stack, stages);
      }
      stages.set(row.stage, {
        name: row.stage,
        record,
        deployedHeadCommit:
          validate(runRecord, deployed) && deployed.repository === name
            ? deployed.headCommit
            : null,
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
