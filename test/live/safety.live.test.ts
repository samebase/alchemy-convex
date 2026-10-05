// Live data-safety sequence through the real Alchemy engine. Runs only with
// ALCHEMY_CONVEX_LIVE=1 and a Convex login (CONVEX_ACCESS_TOKEN or
// `npx convex login`) that can create projects in ALCHEMY_CONVEX_LIVE_TEAM.
//
// The test creates one disposable project, tmp-alchemy-convex-<8 hex>, and
// deletes it at the end, also when a step fails. A guard around fetch refuses
// every project delete whose project name does not start with
// tmp-alchemy-convex-, including the deletes that the engine starts.
//
// Assertions compare secrets as booleans so a failure never prints one.
import { randomBytes } from "node:crypto";
import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Core from "alchemy/Test/Core";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { assert, expect, vi } from "vitest";
import { fromConfig } from "../../src/Credentials.ts";
import { DeployKeyList } from "../../src/DeployKey.ts";
import { EnvironmentVariableList, updateVariable } from "../../src/EnvironmentVariable.ts";
import * as Convex from "../../src/index.ts";
import { absentAsUndefined, ManagementApi, ManagementApiLive } from "../../src/ManagementApi.ts";
import { ProjectPage } from "../../src/Project.ts";
import { PreviewDeployKeyList } from "../../src/PreviewDeployKey.ts";
import { liveEnabled, liveTargets } from "./env.ts";

const PREFIX = "tmp-alchemy-convex-";
const hex = randomBytes(4).toString("hex");
const projectName = `${PREFIX}${hex}`;
const renamedName = `${PREFIX}${hex}-renamed`;
const keyName = `${PREFIX}key`;
const variable = `TMP_ALCHEMY_CONVEX_${hex.toUpperCase()}`;
const { team } = liveTargets;

/** One request that left this process: method, host, path, status. Never headers or bodies. */
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}
const sent: Sent[] = [];
/** The `id` of each delete_deploy_key and delete_preview_deploy_key body, to compare with secrets. */
const deletedKeyIds: string[] = [];

const ProjectName = Schema.Struct({ name: Schema.String });
const DeleteBody = Schema.Struct({ id: Schema.String });

/**
 * Wraps fetch. Before a project delete it reads the project and throws
 * unless the name starts with tmp-alchemy-convex-. It records each request
 * line and the ids of key deletes.
 */
const guardFetch = (realFetch: typeof fetch): typeof fetch =>
  async function guardedFetch(input, init) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const projectDelete = /^\/v1\/projects\/(\d+)\/delete$/.exec(url.pathname);
    if (request.method === "POST" && projectDelete !== null) {
      const authorization = request.headers.get("Authorization") ?? "";
      const check = await realFetch(`${url.origin}/v1/projects/${projectDelete[1]}`, {
        headers: { Authorization: authorization },
      });
      const current = check.ok
        ? Schema.decodeUnknownSync(ProjectName)(await check.json())
        : undefined;
      if (current === undefined || !current.name.startsWith(PREFIX)) {
        throw new Error(
          `Refused to delete project ${projectDelete[1]}: its name does not start with ${PREFIX}`,
        );
      }
    }
    if (request.method === "POST" && /\/delete(_preview)?_deploy_key$/.test(url.pathname)) {
      deletedKeyIds.push(Schema.decodeUnknownSync(DeleteBody)(await request.clone().json()).id);
    }
    const response = await realFetch(request);
    sent.push({
      method: request.method,
      path: `${url.host}${url.pathname}`,
      status: response.status,
    });
    return response;
  };

const options = { providers: Convex.providers() };
const { test } = Test.make(options);

const managementApi = ManagementApiLive().pipe(Layer.provide(fromConfig()));

/** The project row, or undefined after a 404. */
const getProject = (projectId: number) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    const body = yield* absentAsUndefined(
      api.request("get project", (client) =>
        client.GET("/projects/{project_id}", { params: { path: { project_id: projectId } } }),
      ),
    );
    return body === undefined
      ? undefined
      : Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String, slug: Schema.String }))(body);
  });

/** Deletes every project of this run, found by id or by its two names. Refuses other names. */
const cleanup = (projectIds: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    const teamId = yield* api.resolveTeamId(team);
    const ids = new Set(projectIds);
    for (const name of [projectName, renamedName]) {
      const page = Schema.decodeUnknownSync(ProjectPage)(
        yield* api.request("list projects", (client) =>
          client.GET("/teams/{team_id}/projects", {
            params: { path: { team_id: teamId }, query: { q: name } },
          }),
        ),
      );
      for (const row of page.items) if (row.name === name) ids.add(row.id);
    }
    for (const id of ids) {
      const current = yield* getProject(id);
      if (current === undefined) continue;
      assert(current.name.startsWith(PREFIX), `cleanup refused project ${id}`);
      yield* api.requestVoid("delete project", (client) =>
        client.POST("/projects/{project_id}/delete", { params: { path: { project_id: id } } }),
      );
      console.log(`cleanup deleted project ${id} (${current.name})`);
    }
  });

/** Requests sent since `from`, as "METHOD host/path STATUS" lines. */
const sentSince = (from: number) =>
  sent.slice(from).map((call) => `${call.method} ${call.path} ${call.status}`);

const sequence = (created: number[]) =>
  Effect.gen(function* () {
    const api = yield* ManagementApi;
    const stackA = Core.scratchStack(options, `alchemy-convex-safety-a-${hex}`);
    const stackB = Core.scratchStack(options, `alchemy-convex-safety-b-${hex}`);
    const stackC = Core.scratchStack(options, `alchemy-convex-safety-c-${hex}`);

    // 1. Create the project.
    const first = yield* stackA.deploy(
      Effect.gen(function* () {
        const project = yield* Convex.Project("Project", { team, name: projectName });
        return { projectId: project.projectId, slug: project.slug };
      }),
    );
    created.push(first.projectId);
    expect((yield* getProject(first.projectId))?.name).toBe(projectName);
    console.log(`1. created project ${first.projectId} (${projectName})`);

    // 2. Adopt it by name from a fresh state: refused without adoption, then adopted.
    const refused = yield* Effect.flip(
      stackB.deploy(
        Effect.gen(function* () {
          const project = yield* Convex.Project("Project", { team, name: projectName });
          return { projectId: project.projectId };
        }),
      ),
    );
    expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
    const adopted = yield* stackB.deploy(
      Effect.gen(function* () {
        const project = yield* Convex.Project("Project", { team, name: projectName }).pipe(
          adopt(true),
        );
        return { projectId: project.projectId };
      }),
    );
    expect(adopted.projectId).toBe(first.projectId);
    console.log(`2. a fresh state got OwnedBySomeoneElse, then adopted ${adopted.projectId}`);

    // 3. Rename in place with PATCH: same id, same slug, no create, no delete.
    const beforeRename = sent.length;
    const renamed = yield* stackB.deploy(
      Effect.gen(function* () {
        const project = yield* Convex.Project("Project", { team, name: renamedName });
        return { projectId: project.projectId, slug: project.slug, name: project.name };
      }),
    );
    expect(renamed).toEqual({ projectId: first.projectId, slug: first.slug, name: renamedName });
    expect((yield* getProject(first.projectId))?.name).toBe(renamedName);
    const renameCalls = sentSince(beforeRename);
    expect(renameCalls).toContain(`PATCH api.convex.dev/v1/projects/${first.projectId} 200`);
    expect(renameCalls.filter((line) => /create_project|\/delete /.test(line))).toEqual([]);
    console.log(`3. renamed with PATCH, id and slug unchanged: ${renameCalls.join(", ")}`);

    // 4. Two deploy keys and two preview deploy keys with one user-facing name.
    const withKeys = (keys: { readonly a: boolean }) =>
      Effect.gen(function* () {
        const project = yield* Convex.Project("Project", { team, name: renamedName });
        const deployment = project.prodDeploymentName.as<string>();
        const keyB = yield* Convex.DeployKey("KeyB", { deployment, name: keyName });
        const previewB = yield* Convex.PreviewDeployKey("PreviewB", {
          projectId: project.projectId,
          name: keyName,
        });
        const keyA = keys.a
          ? yield* Convex.DeployKey("KeyA", { deployment, name: keyName })
          : undefined;
        const previewA = keys.a
          ? yield* Convex.PreviewDeployKey("PreviewA", {
              projectId: project.projectId,
              name: keyName,
            })
          : undefined;
        return {
          deployment: project.prodDeploymentName,
          keyA: keyA?.uniqueName,
          keyASecret: keyA?.deployKey,
          keyB: keyB.uniqueName,
          keyBSecret: keyB.deployKey,
          previewA: previewA?.uniqueName,
          previewASecret: previewA?.previewDeployKey,
          previewB: previewB.uniqueName,
        };
      });
    const listKeys = (deployment: string) =>
      api
        .request("list deploy keys", (client) =>
          client.GET("/deployments/{deployment_name}/list_deploy_keys", {
            params: { path: { deployment_name: deployment } },
          }),
        )
        .pipe(
          Effect.map((body) => Schema.decodeUnknownSync(DeployKeyList)(body).map((k) => k.name)),
        );
    const listPreviewKeys = api
      .request("list preview deploy keys", (client) =>
        client.GET("/projects/{project_id}/list_preview_deploy_keys", {
          params: { path: { project_id: first.projectId } },
        }),
      )
      .pipe(
        Effect.map((body) =>
          Schema.decodeUnknownSync(PreviewDeployKeyList)(body).items.map((k) => k.name),
        ),
      );

    const both = yield* stackB.deploy(withKeys({ a: true }));
    const deployment = both.deployment;
    assert(deployment !== undefined, "the project has no production deployment");
    assert(both.keyA !== undefined && both.previewA !== undefined, "keys A were not created");
    assert(both.keyASecret !== undefined && both.previewASecret !== undefined, "no A secrets");
    expect(both.keyA).not.toBe(both.keyB);
    expect(both.previewA).not.toBe(both.previewB);
    expect(both.keyA.startsWith(`${keyName}-`) && both.keyB.startsWith(`${keyName}-`)).toBe(true);
    expect(yield* listKeys(deployment)).toEqual(expect.arrayContaining([both.keyA, both.keyB]));
    expect(yield* listPreviewKeys).toEqual(expect.arrayContaining([both.previewA, both.previewB]));
    console.log(
      `4. listed "${both.keyA}" and "${both.keyB}", previews "${both.previewA}" and "${both.previewB}"`,
    );

    // Remove KeyA and PreviewA: each delete sends its own secret, and B stays.
    const deletesBefore = deletedKeyIds.length;
    yield* stackB.deploy(withKeys({ a: false }));
    const deleteIds = deletedKeyIds.slice(deletesBefore);
    expect(deleteIds.length).toBe(2);
    expect(deleteIds.includes(Redacted.value(both.keyASecret))).toBe(true);
    expect(deleteIds.includes(Redacted.value(both.previewASecret))).toBe(true);
    expect(deleteIds.includes(Redacted.value(both.keyBSecret))).toBe(false);
    const keysAfter = yield* listKeys(deployment);
    expect(keysAfter.includes(both.keyA)).toBe(false);
    expect(keysAfter.includes(both.keyB)).toBe(true);
    const previewsAfter = yield* listPreviewKeys;
    expect(previewsAfter.includes(both.previewA)).toBe(false);
    expect(previewsAfter.includes(both.previewB)).toBe(true);
    // KeyB still authenticates on the deployment API.
    yield* api.deploymentRequest("list environment variables", deployment, both.keyBSecret, (c) =>
      c.GET("/list_environment_variables"),
    );
    console.log("4. delete by secret removed KeyA and PreviewA only; KeyB still authenticates");

    // 5. Two environment variables written in parallel by the engine, then a burst.
    const beforeWrites = sent.length;
    yield* stackB.deploy(
      Effect.gen(function* () {
        const keys = yield* withKeys({ a: false });
        // Outputs, not plain values: removal then deletes the variables before KeyB.
        for (const suffix of ["A", "B"]) {
          yield* Convex.EnvironmentVariable(`Var${suffix}`, {
            deployment: keys.deployment.as<string>(),
            deployKey: keys.keyBSecret,
            name: `${variable}_${suffix}`,
            value: Redacted.make(`alchemy-convex-live-${suffix}`),
          });
        }
        return keys;
      }),
    );
    yield* Effect.all(
      ["C", "D", "E", "F"].map((suffix) =>
        updateVariable(deployment, both.keyBSecret, `${variable}_${suffix}`, `burst-${suffix}`),
      ),
      { concurrency: "unbounded" },
    );
    const listed = Schema.decodeUnknownSync(EnvironmentVariableList)(
      yield* api.deploymentRequest("list environment variables", deployment, both.keyBSecret, (c) =>
        c.GET("/list_environment_variables"),
      ),
    ).environmentVariables;
    expect(listed[`${variable}_A`] === "alchemy-convex-live-A").toBe(true);
    expect(listed[`${variable}_B`] === "alchemy-convex-live-B").toBe(true);
    for (const suffix of ["C", "D", "E", "F"]) {
      expect(listed[`${variable}_${suffix}`] === `burst-${suffix}`).toBe(true);
    }
    const writes = sentSince(beforeWrites).filter((line) =>
      line.includes("/update_environment_variables"),
    );
    console.log(`5. environment variable writes: ${writes.join(", ")}`);

    // 6. Remove every resource with the default policy: the project stays.
    const beforeRemove = sent.length;
    yield* stackB.deploy(Effect.succeed({}));
    expect((yield* getProject(first.projectId))?.name).toBe(renamedName);
    expect(
      sentSince(beforeRemove).filter(
        (line) => line.includes("/v1/projects/") && line.includes("/delete "),
      ),
    ).toEqual([]);
    console.log("6. removed the resource with the default policy; the project still exists");

    // 7. Adopt into a fresh state with RemovalPolicy.destroy(), then destroy: the project is gone.
    const destroyable = yield* stackC.deploy(
      Effect.gen(function* () {
        const project = yield* Convex.Project("Project", { team, name: renamedName }).pipe(
          adopt(true),
          RemovalPolicy.destroy(),
        );
        return { projectId: project.projectId };
      }),
    );
    expect(destroyable.projectId).toBe(first.projectId);
    yield* stackC.destroy();
    expect(yield* getProject(first.projectId)).toBeUndefined();
    console.log(`7. RemovalPolicy.destroy() deleted project ${first.projectId}`);
  });

test.skipIf(!liveEnabled)(
  "live: project and key handling never loses data",
  Effect.gen(function* () {
    vi.stubGlobal("fetch", guardFetch(globalThis.fetch));
    const created: number[] = [];
    yield* sequence(created).pipe(
      Effect.ensuring(cleanup(created).pipe(Effect.orDie)),
      Effect.provide(managementApi),
    );
  }),
  { timeout: 600_000 },
);
