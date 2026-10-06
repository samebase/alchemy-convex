// Convex.Code through the real Alchemy engine. A fake Convex CLI
// (fixtures/fake-convex-cli.ts) runs through the `command` prop, and
// FakeConvex answers the Management API and the deployment API.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adopt } from "alchemy/AdoptPolicy";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyTargetOf } from "../src/Code.ts";
import * as Convex from "../src/index.ts";
import { FakeConvex, fixture } from "./fakeConvex.ts";

const TEAM = 38516;
const NAME = "tmp-alchemy-convex-fixture";
const APP = fileURLToPath(new URL("./fixtures/convex-app", import.meta.url));
const COMMAND = [
  process.execPath,
  fileURLToPath(new URL("./fixtures/fake-convex-cli.ts", import.meta.url)),
] as const;

const { test } = Test.make({
  providers: Convex.providers(Convex.fromToken(Redacted.make("test-token"))),
});

/** The recorded deploy key, `dev:beaming-okapi-932|REDACTED`, for another deployment. */
const recordedKey = Schema.decodeUnknownSync(Schema.Struct({ deployKey: Schema.String }))(
  fixture("deployment_create_deploy_key.json"),
).deployKey;
const keyFor = (deployment: string) =>
  `${recordedKey.replace("beaming-okapi-932", deployment)}-code-test`;
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
  const dir = mkdtempSync(join(tmpdir(), "alchemy-convex-code-test-"));
  log = join(dir, "runs.jsonl");
  vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_LOG", log);
  vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "ok");
  // Variables that would redirect a real CLI. Code must not pass them on.
  vi.stubEnv("CONVEX_DEPLOYMENT", "dev:some-other-deployment");
  vi.stubEnv("CONVEX_DEPLOY_KEY", keyFor("some-other-deployment"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dirname(log), { recursive: true, force: true });
});

const code = (props: Omit<Convex.CodeProps, "cwd" | "command">) =>
  Effect.gen(function* () {
    const backend = yield* Convex.Code("Backend", { ...props, cwd: APP, command: COMMAND });
    return {
      deploymentName: backend.deploymentName,
      url: backend.url,
      siteUrl: backend.siteUrl,
      deployedAt: backend.deployedAt,
      envNames: backend.envNames,
    };
  });

describe("keyTargetOf", () => {
  it("reads the deployment of a deploy key and the kind of other keys", () => {
    expect(keyTargetOf(recordedKey)).toEqual({
      kind: "deployment",
      deployment: "beaming-okapi-932",
    });
    expect(keyTargetOf("beaming-okapi-932|REDACTED")).toEqual({
      kind: "deployment",
      deployment: "beaming-okapi-932",
    });
    expect(keyTargetOf("preview:nicu:score-four|REDACTED")).toEqual({ kind: "preview" });
    expect(keyTargetOf("project:nicu:score-four|REDACTED")).toEqual({ kind: "project" });
    expect(keyTargetOf("REDACTED")).toEqual({ kind: "unknown" });
    expect(keyTargetOf("dev:beaming-okapi-932|RED ACTED")).toEqual({ kind: "unknown" });
  });
});

describe("Convex.Code", () => {
  test.provider("pushes on every apply with the key only in a 0600 env file", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const deployment = fake.project(projectId)?.prodDeploymentName ?? "";
      const key = keyFor(deployment);
      const props = { deployment, deployKey: Redacted.make(key) };
      const first = yield* stack.deploy(code(props));
      const second = yield* stack.deploy(code(props));
      expect(first).toMatchObject({
        deploymentName: deployment,
        url: `https://${deployment}.convex.cloud`,
        siteUrl: `https://${deployment}.convex.site`,
        envNames: [],
      });
      expect(second.deployedAt).toBeGreaterThanOrEqual(first.deployedAt);
      const done = runs();
      expect(done.length).toBe(2);
      for (const run of done) {
        expect(run.args).toEqual(["deploy", "--env-file", run.envFile]);
        expect(run.envFileMode).toBe("600");
        expect(run.keySha256).toBe(sha256(key));
        // The env file lives in the temporary home directory, which is removed.
        expect(run.home).toBe(dirname(run.envFile));
        expect(existsSync(run.home)).toBe(false);
        expect(run.convexVariables).toEqual([]);
        expect(run.cwd).toBe(APP);
      }
    }),
  );

  test.provider("passes the typecheck and codegen flags", (stack) =>
    Effect.gen(function* () {
      const deployment = "happy-animal-123";
      new FakeConvex().install();
      yield* stack.deploy(
        code({
          deployment,
          deployKey: Redacted.make(keyFor(deployment)),
          typecheck: "disable",
          codegen: "disable",
        }),
      );
      expect(runs()[0]?.args.slice(0, 3)).toEqual([
        "deploy",
        "--typecheck=disable",
        "--codegen=disable",
      ]);
    }),
  );

  test.provider(
    "keeps the key out of the error and removes the env file when the push fails",
    (stack) =>
      Effect.gen(function* () {
        new FakeConvex().install();
        vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "fail");
        const deployment = "happy-animal-123";
        const key = keyFor(deployment);
        const error = yield* Effect.flip(
          stack.deploy(code({ deployment, deployKey: Redacted.make(key) })),
        );
        expect(error).toBeInstanceOf(Convex.CodePushFailed);
        expect(error).toMatchObject({ exitCode: 1 });
        const token = key.slice(key.indexOf("|") + 1);
        const text = `${String(error)}\n${JSON.stringify(error)}\n${error.message}`;
        expect(text.includes(key)).toBe(false);
        expect(text.includes(token)).toBe(false);
        expect(error.message).toContain("Error: the key [REDACTED] was rejected");
        const [run] = runs();
        expect(run !== undefined && existsSync(run.envFile)).toBe(false);
      }),
  );

  test.provider("removes the env file when the run is interrupted", (stack) =>
    Effect.gen(function* () {
      new FakeConvex().install();
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "hang");
      const deployment = "happy-animal-123";
      // The fake CLI logs its run first, then waits. The race interrupts the
      // deploy as soon as the log shows the run.
      const started = Effect.promise(async () => {
        while (runs().length === 0) await new Promise((done) => setTimeout(done, 20));
        return "interrupted" as const;
      });
      const result = yield* Effect.race(
        stack
          .deploy(code({ deployment, deployKey: Redacted.make(keyFor(deployment)) }))
          .pipe(Effect.as("deployed" as const)),
        started,
      );
      expect(result).toBe("interrupted");
      const [run] = runs();
      expect(run).toBeDefined();
      expect(run !== undefined && existsSync(run.home)).toBe(false);
    }),
  );

  test.provider("refuses a deploy key of another deployment before any run", (stack) =>
    Effect.gen(function* () {
      new FakeConvex().install();
      const error = yield* Effect.flip(
        stack.deploy(
          code({
            deployment: "happy-animal-123",
            deployKey: Redacted.make(keyFor("sad-animal-456")),
          }),
        ),
      );
      expect(error).toBeInstanceOf(Convex.DeployKeyMismatch);
      expect(error).toMatchObject({
        deployment: "happy-animal-123",
        key: "deployment",
        keyDeployment: "sad-animal-456",
      });
      expect(runs()).toEqual([]);
    }),
  );

  test.provider("refuses a preview, project, or unknown key for a deployment name", (stack) =>
    Effect.gen(function* () {
      new FakeConvex().install();
      const token = recordedKey.slice(recordedKey.indexOf("|"));
      for (const [deployKey, kind] of [
        [`preview:nicu:${NAME}${token}`, "preview"],
        [`project:nicu:${NAME}${token}`, "project"],
        ["REDACTED", "unknown"],
      ] as const) {
        const error = yield* Effect.flip(
          stack.deploy(
            code({ deployment: "happy-animal-123", deployKey: Redacted.make(deployKey) }),
          ),
        );
        expect(error).toMatchObject({ _tag: "DeployKeyMismatch", key: kind });
      }
      expect(runs()).toEqual([]);
    }),
  );

  test.provider("fails with PushTargetMismatch when the CLI pushes elsewhere", (stack) =>
    Effect.gen(function* () {
      new FakeConvex().install();
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "other");
      const deployment = "happy-animal-123";
      const error = yield* Effect.flip(
        stack.deploy(code({ deployment, deployKey: Redacted.make(keyFor(deployment)) })),
      );
      expect(error).toBeInstanceOf(Convex.PushTargetMismatch);
      expect(error).toMatchObject({ expected: deployment, actual: "other-deployment-123" });
    }),
  );

  test.provider("fails with ConvexCliNotFound for a directory without convex", (stack) =>
    Effect.gen(function* () {
      new FakeConvex().install();
      const cwd = mkdtempSync(join(tmpdir(), "alchemy-convex-no-cli-"));
      writeFileSync(join(cwd, "package.json"), "{}\n");
      const deployment = "happy-animal-123";
      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const backend = yield* Convex.Code("Backend", {
              deployment,
              deployKey: Redacted.make(keyFor(deployment)),
              cwd,
            });
            return { url: backend.url };
          }),
        ),
      );
      rmSync(cwd, { recursive: true, force: true });
      expect(error).toBeInstanceOf(Convex.ConvexCliNotFound);
    }),
  );

  test.provider("pushes a preview with the preview deploy key and --preview-name", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const stage = (push: boolean) =>
        Effect.gen(function* () {
          const preview = yield* Convex.Deployment("Preview", {
            projectId,
            type: "preview",
            name: "pr-42",
          });
          const key = yield* Convex.PreviewDeployKey("PreviewKey", { projectId, name: "ci" });
          const backend = push
            ? yield* Convex.Code("Backend", {
                deployment: preview,
                deployKey: key.previewDeployKey,
                cwd: APP,
                command: COMMAND,
              })
            : undefined;
          return { preview: preview.name, url: backend?.url, siteUrl: backend?.siteUrl };
        });
      // The fake CLI cannot look the preview up, so it learns the name first.
      const created = yield* stack.deploy(stage(false));
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_PREVIEW", created.preview);
      const out = yield* stack.deploy(stage(true));
      expect(out).toEqual({
        preview: created.preview,
        url: `https://${created.preview}.convex.cloud`,
        siteUrl: `https://${created.preview}.convex.site`,
      });
      expect(runs()[0]?.args.slice(0, 3)).toEqual(["deploy", "--preview-name", "pr-42"]);
    }),
  );

  test.provider("sets env before the push and removes a name that leaves env", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const deployment = "happy-animal-123";
      const deployKey = Redacted.make(keyFor(deployment));
      fake.deploymentKeys.set(deployment, Redacted.value(deployKey));
      // A failed push leaves the variables set: they were written first.
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "fail");
      const env = { SITE_URL: "https://example.com", SECRET: Redacted.make("s3cret-value") };
      yield* Effect.flip(stack.deploy(code({ deployment, deployKey, env })));
      expect(fake.variables.get(deployment)).toEqual({
        SITE_URL: "https://example.com",
        SECRET: "s3cret-value",
      });
      // The next run finds the same values, so it needs no --adopt.
      vi.stubEnv("ALCHEMY_CONVEX_FAKE_CLI_MODE", "ok");
      const out = yield* stack.deploy(code({ deployment, deployKey, env }));
      expect(out.envNames).toEqual(["SECRET", "SITE_URL"]);
      // SECRET leaves env: Code removes it from the deployment.
      const after = yield* stack.deploy(
        code({ deployment, deployKey, env: { SITE_URL: "https://example.com" } }),
      );
      expect(after.envNames).toEqual(["SITE_URL"]);
      expect(fake.variables.get(deployment)).toEqual({ SITE_URL: "https://example.com" });
    }),
  );

  test.provider("overwrites a variable with another value only with --adopt", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const deployment = "happy-animal-123";
      const deployKey = Redacted.make(keyFor(deployment));
      fake.variables.set(deployment, { SITE_URL: "https://someone-else.example.com" });
      const refused = yield* Effect.flip(
        stack.deploy(code({ deployment, deployKey, env: { SITE_URL: "https://example.com" } })),
      );
      expect(refused).toMatchObject({
        _tag: "OwnedBySomeoneElse",
        message: expect.stringContaining("--adopt"),
      });
      expect(runs()).toEqual([]);
      expect(fake.variables.get(deployment)).toEqual({
        SITE_URL: "https://someone-else.example.com",
      });
      yield* stack.deploy(
        code({ deployment, deployKey, env: { SITE_URL: "https://example.com" } }).pipe(adopt(true)),
      );
      expect(fake.variables.get(deployment)).toEqual({ SITE_URL: "https://example.com" });
    }),
  );

  test.provider("refuses env with a preview deploy key", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const preview = yield* Convex.Deployment("Preview", {
              projectId,
              type: "preview",
              name: "pr-42",
            });
            const key = yield* Convex.PreviewDeployKey("PreviewKey", { projectId, name: "ci" });
            const backend = yield* Convex.Code("Backend", {
              deployment: preview,
              deployKey: key.previewDeployKey,
              cwd: APP,
              command: COMMAND,
              env: { SITE_URL: "https://example.com" },
            });
            return { url: backend.url };
          }),
        ),
      );
      expect(error).toBeInstanceOf(Convex.EnvironmentNeedsDeployKey);
      expect(runs()).toEqual([]);
    }),
  );
});
