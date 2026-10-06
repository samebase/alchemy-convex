// Live Convex.Deployment and Convex.Code sequence through the real Alchemy
// engine and the real Convex CLI. Runs only with ALCHEMY_CONVEX_LIVE=1 and a
// Convex login (CONVEX_ACCESS_TOKEN or `npx convex login`) that can create
// projects in ALCHEMY_CONVEX_LIVE_TEAM.
//
// The test creates one disposable project, tmp-alchemy-convex-<8 hex>, and
// deletes it at the end, also when a step fails. A guard around fetch refuses
// every project delete whose project name does not start with
// tmp-alchemy-convex-, and every deployment delete whose project name does not
// start with it, including the deletes that the engine starts.
//
// Assertions compare secrets as booleans so a failure never prints one.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Core from "alchemy/Test/Core";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, expect, vi } from "vitest";
import { fromConfig } from "../../src/Credentials.ts";
import { listVariables } from "../../src/EnvironmentVariable.ts";
import * as Convex from "../../src/index.ts";
import { absentAsUndefined, ManagementApi, ManagementApiLive } from "../../src/ManagementApi.ts";
import { ProjectPage } from "../../src/Project.ts";
import { liveEnabled, liveTargets } from "./env.ts";

const PREFIX = "tmp-alchemy-convex-";
const hex = randomBytes(4).toString("hex");
const projectName = `${PREFIX}${hex}`;
const previewName = `pr-${hex}`;
const variable = `TMP_ALCHEMY_CONVEX_${hex.toUpperCase()}`;
const { team } = liveTargets;
const APP = fileURLToPath(new URL("../fixtures/convex-app", import.meta.url));

/** One request that left this process: method, host, path, status. Never headers or bodies. */
const sent: string[] = [];

const Named = Schema.Struct({ name: Schema.String });
const InProject = Schema.Struct({ projectId: Schema.Number });

/**
 * Wraps fetch. Before a project delete or a deployment delete, it reads the
 * project and throws unless its name starts with tmp-alchemy-convex-. It
 * records each request line.
 */
const guardFetch = (realFetch: typeof fetch): typeof fetch =>
  async function guardedFetch(input, init) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = { Authorization: request.headers.get("Authorization") ?? "" };
    const projectName = async (projectId: string) => {
      const check = await realFetch(`${url.origin}/v1/projects/${projectId}`, {
        headers: authorization,
      });
      return check.ok ? Schema.decodeUnknownSync(Named)(await check.json()).name : undefined;
    };
    const projectDelete = /^\/v1\/projects\/(\d+)\/delete$/.exec(url.pathname)?.[1];
    const deploymentDelete = /^\/v1\/deployments\/([^/]+)\/delete$/.exec(url.pathname)?.[1];
    if (request.method === "POST" && projectDelete !== undefined) {
      if (!(await projectName(projectDelete))?.startsWith(PREFIX)) {
        throw new Error(
          `Refused to delete project ${projectDelete}: its name does not start with ${PREFIX}`,
        );
      }
    }
    if (request.method === "POST" && deploymentDelete !== undefined) {
      const check = await realFetch(`${url.origin}/v1/deployments/${deploymentDelete}`, {
        headers: authorization,
      });
      const owner = check.ok
        ? await projectName(
            String(Schema.decodeUnknownSync(InProject)(await check.json()).projectId),
          )
        : undefined;
      if (check.ok && !owner?.startsWith(PREFIX)) {
        throw new Error(
          `Refused to delete deployment ${deploymentDelete}: its project name does not start with ${PREFIX}`,
        );
      }
    }
    const response = await realFetch(request);
    sent.push(`${request.method} ${url.host}${url.pathname} ${response.status}`);
    return response;
  };

const options = { providers: Convex.providers() };
const { test } = Test.make(options);

const managementApi = ManagementApiLive().pipe(Layer.provide(fromConfig()));

/** The deployment row, or undefined after a 404. */
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

/** Runs the fixture query on a deployment through its HTTP API. */
const hello = (url: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${url}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "hello:hello", args: {}, format: "json" }),
    });
    return Schema.decodeUnknownSync(
      Schema.Struct({ status: Schema.String, value: Schema.Unknown }),
    )(await response.json());
  });

/** Deletes every project of this run, found by id or by name. Refuses other names. */
const cleanup = (projectIds: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    const teamId = yield* api.resolveTeamId(team);
    const ids = new Set(projectIds);
    const page = Schema.decodeUnknownSync(ProjectPage)(
      yield* api.request("list projects", (client) =>
        client.GET("/teams/{team_id}/projects", {
          params: { path: { team_id: teamId }, query: { q: projectName } },
        }),
      ),
    );
    for (const row of page.items) if (row.name === projectName) ids.add(row.id);
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
      console.log(`cleanup deleted project ${id} (${name})`);
    }
  });

const sequence = (created: number[]) =>
  Effect.gen(function* () {
    const prodStack = Core.scratchStack(options, `alchemy-convex-code-prod-${hex}`);
    const previewStack = Core.scratchStack(options, `alchemy-convex-code-preview-${hex}`);
    const removeStack = Core.scratchStack(options, `alchemy-convex-code-remove-${hex}`);

    // 1. Project, production deployment, deploy key, and a push with one variable.
    const projectOnly = Effect.gen(function* () {
      const project = yield* Convex.Project("Project", { team, name: projectName });
      return { projectId: project.projectId };
    });
    const production = Effect.gen(function* () {
      const project = yield* Convex.Project("Project", { team, name: projectName });
      const prod = yield* Convex.Deployment("Prod", {
        projectId: project.projectId,
        type: "prod",
      });
      const key = yield* Convex.DeployKey("DeployKey", {
        deployment: prod.name,
        name: "alchemy",
        allowedActions: ["deployment:deploy", "deployment:env:view", "deployment:env:write"],
      });
      const backend = yield* Convex.Code("Backend", {
        deployment: prod,
        deployKey: key.deployKey,
        cwd: APP,
        typecheck: "disable",
        codegen: "disable",
        env: { [variable]: "alchemy-convex-live" },
      });
      return {
        projectId: project.projectId,
        prod: prod.name,
        prodUrl: prod.url,
        prodSiteUrl: prod.siteUrl,
        deployKey: key.deployKey,
        deploymentName: backend.deploymentName,
        url: backend.url,
        siteUrl: backend.siteUrl,
        deployedAt: backend.deployedAt,
        envNames: backend.envNames,
      };
    });
    const prod = yield* prodStack.deploy(production);
    created.push(prod.projectId);
    expect(prod.deploymentName).toBe(prod.prod);
    expect(prod.url).toBe(prod.prodUrl);
    expect(prod.siteUrl).toBe(prod.prodSiteUrl);
    expect(prod.siteUrl).toBe(prod.url.replace(".convex.cloud", ".convex.site"));
    expect(prod.envNames).toEqual([variable]);
    expect(yield* hello(prod.url)).toEqual({
      status: "success",
      value: "hello from alchemy-convex",
    });
    const variables = yield* listVariables(prod.prod, prod.deployKey);
    expect(variables[variable] === "alchemy-convex-live").toBe(true);
    console.log(
      `1. project ${prod.projectId}: pushed to production ${prod.prod}, the query answers`,
    );

    // 2. A preview deployment created through the Management API, and a push
    // with the project's preview deploy key and --preview-name.
    const previewStage = Effect.gen(function* () {
      const deployment = yield* Convex.Deployment("Preview", {
        projectId: prod.projectId,
        type: "preview",
        name: previewName,
      }).pipe(RemovalPolicy.destroy());
      const key = yield* Convex.PreviewDeployKey("PreviewDeployKey", {
        projectId: prod.projectId,
        name: "alchemy",
      });
      const backend = yield* Convex.Code("Backend", {
        deployment,
        deployKey: key.previewDeployKey,
        cwd: APP,
        typecheck: "disable",
        codegen: "disable",
      });
      return {
        name: deployment.name,
        previewName: deployment.previewName,
        reference: deployment.reference,
        url: deployment.url,
        siteUrl: deployment.siteUrl,
        pushedTo: backend.deploymentName,
        backendUrl: backend.url,
        backendSiteUrl: backend.siteUrl,
        deployedAt: backend.deployedAt,
      };
    });
    const preview = yield* previewStack.deploy(previewStage);
    expect(preview.previewName).toBe(previewName);
    expect(preview.pushedTo).toBe(preview.name);
    expect(preview.backendUrl).toBe(preview.url);
    expect(preview.backendSiteUrl).toBe(preview.siteUrl);
    expect(yield* hello(preview.url)).toEqual({
      status: "success",
      value: "hello from alchemy-convex",
    });
    console.log(
      `2. preview ${preview.name} (${preview.reference}): pushed with the preview deploy key, the query answers`,
    );

    // 3. The next apply pushes again to the same preview deployment.
    const again = yield* previewStack.deploy(previewStage);
    expect(again.name).toBe(preview.name);
    expect(again.pushedTo).toBe(preview.name);
    expect(again.deployedAt).toBeGreaterThan(preview.deployedAt);
    console.log(`3. the second apply pushed again to ${again.name}`);

    // 4. Destroy the preview stage: RemovalPolicy.destroy() deletes the preview deployment.
    yield* previewStack.destroy();
    expect(yield* getDeployment(preview.name)).toBeUndefined();
    console.log(`4. destroying the preview stage deleted ${preview.name}`);

    // 5. Remove the production resources with the default policy: the
    // production deployment stays, and so do its functions.
    const beforeRemove = sent.length;
    yield* prodStack.deploy(projectOnly);
    expect(yield* getDeployment(prod.prod)).toBeDefined();
    expect(
      sent
        .slice(beforeRemove)
        .filter((line) => /\/delete /.test(line) && !line.includes("deploy_key")),
    ).toEqual([]);
    expect(yield* hello(prod.url)).toEqual({
      status: "success",
      value: "hello from alchemy-convex",
    });
    console.log(
      `5. removed Deployment and Code with the default policy; ${prod.prod} still answers`,
    );

    // 6. Adopt the project into a fresh state with RemovalPolicy.destroy(), then destroy it.
    yield* removeStack.deploy(
      Effect.gen(function* () {
        const project = yield* Convex.Project("Project", { team, name: projectName }).pipe(
          adopt(true),
          RemovalPolicy.destroy(),
        );
        return { projectId: project.projectId };
      }),
    );
    yield* removeStack.destroy();
    expect(yield* getDeployment(prod.prod)).toBeUndefined();
    console.log(`6. RemovalPolicy.destroy() deleted project ${prod.projectId}`);
  });

test.skipIf(!liveEnabled)(
  "live: Deployment and Code push to production and to a preview",
  Effect.gen(function* () {
    vi.stubGlobal("fetch", guardFetch(globalThis.fetch));
    const created: number[] = [];
    yield* sequence(created).pipe(
      Effect.ensuring(cleanup(created).pipe(Effect.orDie)),
      Effect.provide(managementApi),
    );
    console.log(`requests: ${sent.length}`);
  }),
  { timeout: 900_000 },
);
