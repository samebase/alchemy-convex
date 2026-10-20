// Convex.state against a fake deployment behind a stubbed `fetch`. The fake
// keeps the alchemyState rows in memory. Every reply is a recorded payload
// from fixtures/state with only the value changed.
import { readFileSync } from "node:fs";
import { type CreatedResourceState, type CreatingResourceState, State } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConvexState, makeFunctionApi, state } from "../src/State.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/state/${file}`, import.meta.url), "utf8"));
const Fields = Schema.Record(Schema.String, Schema.Unknown);
const recorded = (file: string) => Schema.decodeUnknownSync(Fields)(fixture(file));

const URL_ = Schema.decodeUnknownSync(Schema.String)(fixture("url_for_key.json"));
const KEY = "prod:fine-cow-747|test-secret";

const Call = Schema.Struct({
  componentPath: Schema.optionalKey(Schema.String),
  path: Schema.String,
  args: Schema.Record(Schema.String, Schema.String),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Row {
  readonly stack: string;
  readonly stage: string;
  readonly fqn: string;
  readonly value: string;
}

class FakeDeployment {
  /** The mount of alchemyState in the component list: undefined until a push. */
  mount: "active" | "unmounted" | undefined = "active";
  /** A recorded error reply for every component call, such as a missing key action. */
  error: unknown;
  rows: Row[] = [];
  readonly outputs = new Map<string, string>();
  /** The component functions that ran, in order. */
  readonly calls: string[] = [];
  readonly authorizations = new Set<string>();

  install() {
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => this.fetch(input, init));
    return this;
  }

  private fetch(input: string, init: RequestInit) {
    const body: unknown = JSON.parse(typeof init.body === "string" ? init.body : "null");
    if (input === "https://api.convex.dev/api/deployment/url_for_key") {
      return Promise.resolve(json(200, fixture("url_for_key.json")));
    }
    this.authorizations.add(new Headers(init.headers).get("Authorization") ?? "");
    const call = Schema.decodeUnknownSync(Call)(body);
    if (input === `${URL_}/api/query` && call.path === "_system/frontend/components:list") {
      return Promise.resolve(json(200, this.components()));
    }
    if (input === `${URL_}/api/function` && call.componentPath === "alchemyState") {
      if (this.mount !== "active")
        return Promise.resolve(json(500, fixture("function_component_missing.json")));
      if (this.error !== undefined) return Promise.resolve(json(200, this.error));
      this.calls.push(call.path);
      return Promise.resolve(
        json(200, { ...recorded("function_list.json"), value: this.run(call.path, call.args) }),
      );
    }
    return Promise.resolve(json(404, { code: "NotFound", message: `fake: ${input}` }));
  }

  private components() {
    const reply = recorded("components_list_unmounted.json");
    const rows = Schema.decodeUnknownSync(Schema.Array(Fields))(reply["value"]);
    const [root, component] = rows;
    if (this.mount === undefined) return recorded("components_list_empty.json");
    return { ...reply, value: [root, { ...component, state: this.mount }] };
  }

  private run(path: string, args: Record<string, string>) {
    const { stack, stage, fqn, value = "" } = args;
    const inStage = (row: Row) => row.stack === stack && row.stage === stage;
    const index = this.rows.findIndex((row) => inStage(row) && row.fqn === fqn);
    const output = `${stack}/${stage}`;
    switch (path) {
      case "state:stacks":
        return [...new Set(this.rows.map((row) => row.stack))];
      case "state:stages":
        return [...new Set(this.rows.filter((row) => row.stack === stack).map((row) => row.stage))];
      case "state:list":
        return this.rows.filter(inStage).map((row) => row.fqn);
      case "state:get":
        return this.rows[index]?.value ?? null;
      case "state:set": {
        const row = this.rows[index];
        if (row === undefined)
          this.rows.push({ stack: stack ?? "", stage: stage ?? "", fqn: fqn ?? "", value });
        else this.rows[index] = { ...row, value };
        return null;
      }
      case "state:remove":
        if (index >= 0) this.rows.splice(index, 1);
        return null;
      case "state:removeStack":
        this.rows = this.rows.filter((row) => !inStage(row));
        this.outputs.delete(output);
        return null;
      case "state:getOutput":
        return this.outputs.get(output) ?? null;
      case "state:setOutput":
        this.outputs.set(output, value);
        return null;
      default:
        throw new Error(`fake: ${path}`);
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const where = { stack: "App", stage: "main" };
/** The row of fixtures/state/function_get.json, which the live run wrote. */
const created = (props: Record<string, unknown> = {}): CreatedResourceState => ({
  status: "created",
  fqn: "Deployment",
  logicalId: "Deployment",
  instanceId: "9058feab6047cbbe014a3530ca68230f",
  resourceType: "Convex.Deployment",
  namespace: undefined,
  providerVersion: 0,
  downstream: [],
  bindings: [],
  props: { project: { projectId: 3246004 }, type: "prod", source: "./convex", ...props },
  attr: { name: "fine-cow-747", url: "https://fine-cow-747.convex.cloud" },
});
const creating = (): CreatingResourceState => ({ ...created(), status: "creating" });

const open = makeConvexState(makeFunctionApi(URL_, Redacted.make(KEY)));
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
/** The rendered failure of `effect`, or "" when it succeeds. */
const failureOf = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
};

describe("Convex.state", () => {
  it("reads and writes rows of the component with the deploy key", async () => {
    const fake = new FakeDeployment().install();
    const secret = Redacted.make("an env value");
    const store = await run(open);
    await run(store.set({ ...where, fqn: "Deployment", value: created({ env: { A: secret } }) }));
    await run(store.setOutput({ ...where, value: { url: "https://fine-cow-747.convex.cloud" } }));

    // A Redacted value comes back as a Redacted value, like Alchemy's other stores.
    const read = Schema.decodeUnknownSync(
      Schema.Struct({
        status: Schema.String,
        props: Schema.Struct({ env: Schema.Struct({ A: Schema.Unknown }) }),
      }),
    )(await run(store.get({ ...where, fqn: "Deployment" })));
    expect(read.status).toBe("created");
    const value = read.props.env.A;
    expect(Redacted.isRedacted(value) && Redacted.value(value)).toBe("an env value");
    expect(await run(store.list(where))).toEqual(["Deployment"]);
    expect(await run(store.listStacks())).toEqual(["App"]);
    expect(await run(store.listStages("App"))).toEqual(["main"]);
    expect(await run(store.getOutput(where))).toEqual({ url: "https://fine-cow-747.convex.cloud" });
    expect([...fake.authorizations]).toEqual([`Convex ${KEY}`]);

    await run(store.deleteStack(where));
    expect(await run(store.list(where))).toEqual([]);
    expect(await run(store.getOutput(where))).toBeUndefined();
  });

  it("keeps the first run in memory and writes it after the push mounts the component", async () => {
    const fake = new FakeDeployment().install();
    fake.mount = undefined;
    const store = await run(open);
    expect(await run(store.list(where))).toEqual([]);
    await run(store.set({ ...where, fqn: "Deployment", value: creating() }));
    expect(fake.calls).toEqual([]);
    expect(await run(store.get({ ...where, fqn: "Deployment" }))).toMatchObject({
      status: "creating",
    });

    fake.mount = "active"; // the Deployment push installed alchemyState
    await run(store.set({ ...where, fqn: "Deployment", value: created() }));
    await run(store.setOutput({ ...where, value: { url: "u" } }));
    expect(fake.calls).toEqual(["state:list", "state:set", "state:setOutput"]);
    expect(await run(store.get({ ...where, fqn: "Deployment" }))).toMatchObject({
      status: "created",
    });
    expect(fake.outputs.size).toBe(1);
  });

  it("fails at the stack output when the run never mounted the component", async () => {
    new FakeDeployment().install().mount = undefined;
    const store = await run(open);
    await run(store.set({ ...where, fqn: "Deployment", value: created() }));
    expect(await failureOf(store.setOutput({ ...where, value: {} }))).toContain(
      "this run saved no state",
    );
  });

  it("writes nothing when the component appears with rows that the run did not read", async () => {
    const fake = new FakeDeployment().install();
    fake.mount = undefined;
    const store = await run(open);
    fake.mount = "active";
    fake.rows.push({ ...where, fqn: "Other", value: "{}" });
    expect(
      await failureOf(store.set({ ...where, fqn: "Deployment", value: creating() })),
    ).toContain("did not read");
    expect(fake.calls).toEqual(["state:list"]);
  });

  it("refuses an unmounted component, which keeps its rows", async () => {
    new FakeDeployment().install().mount = "unmounted";
    expect(await failureOf(open)).toContain("unmounted");
  });

  it("passes on the Convex message of a key without deployment:data:write", async () => {
    const fake = new FakeDeployment().install();
    const store = await run(open);
    fake.error = fixture("function_not_permitted.json");
    expect(await failureOf(store.delete({ ...where, fqn: "Absent" }))).toContain(
      "(deployment:data:write)",
    );
  });

  it("reads CONVEX_STATE_DEPLOY_KEY and refuses a preview deploy key", async () => {
    new FakeDeployment().install();
    const service = (key: string) =>
      Effect.gen(function* () {
        return yield* yield* State;
      }).pipe(
        Effect.provide(state()),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CONVEX_STATE_DEPLOY_KEY: key })),
        ),
      );
    expect((await run(service(KEY))).id).toBe("convex");
    expect(await failureOf(service("preview:nicu:app|test-secret"))).toContain(
      "not a preview deploy key",
    );
  });
});
