// Convex.state against the fake Convex control plane: the Management API,
// the function API of the store deployment, and the fake Convex CLI for the
// push of the store. Every reply is a recorded payload with only the value
// changed.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type CreatedResourceState, State } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromValues } from "../src/Credentials.ts";
import { ManagementApi, ManagementApiLive } from "../src/ManagementApi.ts";
import { createDeployKey } from "../src/Push.ts";
import { RUN_RECORD_KEY, type RunRecord } from "../src/RunRecord.ts";
import {
  makeConvexState,
  makeFunctionApi,
  RUN_KEY_ACTIONS,
  state,
  STORE_PROJECT_NAME,
} from "../src/State.ts";
import { STORE_VERSION } from "../src/store/convex/version.ts";
import { FakeConvex, recorded, stateFixture } from "./fakeConvex.ts";

const TEAM = 38516;
const TOKEN = "test-token";
const API = "api.convex.dev/v1";
const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-convex-cli.ts", import.meta.url));

const Run = Schema.Struct({
  args: Schema.Array(Schema.String),
  home: Schema.String,
  cwd: Schema.String,
});
const KeyBody = Schema.Struct({ name: Schema.String, allowedActions: Schema.Array(Schema.String) });

let dir = "";
/** The functions directory of a store app whose `convex` package is the fake CLI. */
let store = "";
let log = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alchemy-convex-state-test-"));
  const app = join(dir, "store");
  store = join(app, "convex");
  mkdirSync(store, { recursive: true });
  mkdirSync(join(app, "node_modules", "convex"), { recursive: true });
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: STORE_PROJECT_NAME, private: true }),
  );
  writeFileSync(
    join(app, "node_modules", "convex", "package.json"),
    JSON.stringify({ name: "convex", bin: { convex: FAKE_CLI } }),
  );
  log = join(dir, "runs.jsonl");
  vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_LOG", log);
  vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "ok");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const runs = () =>
  Effect.promise(async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(log, "utf8").catch(() => "");
    return text
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Run))(line));
  });

const created = (fqn: string): CreatedResourceState => ({
  status: "created",
  fqn,
  logicalId: fqn,
  instanceId: "9058feab6047cbbe014a3530ca68230f",
  resourceType: "Convex.Project",
  namespace: undefined,
  providerVersion: 0,
  downstream: [],
  bindings: [],
  props: { team: "nicu", name: "app" },
  attr: { projectId: 1 },
});

/** The record of the test run, as a laptop derivation gives it; `recordedAt` is set at each write. */
const record: RunRecord = {
  version: 1,
  repository: "samebase/app",
  stackFile: "alchemy.run.ts",
  branch: "main",
  pullRequest: null,
  headCommit: "8af3c5b7932c528939cbc7aa0597b1fc36c8dc83",
  runUrl: null,
  source: "laptop",
  recordedAt: "unset",
};

/** The store service over the fake, with its own scope, which `close` ends. */
const open = (team: string | number = TEAM) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.make();
    const service = yield* makeConvexState({ team, api, spawner, scope, store, run: record });
    /** The read that Samebase makes: a key with the query action only, straight to the function API. */
    const read = (deployment: string, path: string, args: Record<string, string>) =>
      createDeployKey(api, deployment, "reader", ["deployment:functions:runInternalQueries"]).pipe(
        Effect.flatMap((key) =>
          makeFunctionApi(`https://${deployment}.convex.cloud`, key).call(path, args),
        ),
      );
    return { service, read, close: Scope.close(scope, Exit.void) };
  }).pipe(
    Effect.provide(
      ManagementApiLive().pipe(Layer.provide(fromValues({ accessToken: Redacted.make(TOKEN) }))),
    ),
    Effect.provide(NodeServices.layer),
  );

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
/** The rendered failure of `effect`, or "" when it succeeds. */
const failureOf = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
};

const stack = { stack: "samebase/app", stage: "main" };
const keyCalls = (fake: FakeConvex) =>
  fake.sent.filter((request) => request.path.endsWith("_deploy_key"));

describe("Convex.state", () => {
  it("creates the state project of the team, pushes the store, and serves the rows", async () => {
    const fake = new FakeConvex().install();
    // The project is new, so its deployment has no functions until the push.
    fake.addProject({ name: "other-app", teamId: TEAM });
    const { service, close } = await run(open());
    const project = fake.projects.find((row) => row["name"] === STORE_PROJECT_NAME);
    const deployment = String(project?.["prodDeploymentName"]);
    expect(fake.lines()).toContain(`POST ${API}/teams/${TEAM}/create_project`);
    expect(fake.stores.get(deployment)?.version).toBe(STORE_VERSION);

    const [runKey, pushKey, pushKeyDelete] = keyCalls(fake);
    expect(Schema.decodeUnknownSync(KeyBody)(runKey?.body)).toEqual({
      name: STORE_PROJECT_NAME,
      allowedActions: [...RUN_KEY_ACTIONS],
    });
    expect(Schema.decodeUnknownSync(KeyBody)(pushKey?.body).allowedActions).toEqual([
      "deployment:deploy",
      "deployment:env:view",
      "deployment:env:write",
    ]);
    expect(pushKeyDelete?.path).toBe(`${API}/deployments/${deployment}/delete_deploy_key`);
    const [pushed] = await run(runs());
    expect(pushed?.args).toEqual(["deploy", "--typecheck", "disable", "--codegen", "disable"]);
    expect(pushed?.cwd).toBe(realpathSync(join(dir, "store")));
    expect(pushed?.home).not.toBe(homedir());

    await run(service.set({ ...stack, fqn: "Project", value: created("Project") }));
    await run(service.setOutput({ ...stack, value: { url: "https://app.convex.site" } }));
    expect(fake.sent.map((request) => request.body)).toEqual(
      expect.arrayContaining(
        ["state:set", "state:setOutput"].map((path) =>
          expect.objectContaining({
            path,
            args: expect.objectContaining({
              run: { ...record, recordedAt: expect.stringMatching(/Z$/) },
            }),
          }),
        ),
      ),
    );
    expect(await run(service.list(stack))).toEqual(["Project"]);
    expect(await run(service.get({ ...stack, fqn: "Project" }))).toMatchObject({
      status: "created",
    });
    expect(await run(service.listStacks())).toEqual(["samebase/app"]);
    expect(await run(service.listStages("samebase/app"))).toEqual(["main"]);
    expect(await run(service.getOutput(stack))).toEqual({
      url: "https://app.convex.site",
      [RUN_RECORD_KEY]: { ...record, recordedAt: expect.stringMatching(/^2\d{3}-\d\d-\d\dT/) },
    });
    expect(fake.functionCalls.filter((line) => !line.endsWith("state:version"))).toEqual([
      `${deployment} state:set`,
      `${deployment} state:setOutput`,
      `${deployment} state:list`,
      `${deployment} state:get`,
      `${deployment} state:stacks`,
      `${deployment} state:stages`,
      `${deployment} state:getOutput`,
    ]);

    // The key of the run goes with its scope.
    expect(fake.keys.get(deployment)).toHaveLength(1);
    await run(close);
    expect(fake.keys.get(deployment)).toEqual([]);
  });

  it("finds the project with the current store and pushes nothing", async () => {
    const fake = new FakeConvex().install();
    const projectId = fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM });
    const deployment = fake.project(projectId)?.prodDeploymentName ?? "";
    fake.addStore(deployment, STORE_VERSION);
    const { service } = await run(open());
    expect(fake.lines().filter((line) => line.endsWith("/create_project"))).toEqual([]);
    expect(keyCalls(fake)).toHaveLength(1);
    expect(await run(runs())).toEqual([]);
    expect(await run(service.listStacks())).toEqual([]);
  });

  it("keeps the stacks of two repositories apart in one store", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    fake.addStore(deployment, STORE_VERSION);
    const { service } = await run(open());
    const other = { stack: "samebase/other", stage: "main" };
    await run(service.set({ ...stack, fqn: "Project", value: created("Project") }));
    await run(service.set({ ...stack, stage: "pr-1", fqn: "Project", value: created("Project") }));
    await run(service.set({ ...other, fqn: "Project", value: created("Project") }));
    expect(await run(service.listStacks())).toEqual(["samebase/app", "samebase/other"]);
    expect(await run(service.listStages("samebase/app"))).toEqual(["main", "pr-1"]);

    await run(service.deleteStack({ stack: "samebase/app", stage: "pr-1" }));
    expect(await run(service.listStages("samebase/app"))).toEqual(["main"]);
    await run(service.deleteStack({ stack: "samebase/app" }));
    expect(await run(service.listStacks())).toEqual(["samebase/other"]);
    expect(await run(service.list(other))).toEqual(["Project"]);
  });

  it("upgrades an older store in place and fails on a newer one", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    // The deployment answers version 0 until the fake CLI "pushed", then the current version.
    const store = fake.addStore(deployment, STORE_VERSION);
    fake.scripted.set(`POST ${deployment}.convex.cloud/api/function`, [
      { status: 200, body: { ...stateFixture("function_version.json"), value: 0 } },
      { status: 200, body: { ...stateFixture("function_version.json"), value: 0 } },
    ]);
    await run(open());
    expect(await run(runs())).toHaveLength(1);

    store.version = STORE_VERSION + 1;
    expect(await failureOf(open())).toContain(
      `answers store version ${STORE_VERSION + 1}, and this package needs store version ${STORE_VERSION}`,
    );
    expect(await run(runs())).toHaveLength(1);
  });

  it("stores the stack output with the run record, and the stack's own value under the key", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    const store = fake.addStore(deployment, STORE_VERSION);
    const { service, read } = await run(open());

    const stored = await run(service.setOutput({ ...stack, value: { url: "u" } }));
    const document = JSON.parse(store.outputs.get("samebase/app/main") ?? "");
    expect(document).toEqual({
      url: "u",
      [RUN_RECORD_KEY]: { ...record, recordedAt: expect.stringMatching(/Z$/) },
    });
    expect(stored).toEqual(document);
    // The reader gets the document as stored, through the function API.
    expect(await run(read(deployment, "state:getOutput", stack))).toMatchObject({
      status: "success",
      value: JSON.stringify(document),
    });

    // A value that the stack itself put under the key stays.
    const own = { url: "u", [RUN_RECORD_KEY]: { mine: true } };
    await run(service.setOutput({ ...stack, stage: "pr-1", value: own }));
    expect(await run(service.getOutput({ ...stack, stage: "pr-1" }))).toEqual(own);
    // An output that is not a plain object has no place for the record.
    await run(service.setOutput({ ...stack, stage: "pr-2", value: "u" }));
    expect(await run(service.getOutput({ ...stack, stage: "pr-2" }))).toBe("u");
  });

  it("reads, writes, and destroys without a record, when the checkout gives none", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    fake.addStore(deployment, STORE_VERSION);
    // The layer in a directory that is no git checkout, outside GitHub Actions
    // (CI sets GITHUB_ACTIONS): the record is logged, not required.
    vi.stubEnv("GITHUB_ACTIONS", "");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const service = await run(
        Effect.gen(function* () {
          return yield* yield* State;
        }).pipe(
          Effect.provide(state({ team: TEAM })),
          Effect.provide(NodeServices.layer),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CONVEX_ACCESS_TOKEN: TOKEN })),
          ),
          Effect.scoped,
        ),
      );
      await run(service.set({ ...stack, fqn: "Project", value: created("Project") }));
      await run(service.setOutput({ ...stack, value: { url: "u" } }));
      expect(await run(service.getOutput(stack))).toEqual({ url: "u" });
      await run(service.deleteStack({ stack: "samebase/app" }));
      expect(await run(service.listStacks())).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  // The fake's push raises the version and keeps the rows. A real push of store version 4 leaves
  // the rows of an older store in the root tables, which test/store.test.ts shows, and the
  // operator moves them once (docs/design/convex-state.md).
  it("upgrades an older store in place: the old names answer, and readStack is new", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    // The rows that 0.6.1 wrote, in a store of version 1, which has no readStack.
    const store = fake.addStore(deployment, 1);
    const project = JSON.stringify(created("Project"));
    store.rows.push({ ...stack, fqn: "Project", value: project });
    store.rows.push({ ...stack, stage: "pr-1", fqn: "Project", value: project });
    store.outputs.set("samebase/app/main", '{"url":"u"}');

    const { service, read } = await run(open());
    expect(await run(runs())).toHaveLength(1);
    expect(store.version).toBe(STORE_VERSION);
    expect(await run(service.listStacks())).toEqual(["samebase/app"]);
    expect(await run(service.listStages("samebase/app"))).toEqual(["main", "pr-1"]);
    expect(await run(service.list(stack))).toEqual(["Project"]);
    expect(await run(service.get({ ...stack, fqn: "Project" }))).toEqual(created("Project"));
    expect(await run(service.getOutput(stack))).toEqual({ url: "u" });
    expect(await run(read(deployment, "state:readStack", { stack: "samebase/app" }))).toEqual({
      status: "success",
      value: {
        stages: [
          { stage: "main", resources: [{ fqn: "Project", value: project }], output: '{"url":"u"}' },
          { stage: "pr-1", resources: [{ fqn: "Project", value: project }], output: null },
        ],
      },
    });
  });

  it("keeps one store when two first runs create the project at the same time", async () => {
    const fake = new FakeConvex().install();
    let other = 0;
    // The listing before the create is empty, and the other run creates its project meanwhile.
    fake.scripted.set(`GET ${API}/teams/${TEAM}/projects`, [
      {
        status: 200,
        body: { ...recorded("teams_projects.json"), items: [], pagination: { hasMore: false } },
        meanwhile: () => {
          other = fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM });
          fake.addStore(fake.project(other)?.prodDeploymentName ?? "", STORE_VERSION);
        },
      },
    ]);
    const { service } = await run(open());
    const mine = fake.projects.filter((row) => row["name"] === STORE_PROJECT_NAME);
    expect(mine.map((row) => row["id"])).toEqual([other]);
    expect(fake.lines().filter((line) => line.endsWith("/delete"))).toHaveLength(1);
    expect(await run(runs())).toEqual([]);
    await run(service.set({ ...stack, fqn: "Project", value: created("Project") }));
    expect(fake.stores.get(fake.project(other)?.prodDeploymentName ?? "")?.rows).toHaveLength(1);
  });

  it("replaces a key that stopped working during the run", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    fake.addStore(deployment, STORE_VERSION);
    const { service, close } = await run(open());
    // The key expired: Convex forgets it, and the next call gets HTTP 403.
    fake.keys.set(deployment, []);
    await run(service.set({ ...stack, fqn: "Project", value: created("Project") }));
    expect(await run(service.list(stack))).toEqual(["Project"]);
    expect(
      keyCalls(fake).filter((request) => request.path.endsWith("create_deploy_key")),
    ).toHaveLength(2);
    await run(close);
    expect(fake.keys.get(deployment)).toEqual([]);
  });

  it("does not push over a project with code that is not the store", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    fake.markDeployed(deployment);
    expect(await failureOf(open())).toContain("has code that is not the state store");
    expect(await run(runs())).toEqual([]);
  });

  it("passes on the Convex message of a key without the mutation action", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    fake.addStore(deployment, STORE_VERSION);
    const { service } = await run(open());
    fake.scripted.set(`POST ${deployment}.convex.cloud/api/function`, [
      { status: 200, body: stateFixture("function_not_permitted.json") },
    ]);
    expect(await failureOf(service.delete({ ...stack, fqn: "Absent" }))).toContain(
      "(deployment:functions:runInternalMutations)",
    );
  });

  it("needs no team with a team access token, which names its team", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    fake.addStore(deployment, STORE_VERSION);
    const service = await run(
      Effect.gen(function* () {
        return yield* yield* State;
      }).pipe(
        Effect.provide(state()),
        Effect.provide(NodeServices.layer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ CONVEX_ACCESS_TOKEN: fake.teamToken }),
          ),
        ),
        Effect.scoped,
      ),
    );
    expect(await run(service.listStacks())).toEqual([]);
    expect(fake.lines().slice(0, 2)).toEqual([
      "GET api.convex.dev/v1/token_details",
      `GET api.convex.dev/v1/teams/${TEAM}/projects`,
    ]);
  });

  it("reads CONVEX_ACCESS_TOKEN through the stack's ConfigProvider", async () => {
    const fake = new FakeConvex().install();
    const deployment =
      fake.project(fake.addProject({ name: STORE_PROJECT_NAME, teamId: TEAM }))
        ?.prodDeploymentName ?? "";
    fake.addStore(deployment, STORE_VERSION);
    const service = await run(
      Effect.gen(function* () {
        return yield* yield* State;
      }).pipe(
        Effect.provide(state({ team: TEAM })),
        Effect.provide(NodeServices.layer),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CONVEX_ACCESS_TOKEN: TOKEN })),
        ),
        Effect.scoped,
      ),
    );
    expect(service.id).toBe("convex");
    expect(fake.sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });
});
