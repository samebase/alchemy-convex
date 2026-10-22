// The push of Convex.Deployment through the real Alchemy engine. Each test
// makes a temporary Convex app whose `convex` package is the fake CLI
// (fixtures/fake-convex-cli.ts), so the provider resolves and runs it like the
// real one. FakeConvex answers the Management API and the deployment API.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as State from "alchemy/State";
import type { ScratchStack } from "alchemy/Test/Core";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as Convex from "../src/index.ts";
import { keyTargetOf, PUSH_KEY_LIFETIME_MS } from "../src/Push.ts";
import { FakeConvex, recorded } from "./fakeConvex.ts";

const TEAM = 38516;
const NAME = "tmp-alchemy-convex-fixture";
const API = "api.convex.dev/v1";
const TOKEN = "test-token";
const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-convex-cli.ts", import.meta.url));
const HELLO = fileURLToPath(new URL("./fixtures/convex-app/convex/hello.ts", import.meta.url));

const withToken = Test.make({
  providers: Convex.providers(Convex.fromValues({ accessToken: Redacted.make(TOKEN) })),
});
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const Run = Schema.Struct({
  args: Schema.Array(Schema.String),
  envFile: Schema.String,
  envFileMode: Schema.String,
  keySha256: Schema.String,
  home: Schema.String,
  convexVariables: Schema.Array(Schema.String),
  cwd: Schema.String,
});

let dir = "";
let app = "";
/** The app directory relative to the working directory of the test run, as a stack passes it. */
let rootDir = "";
let log = "";
/** The runs of the fake CLI so far. */
const runs = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Run))(line))
    : [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alchemy-convex-push-test-"));
  app = join(dir, "app");
  rootDir = relative(process.cwd(), app);
  mkdirSync(join(app, "convex"), { recursive: true });
  mkdirSync(join(app, "node_modules", "convex"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "fixture-app", private: true }));
  copyFileSync(HELLO, join(app, "convex", "hello.ts"));
  writeFileSync(
    join(app, "node_modules", "convex", "package.json"),
    JSON.stringify({ name: "convex", bin: { convex: FAKE_CLI } }),
  );
  log = join(dir, "runs.jsonl");
  vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_LOG", log);
  vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "ok");
  // Variables that would redirect a real CLI. The push must not pass them on.
  vi.stubEnv("CONVEX_DEPLOYMENT", "dev:some-other-deployment");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const backend = (props: Convex.DeploymentProps, source: string | undefined) =>
  Effect.gen(function* () {
    const deployment = yield* Convex.Deployment("Backend", {
      rootDir,
      ...props,
      ...(source === undefined ? {} : { source }),
    });
    return {
      name: deployment.name,
      url: deployment.url,
      siteUrl: deployment.siteUrl,
      hash: deployment.hash,
      envNames: deployment.envNames,
    };
  });

/** The requests that created or deleted a push key. */
const keyCalls = (fake: FakeConvex, from = 0) =>
  fake.sent.slice(from).filter((request) => /\/(create|delete)_deploy_key$/.test(request.path));

describe("keyTargetOf", () => {
  it("reads the deployment of a deploy key and the project of a preview deploy key", () => {
    expect(keyTargetOf("prod:happy-animal-123|REDACTED")).toEqual({
      kind: "deployment",
      deployment: "happy-animal-123",
    });
    expect(keyTargetOf("happy-animal-123|REDACTED")).toEqual({
      kind: "deployment",
      deployment: "happy-animal-123",
    });
    expect(keyTargetOf("preview:nicu:score-four|REDACTED")).toEqual({
      kind: "preview",
      team: "nicu",
      project: "score-four",
    });
    expect(keyTargetOf("project:nicu:score-four|REDACTED")).toEqual({ kind: "other" });
    expect(keyTargetOf("REDACTED")).toEqual({ kind: "other" });
    expect(keyTargetOf("dev:happy-animal-123|RED ACTED")).toEqual({ kind: "other" });
  });
});

describe("Convex.Deployment push with the access token", () => {
  withToken.test.provider(
    "pushes with a short-lived key in a 0600 env file, then deletes the key",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const name = fake.project(projectId)?.prodDeploymentName ?? "";
        const out = yield* stack.deploy(
          backend({ project: { projectId }, type: "prod" }, "./convex"),
        );
        expect(out).toMatchObject({
          name,
          url: `https://${name}.convex.cloud`,
          siteUrl: `https://${name}.convex.site`,
          envNames: [],
        });
        expect(out.hash).toMatch(/^[0-9a-f]{64}$/);

        const [create, remove] = keyCalls(fake);
        expect(create?.path).toBe(`${API}/deployments/${name}/create_deploy_key`);
        expect(create?.authorization).toBe(`Bearer ${TOKEN}`);
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            name: Schema.String,
            allowedActions: Schema.Array(Schema.String),
            expiresAt: Schema.Number,
          }),
        )(create?.body);
        expect(body.allowedActions).toEqual([
          "deployment:deploy",
          "deployment:env:view",
          "deployment:env:write",
        ]);
        expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(PUSH_KEY_LIFETIME_MS);
        expect(body.expiresAt - Date.now()).toBeGreaterThan(PUSH_KEY_LIFETIME_MS - 60_000);

        const [run] = runs();
        expect(runs()).toHaveLength(1);
        expect(run?.args.slice(0, 2)).toEqual(["deploy", "--env-file"]);
        expect(run?.envFileMode).toBe("600");
        expect(run?.home).not.toBe(homedir());
        expect(run?.convexVariables).toEqual([]);
        expect(run?.cwd).toBe(realpathSync(app));
        // The key that the CLI got is the key that was deleted after the push.
        const RemoveBody = Schema.Struct({ id: Schema.String });
        expect(remove?.path).toBe(`${API}/deployments/${name}/delete_deploy_key`);
        expect(sha256(Schema.decodeUnknownSync(RemoveBody)(remove?.body).id)).toBe(run?.keySha256);
        expect(fake.keys.get(name)).toEqual([]);
        // The env file is gone with its directory.
        expect(existsSync(run?.envFile ?? "")).toBe(false);
      }),
  );

  withToken.test.provider("an unchanged source is a no-op, a changed one pushes again", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const props = { project: { projectId }, type: "prod" } as const;
      const first = yield* stack.deploy(backend(props, "./convex"));
      const from = fake.sent.length;
      const second = yield* stack.deploy(backend(props, "./convex"));
      expect(second).toEqual(first);
      expect(runs()).toHaveLength(1);
      expect(fake.lines(from).every((line) => line.startsWith("GET "))).toBe(true);

      writeFileSync(join(app, "convex", "hello.ts"), "export const changed = 1;\n");
      const third = yield* stack.deploy(backend(props, "./convex"));
      expect(third.hash).not.toBe(first.hash);
      expect(runs()).toHaveLength(2);
      expect(keyCalls(fake, from)).toHaveLength(2);
    }),
  );

  withToken.test.provider(
    "sets env before the push, updates a value, and removes a name that left env",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const name = fake.project(projectId)?.prodDeploymentName ?? "";
        const props = (env: Record<string, string | Redacted.Redacted<string>>) =>
          backend({ project: { projectId }, type: "prod", env }, "./convex");
        const first = yield* stack.deploy(props({ A: "1", B: Redacted.make("secret") }));
        expect(first.envNames).toEqual(["A", "B"]);
        expect(fake.variables.get(name)).toEqual({ A: "1", B: "secret" });
        const second = yield* stack.deploy(props({ A: "2" }));
        expect(second.envNames).toEqual(["A"]);
        expect(second.hash).not.toBe(first.hash);
        expect(fake.variables.get(name)).toEqual({ A: "2" });
        expect(runs()).toHaveLength(2);
      }),
  );

  withToken.test.provider(
    "refuses to overwrite a variable it did not set, and overwrites it with --adopt",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const name = fake.project(projectId)?.prodDeploymentName ?? "";
        fake.variables.set(name, { A: "someone else" });
        const props = { project: { projectId }, type: "prod", env: { A: "ours" } } as const;
        const error = yield* Effect.flip(stack.deploy(backend(props, "./convex")));
        expect(error).toBeInstanceOf(Convex.VariablesOwnedBySomeoneElse);
        expect(fake.variables.get(name)).toEqual({ A: "someone else" });
        expect(runs()).toHaveLength(0);
        // The push key is deleted after the refusal too.
        expect(fake.keys.get(name)).toEqual([]);
        yield* stack.deploy(
          Effect.gen(function* () {
            const deployment = yield* Convex.Deployment("Backend", {
              ...props,
              rootDir,
              source: "./convex",
            }).pipe(adopt(true));
            return { name: deployment.name };
          }),
        );
        expect(fake.variables.get(name)).toEqual({ A: "ours" });
      }),
  );

  withToken.test.provider("never deletes a push key that is the OAuth credential itself", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      fake.oauth = true;
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      yield* stack.deploy(backend({ project: { projectId }, type: "prod" }, "./convex"));
      expect(runs()).toHaveLength(1);
      expect(keyCalls(fake).map((request) => request.path.split("/").pop())).toEqual([
        "create_deploy_key",
      ]);
    }),
  );

  withToken.test.provider(
    "fails with the CLI output tail without the key, and deletes the key",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "fail");
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const name = fake.project(projectId)?.prodDeploymentName ?? "";
        const error = yield* Effect.flip(
          stack.deploy(backend({ project: { projectId }, type: "prod" }, "./convex")),
        );
        expect(error).toBeInstanceOf(Convex.CodePushFailed);
        expect(error).toMatchObject({ exitCode: 1 });
        expect(String(error.message)).toContain("[REDACTED]");
        expect(String(error.message)).not.toContain("|REDACTED-");
        expect(fake.keys.get(name)).toEqual([]);
      }),
  );

  withToken.test.provider(
    "runs a push command with the key in its environment, and hashes its include globs",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        mkdirSync(join(app, "src"));
        writeFileSync(join(app, "src", "main.ts"), "export const page = 1;\n");
        const props = {
          project: { projectId },
          type: "prod",
          source: {
            path: "./convex",
            command: [process.execPath, FAKE_CLI, "deploy", "--cmd", "build"],
            include: ["src/**"],
          },
        } as const;
        const first = yield* stack.deploy(backend(props, undefined));
        const [run] = runs();
        expect(run?.args).toEqual(["deploy", "--cmd", "build"]);
        expect(run?.cwd).toBe(realpathSync(app));
        expect(run?.convexVariables).toEqual(["CONVEX_DEPLOY_KEY"]);
        const [, remove] = keyCalls(fake);
        const RemoveBody = Schema.Struct({ id: Schema.String });
        expect(sha256(Schema.decodeUnknownSync(RemoveBody)(remove?.body).id)).toBe(run?.keySha256);
        // Unchanged: a no-op. A changed build input: a new push.
        yield* stack.deploy(backend(props, undefined));
        expect(runs()).toHaveLength(1);
        writeFileSync(join(app, "src", "main.ts"), "export const page = 2;\n");
        const third = yield* stack.deploy(backend(props, undefined));
        expect(third.hash).not.toBe(first.hash);
        expect(runs()).toHaveLength(2);
      }),
  );

  withToken.test.provider("fails with PushTargetMismatch when the CLI pushed elsewhere", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "other");
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const error = yield* Effect.flip(
        stack.deploy(backend({ project: { projectId }, type: "prod" }, "./convex")),
      );
      expect(error).toMatchObject({ _tag: "PushTargetMismatch", actual: "other-deployment-123" });
    }),
  );
});

/** FakeConvex names the production deployment of its first project so. */
const FIRST_PROD = "fake-deployment-9100000";
const DEPLOY_KEY = `prod:${FIRST_PROD}|REDACTED-deploy-key`;
/** The recorded project payload has the team slug samebase-live-tests, and FakeConvex uses the name as slug. */
const PREVIEW_KEY = `preview:samebase-live-tests:${NAME}|REDACTED-preview-key`;

const withDeployKey = Test.make({
  providers: Convex.providers(Convex.fromValues({ deployKey: Redacted.make(DEPLOY_KEY) })),
});
const withPreviewKey = Test.make({
  providers: Convex.providers(Convex.fromValues({ deployKey: Redacted.make(PREVIEW_KEY) })),
});
const withTokenAndPreviewKey = Test.make({
  providers: Convex.providers(
    Convex.fromValues({ accessToken: Redacted.make(TOKEN), deployKey: Redacted.make(PREVIEW_KEY) }),
  ),
});
const withTokenAndKey = Test.make({
  providers: Convex.providers(
    Convex.fromValues({ accessToken: Redacted.make(TOKEN), deployKey: Redacted.make(DEPLOY_KEY) }),
  ),
});

describe("Convex.Deployment push with a deploy key", () => {
  withDeployKey.test.provider(
    "pushes and sets env with the deploy key alone, with no Management API call",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        expect(fake.project(projectId)?.prodDeploymentName).toBe(FIRST_PROD);
        fake.deploymentKeys.set(FIRST_PROD, DEPLOY_KEY);
        const props = { project: { projectId }, type: "prod", env: { A: "1" } } as const;
        // The deployment API cannot say whether the deployment has code, so
        // the first deploy takes it over only with --adopt.
        const refused = yield* Effect.flip(stack.deploy(backend(props, "./convex")));
        expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
        const out = yield* stack.deploy(backend(props, "./convex").pipe(adopt(true)));
        expect(out).toMatchObject({
          name: FIRST_PROD,
          url: `https://${FIRST_PROD}.convex.cloud`,
          siteUrl: `https://${FIRST_PROD}.convex.site`,
          envNames: ["A"],
        });
        const again = yield* stack.deploy(backend(props, "./convex"));
        expect(again).toEqual(out);
        expect(fake.sent.filter((request) => request.path.startsWith(API))).toEqual([]);
        expect(fake.variables.get(FIRST_PROD)).toEqual({ A: "1" });
        expect(runs().map((run) => run.keySha256)).toEqual([sha256(DEPLOY_KEY)]);
      }),
  );

  withTokenAndKey.test.provider(
    "uses the access token for a deployment that the deploy key does not fit",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const out = yield* stack.deploy(
          backend({ project: { projectId }, type: "dev", name: "staging" }, "./convex"),
        );
        expect(fake.deployment(out.name)).toMatchObject({
          deploymentType: "dev",
          reference: "staging",
        });
        expect(keyCalls(fake).map((request) => request.authorization)).toEqual([
          `Bearer ${TOKEN}`,
          `Bearer ${TOKEN}`,
        ]);
        expect(runs().map((run) => run.keySha256)).not.toContain(sha256(DEPLOY_KEY));
      }),
  );
});

describe("Convex.Deployment with a deploy key that cannot prove its project", () => {
  withTokenAndKey.test.provider(
    "falls back to the access token when deployment_info refuses the key",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        // A key without deployment:data:view, such as one limited to deploy and env.
        fake.scripted.set(
          `GET ${FIRST_PROD}.convex.cloud/api/v1/deployment_info`,
          [1, 2, 3].map(() => ({
            status: 403,
            body: recorded("deployment_info_not_permitted.json"),
          })),
        );
        yield* stack.deploy(backend({ project: { projectId }, type: "prod" }, "./convex"));
        expect(keyCalls(fake).map((request) => request.authorization)).toEqual([
          `Bearer ${TOKEN}`,
          `Bearer ${TOKEN}`,
        ]);
        expect(runs().map((run) => run.keySha256)).not.toContain(sha256(DEPLOY_KEY));
      }),
  );
});

describe("Convex.Deployment with a preview deploy key", () => {
  withPreviewKey.test.provider(
    "creates and deletes a preview deployment with the preview deploy key alone",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const out = yield* stack.deploy(
          Effect.gen(function* () {
            const deployment = yield* Convex.Deployment("Preview", {
              project: { projectId },
              type: "preview",
              name: "pr-42",
            }).pipe(RemovalPolicy.destroy());
            return { name: deployment.name, previewName: deployment.previewName };
          }),
        );
        expect(out.previewName).toBe("pr-42");
        expect(fake.deployment(out.name)?.previewIdentifier).toBe("pr-42");
        yield* stack.destroy();
        expect(fake.deployment(out.name)).toBeUndefined();
        expect(new Set(fake.sent.map((request) => request.authorization))).toEqual(
          new Set([`Bearer ${PREVIEW_KEY}`]),
        );
      }),
  );

  withPreviewKey.test.provider("pushes with --preview-name and the preview deploy key", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      // Such as a preview that an earlier CI run created.
      const existing = fake.addDeployment({ projectId, type: "preview", name: "pr-42" });
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_PREVIEW", existing);
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const deployment = yield* Convex.Deployment("Preview", {
            project: { projectId },
            type: "preview",
            name: "pr-42",
            rootDir,
            source: "./convex",
          }).pipe(adopt(true));
          return { name: deployment.name };
        }),
      );
      expect(out.name).toBe(existing);
      const [run] = runs();
      expect(run?.args.slice(0, 3)).toEqual(["deploy", "--preview-name", "pr-42"]);
      expect(run?.keySha256).toBe(sha256(PREVIEW_KEY));
      expect(keyCalls(fake)).toEqual([]);
    }),
  );

  withPreviewKey.test.provider(
    "refuses env with EnvironmentNeedsDeployKey before the push",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const error = yield* Effect.flip(
          stack.deploy(
            backend(
              { project: { projectId }, type: "preview", name: "pr-42", env: { A: "1" } },
              "./convex",
            ),
          ),
        );
        expect(error).toBeInstanceOf(Convex.EnvironmentNeedsDeployKey);
        expect(runs()).toEqual([]);
        expect(fake.lines().filter((line) => line.endsWith("/create_deployment"))).toEqual([]);
      }),
  );

  withTokenAndPreviewKey.test.provider(
    "uses the access token for env even when the preview deploy key fits",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const out = yield* stack.deploy(
          backend(
            { project: { projectId }, type: "preview", name: "pr-42", env: { A: "1" } },
            "./convex",
          ),
        );
        expect(fake.variables.get(out.name)).toEqual({ A: "1" });
        expect(new Set(keyCalls(fake).map((request) => request.authorization))).toEqual(
          new Set([`Bearer ${TOKEN}`]),
        );
      }),
  );
});

describe("Convex.Deployment after a failed push", () => {
  withToken.test.provider("sets the variables back to their earlier values", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const name = fake.project(projectId)?.prodDeploymentName ?? "";
      const props = (env: Record<string, string>) =>
        backend({ project: { projectId }, type: "prod", env }, "./convex");
      const first = yield* stack.deploy(props({ A: "1", B: "2" }));
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "fail");
      yield* Effect.flip(stack.deploy(props({ A: "changed", C: "new" })));
      expect(fake.variables.get(name)).toEqual({ A: "1", B: "2" });
      // The earlier props match the deployment again: a no-op.
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "ok");
      const again = yield* stack.deploy(props({ A: "1", B: "2" }));
      expect(again.hash).toBe(first.hash);
      expect(runs()).toHaveLength(2);
    }),
  );

  withToken.test.provider(
    "deletes a preview deployment that the same run created, and never one it found",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const props = { project: { projectId }, type: "preview", name: "pr-42" } as const;
        vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "fail");
        yield* Effect.flip(stack.deploy(backend(props, "./convex")));
        expect(
          fake.deploymentsOf(projectId).filter((row) => row.deploymentType === "preview"),
        ).toEqual([]);
        // The next run creates it again, without --adopt.
        vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "ok");
        const out = yield* stack.deploy(backend(props, "./convex"));
        expect(fake.deployment(out.name)?.previewIdentifier).toBe("pr-42");
        // A failed push to a deployment in state keeps it.
        writeFileSync(join(app, "convex", "hello.ts"), "export const changed = 1;\n");
        vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "fail");
        yield* Effect.flip(stack.deploy(backend(props, "./convex")));
        expect(fake.deployment(out.name)).toBeDefined();
      }),
  );
});

describe("Convex.Deployment source checks", () => {
  withToken.test.provider(
    "hashes the whole app by default, and only the include globs with include",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        writeFileSync(join(app, "shared.ts"), "export const shared = 1;\n");
        const plain = backend({ project: { projectId }, type: "prod" }, "./convex");
        yield* stack.deploy(plain);
        // A module outside convex/ that a function can import.
        writeFileSync(join(app, "shared.ts"), "export const shared = 2;\n");
        yield* stack.deploy(plain);
        expect(runs()).toHaveLength(2);
        const narrowed = backend(
          {
            project: { projectId },
            type: "prod",
            source: { path: "./convex", include: [] },
          },
          undefined,
        );
        yield* stack.deploy(narrowed);
        writeFileSync(join(app, "shared.ts"), "export const shared = 3;\n");
        yield* stack.deploy(narrowed);
        expect(runs()).toHaveLength(3);
      }),
  );

  withToken.test.provider(
    "refuses a source that is not the functions directory of convex.json",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        writeFileSync(join(app, "convex.json"), JSON.stringify({ functions: "src/convex/" }));
        const error = yield* Effect.flip(
          stack.deploy(backend({ project: { projectId }, type: "prod" }, "./convex")),
        );
        expect(error).toMatchObject({ _tag: "SourceMismatch" });
        expect(runs()).toEqual([]);
        expect(keyCalls(fake)).toEqual([]);
      }),
  );
});

/** The state row of the resource `Backend`, as the state store keeps it. */
const rowOf = (stack: ScratchStack) =>
  Effect.gen(function* () {
    // The service is an Effect that makes the store.
    const state = yield* Effect.flatten(State.State);
    return yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Backend" });
  }).pipe(Effect.provide(stack.state));

/** The props in the state row of `Backend`. An action row has none. */
const propsOf = (stack: ScratchStack) =>
  rowOf(stack).pipe(
    Effect.map((row) => (row !== undefined && "props" in row ? row.props : undefined)),
  );

describe("Convex.Deployment rootDir", () => {
  withToken.test.provider(
    "runs the push in rootDir, resolves source against it, and stores both as given",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        yield* stack.deploy(backend({ project: { projectId }, type: "prod" }, "./convex"));
        expect(runs().map((run) => run.cwd)).toEqual([realpathSync(app)]);
        expect(yield* propsOf(stack)).toMatchObject({ rootDir, source: "./convex" });
      }),
  );

  withToken.test.provider(
    'writes rootDir "." into state when it is not set, and stores it in POSIX form',
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const deploy = (props: Convex.DeploymentInput) =>
          stack.deploy(
            Effect.gen(function* () {
              const deployment = yield* Convex.Deployment("Backend", props);
              return { name: deployment.name };
            }),
          );
        yield* deploy({ project: { projectId }, type: "prod" });
        expect((yield* propsOf(stack))?.["rootDir"]).toBe(".");
        // No source: nothing reads the directory, so it need not exist.
        yield* deploy({ project: { projectId }, type: "prod", rootDir: "./apps\\web/" });
        expect((yield* propsOf(stack))?.["rootDir"]).toBe("apps/web");
        expect(runs()).toEqual([]);
      }),
  );

  withToken.test.provider("refuses an absolute rootDir before any change", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const error = yield* Effect.flip(
        stack.deploy(backend({ project: { projectId }, type: "prod", rootDir: app }, "./convex")),
      );
      expect(error).toBeInstanceOf(Convex.AbsoluteRootDir);
      expect(runs()).toEqual([]);
      // The plan reads; nothing writes.
      expect(fake.lines().every((line) => line.startsWith("GET "))).toBe(true);
    }),
  );

  withToken.test.provider(
    "fails before any change when rootDir is not the directory of the Convex app",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const props = (directory: string, source: string) =>
          backend(
            { project: { projectId }, type: "prod", rootDir: relative(process.cwd(), directory) },
            source,
          );
        // No package.json in rootDir: there is no search above it.
        const missing = yield* Effect.flip(stack.deploy(props(join(app, "convex"), ".")));
        expect(missing).toBeInstanceOf(Convex.ConvexAppNotFound);
        yield* stack.deploy(props(app, "./convex"));
        const deployed = yield* rowOf(stack);
        const from = fake.sent.length;
        // A 0.7 stack at a monorepo root with source "app/convex": 0.7 ran the
        // push in app/, the nearest directory with a package.json.
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "monorepo" }));
        const mismatch = yield* Effect.flip(stack.deploy(props(dir, "./app/convex")));
        expect(mismatch).toMatchObject({
          _tag: "SourceMismatch",
          message: expect.stringContaining("Set rootDir to the directory of the Convex app"),
        });
        // The plan stops, so the row keeps the props of the last deploy.
        expect(yield* rowOf(stack)).toEqual(deployed);
        expect(runs()).toHaveLength(1);
        expect(fake.lines(from)).toEqual([]);
      }),
  );

  withToken.test.provider(
    "updates a 0.7.0 row in place: one update with no Convex write, then a no-op",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const props = { project: { projectId }, type: "prod", env: { A: "1" } } as const;
        const first = yield* stack.deploy(backend(props, "./convex"));
        // A 0.7.0 row differs from this one only by props.rootDir: 0.7.0 had
        // no rootDir, and its push ran in the same app directory.
        const row = yield* rowOf(stack);
        assert(row !== undefined && "props" in row && row.props !== undefined);
        const { props: current } = row;
        yield* Effect.gen(function* () {
          // The service is an Effect that makes the store.
          const state = yield* Effect.flatten(State.State);
          yield* state.set({
            stack: stack.name,
            stage: stack.stage,
            fqn: "Backend",
            value: {
              ...row,
              props: Object.fromEntries(
                Object.entries(current).filter(([key]) => key !== "rootDir"),
              ),
            },
          });
        }).pipe(Effect.provide(stack.state));
        expect(yield* propsOf(stack)).not.toHaveProperty("rootDir");

        const plan = yield* stack.plan(backend(props, "./convex"));
        expect(plan.resources["Backend"]?.action).toBe("update");
        const from = fake.sent.length;
        const second = yield* stack.deploy(backend(props, "./convex"));
        expect(second).toEqual(first);
        expect(runs()).toHaveLength(1);
        expect(fake.lines(from).every((line) => line.startsWith("GET "))).toBe(true);
        expect(yield* rowOf(stack)).toMatchObject({ status: "updated", props: { rootDir } });

        const next = yield* stack.plan(backend(props, "./convex"));
        expect(next.resources["Backend"]?.action).toBe("noop");
      }),
  );
});
