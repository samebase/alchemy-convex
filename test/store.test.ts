// The store functions of src/store/convex and its alchemyState component in convex-test.
import { describe, expect, it } from "vitest";
import { internal } from "../src/store/convex/_generated/api.js";
import { STORE_VERSION } from "../src/store/convex/version.ts";
import { storeTest } from "./storeTest.ts";

const main = { stack: "samebase/app", stage: "main" };
const preview = { stack: "samebase/app", stage: "pr-1" };

describe("the state store", () => {
  it("answers its wire version", async () => {
    const t = storeTest();
    expect(await t.query(internal.state.version, {})).toBe(STORE_VERSION);
  });

  it("does not read a row of store version 3, which sits in a root table", async () => {
    const t = storeTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("resources", { ...main, fqn: "Project", value: "{}" });
      await ctx.db.insert("outputs", { ...main, value: '{"url":"u"}' });
    });
    expect(await t.query(internal.state.stacks, {})).toEqual([]);
    expect(await t.query(internal.state.getOutput, main)).toBeNull();
    await t.mutation(internal.state.set, { ...main, fqn: "Project", value: "{}" });
    expect(await t.query(internal.state.stacks, {})).toEqual(["samebase/app"]);
  });

  it("lists stacks and stages in index order, one row for each resource", async () => {
    const t = storeTest();
    await t.mutation(internal.state.set, { ...preview, fqn: "B", value: "{}" });
    await t.mutation(internal.state.set, { ...main, fqn: "B", value: "{}" });
    await t.mutation(internal.state.set, { ...main, fqn: "A", value: "{}" });
    await t.mutation(internal.state.set, {
      stack: "samebase/other",
      stage: "main",
      fqn: "A",
      value: "{}",
    });
    await t.mutation(internal.state.set, { ...main, fqn: "A", value: '{"status":"created"}' });

    expect(await t.query(internal.state.stacks, {})).toEqual(["samebase/app", "samebase/other"]);
    expect(await t.query(internal.state.stages, { stack: "samebase/app" })).toEqual([
      "main",
      "pr-1",
    ]);
    expect(await t.query(internal.state.list, main)).toEqual(["A", "B"]);
    expect(await t.query(internal.state.get, { ...main, fqn: "A" })).toBe('{"status":"created"}');
    expect(await t.query(internal.state.get, { ...main, fqn: "C" })).toBeNull();
  });

  it("lists a stage and its stack from an output alone", async () => {
    const t = storeTest();
    await t.mutation(internal.state.setOutput, {
      stack: "samebase/empty",
      stage: "main",
      value: "{}",
    });
    await t.mutation(internal.state.set, { ...main, fqn: "A", value: "{}" });
    await t.mutation(internal.state.setOutput, { ...preview, value: "{}" });
    expect(await t.query(internal.state.stacks, {})).toEqual(["samebase/app", "samebase/empty"]);
    expect(await t.query(internal.state.stages, { stack: "samebase/app" })).toEqual([
      "main",
      "pr-1",
    ]);
    expect(await t.query(internal.state.stages, { stack: "samebase/empty" })).toEqual(["main"]);
    await t.mutation(internal.state.removeStack, { stack: "samebase/empty" });
    expect(await t.query(internal.state.stacks, {})).toEqual(["samebase/app"]);
  });

  it("returns only the rows with status replaced", async () => {
    const t = storeTest();
    await t.mutation(internal.state.set, { ...main, fqn: "A", value: '{"status":"replaced"}' });
    await t.mutation(internal.state.set, { ...main, fqn: "B", value: '{"status":"created"}' });
    await t.mutation(internal.state.set, { ...main, fqn: "C", value: '"replaced"' });
    expect(await t.query(internal.state.replaced, main)).toEqual(['{"status":"replaced"}']);
  });

  it("removes a row, a stage with its output, or a whole stack", async () => {
    const t = storeTest();
    await t.mutation(internal.state.set, { ...main, fqn: "A", value: "{}" });
    await t.mutation(internal.state.set, { ...main, fqn: "B", value: "{}" });
    await t.mutation(internal.state.set, { ...preview, fqn: "A", value: "{}" });
    await t.mutation(internal.state.setOutput, { ...main, value: '{"url":"u"}' });
    await t.mutation(internal.state.setOutput, { ...preview, value: '{"url":"p"}' });
    await t.mutation(internal.state.setOutput, { ...preview, value: '{"url":"q"}' });
    expect(await t.query(internal.state.getOutput, preview)).toBe('{"url":"q"}');

    await t.mutation(internal.state.remove, { ...main, fqn: "B" });
    expect(await t.query(internal.state.list, main)).toEqual(["A"]);
    await t.mutation(internal.state.removeStack, preview);
    expect(await t.query(internal.state.stages, { stack: "samebase/app" })).toEqual(["main"]);
    expect(await t.query(internal.state.getOutput, preview)).toBeNull();
    expect(await t.query(internal.state.getOutput, main)).toBe('{"url":"u"}');
    await t.mutation(internal.state.removeStack, { stack: "samebase/app" });
    expect(await t.query(internal.state.stacks, {})).toEqual([]);
    expect(await t.query(internal.state.getOutput, main)).toBeNull();
  });

  it("reads every stage of a stack in one call, in stage and fqn order", async () => {
    const t = storeTest();
    expect(await t.query(internal.state.readStack, { stack: "samebase/app" })).toEqual({
      stages: [],
    });
    await t.mutation(internal.state.set, { ...preview, fqn: "B", value: '{"b":1}' });
    await t.mutation(internal.state.set, { ...main, fqn: "B", value: '{"b":0}' });
    await t.mutation(internal.state.set, { ...main, fqn: "A", value: '{"a":0}' });
    await t.mutation(internal.state.setOutput, { ...main, value: '{"url":"u"}' });
    await t.mutation(internal.state.setOutput, {
      stack: "samebase/app",
      stage: "empty",
      value: '{"url":"e"}',
    });
    await t.mutation(internal.state.set, {
      stack: "samebase/other",
      stage: "main",
      fqn: "A",
      value: "{}",
    });
    expect(await t.query(internal.state.readStack, { stack: "samebase/app" })).toEqual({
      stages: [
        { stage: "empty", resources: [], output: '{"url":"e"}', record: null },
        {
          stage: "main",
          resources: [
            { fqn: "A", value: '{"a":0}' },
            { fqn: "B", value: '{"b":0}' },
          ],
          output: '{"url":"u"}',
          record: null,
        },
        { stage: "pr-1", resources: [{ fqn: "B", value: '{"b":1}' }], output: null, record: null },
      ],
    });
  });
});
