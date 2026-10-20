// The alchemyState component functions in convex-test.
/// <reference types="vite-plus/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../src/component/_generated/api.js";
import schema from "../src/component/schema.ts";

const modules = import.meta.glob("../src/component/**/*.ts");
const main = { stack: "App", stage: "main" };
const preview = { stack: "App", stage: "pr-1" };

describe("alchemyState", () => {
  it("lists stacks and stages in index order, one row for each resource", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.state.set, { ...preview, fqn: "B", value: "{}" });
    await t.mutation(api.state.set, { ...main, fqn: "B", value: "{}" });
    await t.mutation(api.state.set, { ...main, fqn: "A", value: "{}" });
    await t.mutation(api.state.set, { stack: "Other", stage: "main", fqn: "A", value: "{}" });
    await t.mutation(api.state.set, { ...main, fqn: "A", value: '{"status":"created"}' });

    expect(await t.query(api.state.stacks, {})).toEqual(["App", "Other"]);
    expect(await t.query(api.state.stages, { stack: "App" })).toEqual(["main", "pr-1"]);
    expect(await t.query(api.state.list, main)).toEqual(["A", "B"]);
    expect(await t.query(api.state.get, { ...main, fqn: "A" })).toBe('{"status":"created"}');
    expect(await t.query(api.state.get, { ...main, fqn: "C" })).toBeNull();
  });

  it("returns only the rows with status replaced", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.state.set, { ...main, fqn: "A", value: '{"status":"replaced"}' });
    await t.mutation(api.state.set, { ...main, fqn: "B", value: '{"status":"created"}' });
    await t.mutation(api.state.set, { ...main, fqn: "C", value: '"replaced"' });
    expect(await t.query(api.state.replaced, main)).toEqual(['{"status":"replaced"}']);
  });

  it("removes a row, a stage with its output, or a whole stack", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.state.set, { ...main, fqn: "A", value: "{}" });
    await t.mutation(api.state.set, { ...main, fqn: "B", value: "{}" });
    await t.mutation(api.state.set, { ...preview, fqn: "A", value: "{}" });
    await t.mutation(api.state.setOutput, { ...main, value: '{"url":"u"}' });
    await t.mutation(api.state.setOutput, { ...preview, value: '{"url":"p"}' });
    await t.mutation(api.state.setOutput, { ...preview, value: '{"url":"q"}' });
    expect(await t.query(api.state.getOutput, preview)).toBe('{"url":"q"}');

    await t.mutation(api.state.remove, { ...main, fqn: "B" });
    expect(await t.query(api.state.list, main)).toEqual(["A"]);
    await t.mutation(api.state.removeStack, preview);
    expect(await t.query(api.state.stages, { stack: "App" })).toEqual(["main"]);
    expect(await t.query(api.state.getOutput, preview)).toBeNull();
    expect(await t.query(api.state.getOutput, main)).toBe('{"url":"u"}');
    await t.mutation(api.state.removeStack, { stack: "App" });
    expect(await t.query(api.state.stacks, {})).toEqual([]);
    expect(await t.query(api.state.getOutput, main)).toBeNull();
  });
});
