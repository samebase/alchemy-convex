import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/RunRecord.ts";
import { api, internal } from "../src/store/convex/_generated/api.js";
import { storeTest } from "./storeTest.ts";

const run: RunRecord = {
  version: 1,
  repository: "samebase/app",
  stackFile: "alchemy.run.ts",
  branch: "main",
  pullRequest: null,
  headCommit: "new-commit",
  runUrl: null,
  source: "laptop",
  recordedAt: "2026-10-24T10:00:00.000Z",
};
const identity = { subject: "reader", scope: "alchemy:read", repository: run.repository };

describe("repository reader", () => {
  it("denies anonymous, malformed, and wrong-scope identities", async () => {
    const t = storeTest();
    await expect(t.query(api.reader.repository, {})).rejects.toThrow("read access");
    for (const claims of [
      { ...identity, scope: "other" },
      { ...identity, repository: "samebase" },
      { ...identity, repository: 1 },
      { subject: "reader", repository: run.repository },
    ]) {
      await expect(t.withIdentity(claims).query(api.reader.repository, {})).rejects.toThrow(
        "read access",
      );
    }
  });

  it("includes exact and child stacks only, with deterministic order and no redacted content", async () => {
    const t = storeTest();
    for (const stack of [
      "samebase/app/z",
      "samebase/app-other",
      "other/app",
      "samebase/app",
      "samebase/app/a",
    ]) {
      for (const stage of ["pr-2", "main"]) {
        await t.mutation(internal.state.setOutput, {
          stack,
          stage,
          run,
          value: JSON.stringify({
            "samebase.run": { ...run, extra: "excluded-record-field" },
            array: [1, { secret: { __redacted__: "secret-output", extra: "discarded-sibling" } }],
          }),
        });
        for (const fqn of ["Z", "A"]) {
          await t.mutation(internal.state.set, {
            stack,
            stage,
            fqn,
            run,
            value: JSON.stringify({
              status: "created",
              props: { token: { __redacted__: "secret-resource", extra: "discarded-sibling" } },
            }),
          });
        }
      }
    }
    const reply = await t.withIdentity(identity).query(api.reader.repository, {});
    expect(reply.stacks.map((stack) => stack.name)).toEqual([
      "samebase/app",
      "samebase/app/a",
      "samebase/app/z",
    ]);
    for (const stack of reply.stacks) {
      expect(stack.stages.map((stage) => stage.name)).toEqual(["main", "pr-2"]);
      for (const stage of stack.stages) {
        expect(stage.resources.map((resource) => resource.fqn)).toEqual(["A", "Z"]);
        expect(JSON.parse(stage.output)).toEqual({
          array: [1, { secret: { __redacted__: null } }],
        });
        expect(stage.resources.map((resource) => JSON.parse(resource.value))).toEqual([
          { status: "created", props: { token: { __redacted__: null } } },
          { status: "created", props: { token: { __redacted__: null } } },
        ]);
      }
    }
    expect(JSON.stringify(reply)).not.toMatch(
      /secret-output|secret-resource|discarded-sibling|excluded-record-field/,
    );
    expect(
      await t
        .withIdentity({ ...identity, repository: "absent/app" })
        .query(api.reader.repository, {}),
    ).toEqual({ store: "found", stacks: [] });
  });

  it("shows the first write before output, and separates the current run from the deployed commit", async () => {
    const t = storeTest();
    const reader = t.withIdentity(identity);
    await t.mutation(internal.state.set, {
      stack: run.repository,
      stage: "main",
      fqn: "Worker",
      value: "{}",
      run,
    });
    expect(
      await t.query(internal.state.getOutput, { stack: run.repository, stage: "main" }),
    ).toBeNull();
    expect(await t.query(internal.state.readStack, { stack: run.repository })).toEqual({
      stages: [
        { stage: "main", record: run, resources: [{ fqn: "Worker", value: "{}" }], output: null },
      ],
    });
    expect((await reader.query(api.reader.repository, {})).stacks[0]?.stages[0]).toMatchObject({
      record: run,
      deployedHeadCommit: null,
      output: "null",
    });
    const previous = { ...run, headCommit: "previous-commit" };
    await t.mutation(internal.state.setOutput, {
      stack: run.repository,
      stage: "main",
      value: JSON.stringify({ "samebase.run": previous, url: "https://example.test" }),
      run: previous,
    });
    await t.mutation(internal.state.set, {
      stack: run.repository,
      stage: "main",
      fqn: "Worker",
      value: '{"status":"updating"}',
      run,
    });
    expect((await reader.query(api.reader.repository, {})).stacks[0]?.stages[0]).toMatchObject({
      record: run,
      deployedHeadCommit: "previous-commit",
    });
    await t.mutation(internal.state.setOutput, {
      stack: run.repository,
      stage: "main",
      value: JSON.stringify({ "samebase.run": run }),
      run,
    });
    expect(
      (await reader.query(api.reader.repository, {})).stacks[0]?.stages[0]?.deployedHeadCommit,
    ).toBe("new-commit");
    await t.mutation(internal.state.remove, {
      stack: run.repository,
      stage: "main",
      fqn: "Worker",
      run,
    });
    expect((await reader.query(api.reader.repository, {})).stacks[0]?.stages[0]?.resources).toEqual(
      [],
    );
    await t.mutation(internal.state.removeStack, { stack: run.repository, stage: "main" });
    expect(await reader.query(api.reader.repository, {})).toEqual({ store: "found", stacks: [] });
    expect(await t.query(internal.state.stacks, {})).toEqual([]);
    await t.mutation(internal.state.set, {
      stack: run.repository,
      stage: "main",
      fqn: "Worker",
      value: "{}",
      run: { ...run, repository: "other/app" },
    });
    expect(await reader.query(api.reader.repository, {})).toEqual({ store: "found", stacks: [] });
  });

  it("hides a stage after a write without a run record", async () => {
    const t = storeTest();
    const reader = t.withIdentity(identity);
    await t.mutation(internal.state.set, {
      stack: run.repository,
      stage: "main",
      fqn: "Worker",
      value: "{}",
      run,
    });
    expect((await reader.query(api.reader.repository, {})).stacks).toHaveLength(1);
    await t.mutation(internal.state.set, {
      stack: run.repository,
      stage: "main",
      fqn: "Worker",
      value: "{}",
    });
    expect(await reader.query(api.reader.repository, {})).toEqual({ store: "found", stacks: [] });
    expect(await t.query(internal.state.readStack, { stack: run.repository })).toMatchObject({
      stages: [{ stage: "main", record: null }],
    });
  });

  it("preserves arbitrary JSON output while removing nested secrets", async () => {
    const t = storeTest();
    for (const value of [null, "text", 1, false, [1, { __redacted__: "private" }]]) {
      await t.mutation(internal.state.setOutput, {
        stack: run.repository,
        stage: "main",
        value: JSON.stringify(value),
        run,
      });
      const stage = (await t.withIdentity(identity).query(api.reader.repository, {})).stacks[0]
        ?.stages[0];
      expect(stage?.output).toBe(
        JSON.stringify(Array.isArray(value) ? [1, { __redacted__: null }] : value),
      );
      expect(stage?.deployedHeadCommit).toBeNull();
    }
    // A stack can put its own value under the key: it is not a run record.
    await t.mutation(internal.state.setOutput, {
      stack: run.repository,
      stage: "main",
      value: JSON.stringify({ "samebase.run": { ...run, headCommit: 1 } }),
      run,
    });
    expect(
      (await t.withIdentity(identity).query(api.reader.repository, {})).stacks[0]?.stages[0],
    ).toMatchObject({ output: "{}", deployedHeadCommit: null });
  });
});
