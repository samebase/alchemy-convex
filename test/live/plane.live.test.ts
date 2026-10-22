// Live Convex plane sequence through the real Alchemy engine and the real
// Convex CLI. Runs only with ALCHEMY_CONVEX_LIVE=1 and a Convex login
// (CONVEX_ACCESS_TOKEN or `npx convex login`) that can create projects in
// ALCHEMY_CONVEX_LIVE_TEAM.
//
// The test creates one disposable project, <prefix>plane-<8 hex>, and deletes
// it at the end, also when a step fails. A guard around fetch refuses every
// project delete and every deployment delete whose project name does not
// start with the prefix, including the deletes that the engine starts.
//
// It pushes a copy of test/fixtures/convex-app from a temporary directory,
// so the edits of the test never touch this repository. Secrets are never
// printed: the deploy keys that the test makes stay in variables.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Alchemy from "alchemy";
import * as Core from "alchemy/Test/Core";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { assert, expect, vi } from "vitest";
import { fromConfig } from "../../src/Credentials.ts";
import * as Convex from "../../src/index.ts";
import { absentAsUndefined, ManagementApi, ManagementApiLive } from "../../src/ManagementApi.ts";
import { liveEnabled, liveTargets } from "./env.ts";

const { prefix: PREFIX, team } = liveTargets;
const hex = randomBytes(4).toString("hex");
const projectName = `${PREFIX}plane-${hex}`;
const previewStage = `pr-${hex}`;
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/convex-app", import.meta.url));

/** One request that left this process: method, host, path, status. Never headers or bodies. */
const sent: string[] = [];
const since = (from: number) => sent.slice(from);
/** Writes a step result to stderr: the test runner hides console output of a passed test. */
const report = (line: string) => process.stderr.write(`${line}\n`);

const Named = Schema.Struct({ name: Schema.String });
const InProject = Schema.Struct({ projectId: Schema.Number });

const guardFetch = (realFetch: typeof fetch): typeof fetch =>
  async function guardedFetch(input, init) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = { Authorization: request.headers.get("Authorization") ?? "" };
    const projectNameOf = async (projectId: string) => {
      const check = await realFetch(`${url.origin}/v1/projects/${projectId}`, {
        headers: authorization,
      });
      return check.ok ? Schema.decodeUnknownSync(Named)(await check.json()).name : undefined;
    };
    const projectDelete = /^\/v1\/projects\/(\d+)\/delete$/.exec(url.pathname)?.[1];
    const deploymentDelete = /^\/v1\/deployments\/([^/]+)\/delete$/.exec(url.pathname)?.[1];
    if (request.method === "POST" && projectDelete !== undefined) {
      if (!(await projectNameOf(projectDelete))?.startsWith(PREFIX)) {
        throw new Error(`Refused to delete project ${projectDelete}: wrong name prefix`);
      }
    }
    if (request.method === "POST" && deploymentDelete !== undefined) {
      const check = await realFetch(`${url.origin}/v1/deployments/${deploymentDelete}`, {
        headers: authorization,
      });
      const owner = check.ok
        ? await projectNameOf(
            String(Schema.decodeUnknownSync(InProject)(await check.json()).projectId),
          )
        : undefined;
      if (check.ok && !owner?.startsWith(PREFIX)) {
        throw new Error(`Refused to delete deployment ${deploymentDelete}: wrong project`);
      }
    }
    const response = await realFetch(request);
    sent.push(`${request.method} ${url.host}${url.pathname} ${response.status}`);
    return response;
  };

const managementApi = ManagementApiLive().pipe(Layer.provide(fromConfig()));
const tokenOptions = { providers: Convex.providers() };
const { test } = Test.make(tokenOptions);

/** A Convex app in a temporary directory, with this repository's node_modules (the real Convex CLI). */
const makeApp = () => {
  const dir = mkdtempSync(join(tmpdir(), "alchemy-convex-plane-"));
  mkdirSync(join(dir, "convex"));
  copyFileSync(join(FIXTURE, "package.json"), join(dir, "package.json"));
  // The content hash covers every file that git does not ignore.
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
};

/** Writes the one query of the app: it answers `<version>:<PLANE_VAR>`. */
const writeQuery = (app: string, version: string) =>
  writeFileSync(
    join(app, "convex", "hello.ts"),
    `import { queryGeneric } from "convex/server";
export const hello = queryGeneric({
  args: {},
  handler: async () => \`${version}:\${process.env.PLANE_VAR ?? ""}\`,
});
`,
  );

/** Runs the query on a deployment through its HTTP API. */
const hello = (url: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${url}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "hello:hello", args: {}, format: "json" }),
    });
    return Schema.decodeUnknownSync(
      Schema.Struct({ status: Schema.String, value: Schema.Unknown }),
    )(await response.json()).value;
  });

const getDeployment = (name: string) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    return yield* absentAsUndefined(
      api.request("get deployment", (client) =>
        client.GET("/deployments/{deployment_name}", {
          params: { path: { deployment_name: name } },
        }),
      ),
    );
  });

const listKeyNames = (deployment: string) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    const body = yield* api.request("list deploy keys", (client) =>
      client.GET("/deployments/{deployment_name}/list_deploy_keys", {
        params: { path: { deployment_name: deployment } },
      }),
    );
    return Schema.decodeUnknownSync(Schema.Array(Named))(body).map((key) => key.name);
  });

/** Deletes the project of this run, found by id or by its slug. Refuses another name. */
const cleanup = (projectIds: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    const ids = new Set(projectIds);
    const bySlug = yield* absentAsUndefined(
      api.request("get project by slug", (client) =>
        client.GET("/teams/{team_id_or_slug}/projects/{project_slug}", {
          params: { path: { team_id_or_slug: team, project_slug: projectName } },
        }),
      ),
    );
    if (bySlug !== undefined)
      ids.add(Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(bySlug).id);
    for (const id of ids) {
      const body = yield* absentAsUndefined(
        api.request("get project", (client) =>
          client.GET("/projects/{project_id}", { params: { path: { project_id: id } } }),
        ),
      );
      if (body === undefined) continue;
      const { name } = Schema.decodeUnknownSync(Named)(body);
      assert(name.startsWith(PREFIX), `cleanup refused project ${id}`);
      yield* api.requestVoid("delete project", (client) =>
        client.POST("/projects/{project_id}/delete", { params: { path: { project_id: id } } }),
      );
      report(`cleanup deleted project ${id} (${name})`);
    }
  });

const pushKeyCalls = (lines: readonly string[]) =>
  lines.filter((line) => /\/(create|delete)_deploy_key /.test(line));

const sequence = (created: number[], app: string) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    // The app directory as a stack passes it, relative to the working directory.
    const rootDir = relative(process.cwd(), app);
    const source = "./convex";
    const prodStack = Core.scratchStack(tokenOptions, `alchemy-convex-plane-prod-${hex}`);
    const adoptStack = Core.scratchStack(tokenOptions, `alchemy-convex-plane-adopt-${hex}`);
    const previewStack = Core.scratchStack(
      { ...tokenOptions, stage: previewStage },
      `alchemy-convex-plane-preview-${hex}`,
    );

    // 1. Create the project, and push to its production deployment with one variable.
    writeQuery(app, "v1");
    const production = (value: string) =>
      Effect.gen(function* () {
        const project = yield* Convex.Project("Project", { team, name: projectName });
        const prod = yield* Convex.Deployment("Prod", {
          project,
          type: "prod",
          rootDir,
          source,
          env: { PLANE_VAR: value },
        });
        return {
          projectId: project.projectId,
          slug: project.slug,
          name: prod.name,
          url: prod.url,
          hash: prod.hash,
        };
      });
    const from1 = sent.length;
    const first = yield* prodStack.deploy(production("one"));
    created.push(first.projectId);
    expect(yield* hello(first.url)).toBe("v1:one");
    const keyCalls1 = pushKeyCalls(since(from1));
    expect(keyCalls1).toHaveLength(2);
    expect((yield* listKeyNames(first.name)).includes("alchemy-push")).toBe(false);
    report(
      `1. project ${first.projectId}: pushed to ${first.name}, query answers v1:one; push key calls: ${keyCalls1.join(", ")}`,
    );

    // 2. The same stack again: a no-op, no key, no push.
    const from2 = sent.length;
    const second = yield* prodStack.deploy(production("one"));
    expect(second).toEqual(first);
    expect(pushKeyCalls(since(from2))).toEqual([]);
    report(`2. unchanged source and env: no-op; requests: ${since(from2).join(", ")}`);

    // 3. Change the function: an update and a push.
    writeQuery(app, "v2");
    const from3 = sent.length;
    const third = yield* prodStack.deploy(production("one"));
    expect(third.name).toBe(first.name);
    expect(third.hash).not.toBe(first.hash);
    expect(yield* hello(first.url)).toBe("v2:one");
    expect(pushKeyCalls(since(from3))).toHaveLength(2);
    report(`3. changed hello.ts: pushed again, query answers v2:one`);

    // 3b. A failed push sets the variables back: new env and a broken function.
    const broken = () => writeFileSync(join(app, "convex", "hello.ts"), "export const hello = ;\n");
    broken();
    const failed = yield* Effect.flip(prodStack.deploy(production("two")));
    expect(failed).toMatchObject({ _tag: "CodePushFailed" });
    expect(yield* hello(first.url)).toBe("v2:one");
    writeQuery(app, "v2");
    const from3b = sent.length;
    const restored = yield* prodStack.deploy(production("one"));
    expect(restored.hash).toBe(third.hash);
    expect(pushKeyCalls(since(from3b))).toEqual([]);
    report("3b. failed push with env two: PLANE_VAR is back to one, and the old props are a no-op");

    // 3c. A production deployment with code needs --adopt in another state.
    const otherState = Core.scratchStack(tokenOptions, `alchemy-convex-plane-other-${hex}`);
    const takeover = Effect.gen(function* () {
      const prod = yield* Convex.Deployment("Prod", {
        project: { projectId: first.projectId },
        type: "prod",
        rootDir,
        source,
      });
      return { name: prod.name };
    });
    const refusedProd = yield* Effect.flip(otherState.deploy(takeover));
    expect(refusedProd).toMatchObject({ _tag: "OwnedBySomeoneElse" });
    report(`3c. another state refused to push to ${first.name} without --adopt`);

    // 4. Take the project over by slug in another state, only with --adopt.
    const bySlug = Effect.gen(function* () {
      const project = yield* Convex.Project("Project", { team, slug: first.slug });
      return { projectId: project.projectId };
    });
    const refused = yield* Effect.flip(adoptStack.deploy(bySlug));
    expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
    const adopted = yield* adoptStack.deploy(bySlug.pipe(adopt(true)));
    expect(adopted.projectId).toBe(first.projectId);
    yield* adoptStack.destroy();
    expect(yield* getDeployment(first.name)).toBeDefined();
    report(`4. adopted project ${adopted.projectId} by slug ${first.slug}, destroy kept it`);

    // 5. A preview deployment named after the stage, deleted on destroy.
    const preview = Effect.gen(function* () {
      const { stage } = yield* Alchemy.Stack;
      const project = yield* Convex.Project("Project", { team, slug: first.slug }).pipe(
        adopt(true),
      );
      const deployment = yield* Convex.Deployment("Preview", {
        project,
        type: "preview",
        name: stage,
        rootDir,
        source,
        env: { PLANE_VAR: "preview" },
      }).pipe(RemovalPolicy.destroy());
      return { name: deployment.name, previewName: deployment.previewName, url: deployment.url };
    });
    // A failed first push deletes the preview deployment that it created.
    broken();
    const failedPreview = yield* Effect.flip(previewStack.deploy(preview));
    expect(failedPreview).toMatchObject({ _tag: "CodePushFailed" });
    const previews = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({ previewIdentifier: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
      ),
    )(
      yield* api.request("list deployments", (client) =>
        client.GET("/projects/{project_id}/list_deployments", {
          params: { path: { project_id: first.projectId }, query: { deploymentType: "preview" } },
        }),
      ),
    );
    expect(previews.filter((row) => row.previewIdentifier === previewStage)).toEqual([]);
    report(`5a. a failed first push to preview ${previewStage} deleted the deployment it created`);
    writeQuery(app, "v2");
    const previewOut = yield* previewStack.deploy(preview);
    expect(previewOut.previewName).toBe(previewStage);
    expect(yield* hello(previewOut.url)).toBe("v2:preview");
    yield* previewStack.destroy();
    expect(yield* getDeployment(previewOut.name)).toBeUndefined();
    report(
      `5. stage ${previewStage}: preview ${previewOut.name} answered v2:preview; destroy deleted it`,
    );

    // 6. A preview deploy key alone, with no access token: create, push, delete.
    const previewKey = Redacted.make(
      Schema.decodeUnknownSync(Schema.Struct({ previewDeployKey: Schema.String }))(
        yield* api.request("create preview deploy key", (client) =>
          client.POST("/projects/{project_id}/create_preview_deploy_key", {
            params: { path: { project_id: first.projectId } },
            body: { name: "tmp-plane-live" },
          }),
        ),
      ).previewDeployKey,
    );
    const keyOptions = (deployKey: Redacted.Redacted<string>) => ({
      providers: Convex.providers(Convex.fromValues({ deployKey })),
    });
    const previewKeyStack = Core.scratchStack(
      { ...keyOptions(previewKey), stage: `${previewStage}-key` },
      `alchemy-convex-plane-preview-key-${hex}`,
    );
    const viaPreviewKey = Effect.gen(function* () {
      const { stage } = yield* Alchemy.Stack;
      const deployment = yield* Convex.Deployment("Preview", {
        project: { projectId: first.projectId },
        type: "preview",
        name: stage,
        rootDir,
        source,
      }).pipe(RemovalPolicy.destroy());
      return { name: deployment.name, url: deployment.url };
    });
    const from6 = sent.length;
    const keyPreview = yield* previewKeyStack.deploy(viaPreviewKey);
    expect(yield* hello(keyPreview.url)).toBe("v2:");
    yield* previewKeyStack.destroy();
    expect(yield* getDeployment(keyPreview.name)).toBeUndefined();
    expect(pushKeyCalls(since(from6))).toEqual([]);
    report(
      `6. preview deploy key alone: created, pushed to, and deleted ${keyPreview.name}; requests: ${since(from6).join(", ")}`,
    );

    // 7. A production deploy key alone, with no access token: env and push, no Management API call.
    const now = Date.now();
    const deployKey = Redacted.make(
      Schema.decodeUnknownSync(Schema.Struct({ deployKey: Schema.String }))(
        yield* api.request("create deploy key", (client) =>
          client.POST("/deployments/{deployment_name}/create_deploy_key", {
            params: { path: { deployment_name: first.name } },
            body: { name: "tmp-plane-live", expiresAt: now + 31 * 60 * 1000 },
          }),
        ),
      ).deployKey,
    );
    const deployKeyStack = Core.scratchStack(
      keyOptions(deployKey),
      `alchemy-convex-plane-deploy-key-${hex}`,
    );
    writeQuery(app, "v3");
    const from7 = sent.length;
    const viaDeployKey = yield* deployKeyStack.deploy(
      Effect.gen(function* () {
        const prod = yield* Convex.Deployment("Prod", {
          project: { projectId: first.projectId },
          type: "prod",
          rootDir,
          source,
          env: { PLANE_VAR: "key" },
          // Another state set PLANE_VAR in step 1: overwriting it needs --adopt.
        }).pipe(adopt(true));
        return { name: prod.name, url: prod.url };
      }),
    );
    expect(viaDeployKey.name).toBe(first.name);
    expect(yield* hello(first.url)).toBe("v3:key");
    expect(since(from7).filter((line) => line.includes("api.convex.dev"))).toEqual([]);
    yield* deployKeyStack.destroy();
    report(
      `7. production deploy key alone: pushed v3 with env; requests: ${since(from7).join(", ")}`,
    );

    // 8. Destroy the production stack with the default policies: the project,
    // the production deployment, and its functions stay.
    const from8 = sent.length;
    yield* prodStack.destroy();
    expect(yield* getDeployment(first.name)).toBeDefined();
    expect(yield* hello(first.url)).toBe("v3:key");
    expect(since(from8).filter((line) => /\/delete /.test(line))).toEqual([]);
    report(
      `8. destroy with the default policies kept project ${first.projectId} and ${first.name}`,
    );
  });

test.skipIf(!liveEnabled)(
  "live: the Convex plane creates, pushes, skips, previews, and retains",
  Effect.gen(function* () {
    vi.stubGlobal("fetch", guardFetch(globalThis.fetch));
    const created: number[] = [];
    const app = makeApp();
    yield* sequence(created, app).pipe(
      Effect.ensuring(cleanup(created).pipe(Effect.orDie)),
      Effect.ensuring(Effect.sync(() => rmSync(app, { recursive: true, force: true }))),
      Effect.provide(managementApi),
    );
    report(`requests: ${sent.length}`);
  }),
  { timeout: 900_000 },
);
