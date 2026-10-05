// A fake Convex control plane behind a stubbed `fetch`, for tests that run
// the providers through the real Alchemy engine. It answers the Management
// API (https://api.convex.dev/v1) and the deployment API
// (https://<deployment>.convex.cloud/api/v1). Every response body is a
// recorded payload from fixtures/management with only the fields that a
// scenario needs changed.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

export const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/management/${file}`, import.meta.url), "utf8"));

const Fields = Schema.Record(Schema.String, Schema.Unknown);
/** A recorded object payload as a plain record, so a scenario can derive a changed copy. */
export const recorded = (file: string) => Schema.decodeUnknownSync(Fields)(fixture(file));
const [recordedKeyRow] = Schema.decodeUnknownSync(Schema.Tuple([Fields]))(
  fixture("deployment_list_deploy_keys.json"),
);
const [recordedDeploymentRow] = Schema.decodeUnknownSync(Schema.Tuple([Fields]))(
  fixture("project_list_deployments.json"),
);
const recordedSecret = Schema.decodeUnknownSync(Schema.Struct({ deployKey: Schema.String }))(
  fixture("deployment_create_deploy_key.json"),
).deployKey;

/** One request that reached the fake. */
export interface Sent {
  readonly method: string;
  /** Host and path, such as `api.convex.dev/v1/projects/3145389`. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

interface Key {
  readonly id: number;
  readonly name: string;
  readonly secret: string;
}

const RequestBody = Schema.UndefinedOr(Fields);
const Changes = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.optionalKey(Schema.NullOr(Schema.String)),
      deploymentType: Schema.optionalKey(Schema.String),
    }),
  ),
});
const ProjectFields = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  teamId: Schema.Number,
  prodDeploymentName: Schema.NullOr(Schema.String),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = () => new Response(null, { status: 200 });
const notFound = (code: string) =>
  json(404, { ...recorded("project_not_found.json"), code, message: `${code} (fake)` });

export class FakeConvex {
  /** Every request, in order. */
  readonly sent: Sent[] = [];
  /** Project rows: recorded GET /projects/{id} payloads with changed fields. */
  readonly projects: Record<string, unknown>[] = [];
  /** Deploy keys for each deployment name. */
  readonly keys = new Map<string, Key[]>();
  /** Preview deploy keys for each project id. */
  readonly previewKeys = new Map<number, Key[]>();
  /** Environment variables for each deployment name. */
  readonly variables = new Map<string, Record<string, string>>();
  /** Project default environment variables. */
  readonly defaults: { projectId: number; name: string; deploymentType: string }[] = [];
  /**
   * Answers sent before the normal handler, for "METHOD host/path" keys,
   * such as a recorded write conflict. Each answer is used once.
   */
  readonly scripted = new Map<string, { status: number; body: unknown }[]>();
  /** Page size of GET /teams/{team_id}/projects. */
  pageSize = 100;
  /** Rows that GET /teams/{team_id}/projects leaves out while this is above zero, one call at a time. */
  hideProjectsFromListings = 0;
  private nextId = 9_100_000;

  /** Stubs the global fetch. The Convex clients read it when they are created. */
  install() {
    vi.stubGlobal("fetch", this.fetch);
    return this;
  }

  /** Adds a project from the recorded project payload and returns its id. */
  addProject(fields: { readonly name: string; readonly teamId: number }) {
    const id = this.nextId++;
    const prodDeploymentName = `fake-deployment-${id}`;
    this.projects.push({
      ...recorded("project.json"),
      id,
      name: fields.name,
      slug: fields.name,
      teamId: fields.teamId,
      prodDeploymentName,
      devDeploymentName: null,
    });
    return id;
  }

  /** The current row of a project, decoded. */
  project(id: number) {
    const row = this.projects.find((candidate) => candidate["id"] === id);
    return row === undefined ? undefined : Schema.decodeUnknownSync(ProjectFields)(row);
  }

  /** Requests sent so far as "METHOD host/path" lines. */
  lines(from = 0) {
    return this.sent.slice(from).map((request) => `${request.method} ${request.path}`);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const body = Schema.decodeUnknownSync(RequestBody)(text === "" ? undefined : JSON.parse(text));
    const path = `${url.host}${url.pathname}`;
    this.sent.push({ method: request.method, path, query: url.searchParams, body });
    const next = this.scripted.get(`${request.method} ${path}`)?.shift();
    if (next !== undefined) return json(next.status, next.body);
    return this.route(request.method, url, body);
  };

  private route(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
    const deploymentHost = /^([a-z0-9-]+)\.convex\.cloud$/.exec(url.host);
    if (deploymentHost !== null)
      return this.deploymentApi(deploymentHost[1] ?? "", method, url, body);
    const route = `${method} ${url.pathname.replace(/\/\d+(?=\/|$)/g, "/{id}")}`;
    const id = Number(/\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1]);
    const deployment = /^\/v1\/deployments\/([^/]+)\//.exec(url.pathname)?.[1] ?? "";
    switch (route) {
      case "GET /v1/teams/{id}/projects":
        return this.listProjects(id, url.searchParams);
      case "POST /v1/teams/{id}/create_project": {
        const created = this.addProject({ name: String(body?.["projectName"]), teamId: id });
        const row = this.project(created);
        return json(200, {
          ...recorded("team_create_project.json"),
          projectId: created,
          id: created,
          slug: row?.name,
          deploymentName: row?.prodDeploymentName,
          deploymentUrl: `https://${row?.prodDeploymentName}.convex.cloud`,
        });
      }
      case "GET /v1/projects/{id}": {
        const row = this.projects.find((candidate) => candidate["id"] === id);
        return row === undefined ? notFound("ProjectNotFound") : json(200, row);
      }
      case "PATCH /v1/projects/{id}": {
        const row = this.projects.find((candidate) => candidate["id"] === id);
        if (row === undefined) return notFound("ProjectNotFound");
        row["name"] = body?.["name"];
        return json(200, { ...recorded("project_update.json"), ...row });
      }
      case "POST /v1/projects/{id}/delete": {
        const index = this.projects.findIndex((candidate) => candidate["id"] === id);
        if (index === -1) return notFound("ProjectNotFound");
        this.projects.splice(index, 1);
        return empty();
      }
      case "GET /v1/projects/{id}/list_deployments": {
        const row = this.project(id);
        if (row === undefined) return notFound("ProjectNotFound");
        return json(200, [
          {
            ...recordedDeploymentRow,
            name: row.prodDeploymentName,
            projectId: id,
            deploymentType: "prod",
            isDefault: true,
            deploymentUrl: `https://${row.prodDeploymentName}.convex.cloud`,
          },
        ]);
      }
      default:
        break;
    }
    // Keys and project defaults: /v1/deployments/{name}/<route> and /v1/projects/{id}/<route>.
    const keyRoute = /^\/v1\/(?:deployments\/[^/]+|projects\/\d+)\/(\w+)$/.exec(url.pathname)?.[1];
    const keys = url.pathname.startsWith("/v1/deployments/")
      ? this.keysOf(this.keys, deployment)
      : this.keysOf(this.previewKeys, id);
    switch (`${method} ${keyRoute}`) {
      case "POST create_deploy_key":
      case "POST create_preview_deploy_key": {
        const name = String(body?.["name"]);
        const key = {
          id: this.nextId++,
          // Convex lists a key under the requested name, and adds a suffix when the name is taken.
          name: keys.some((other) => other.name === name) ? `${name} (${randomUUID()})` : name,
          secret: `${recordedSecret}-${this.nextId}`,
        };
        keys.push(key);
        return json(
          200,
          keyRoute === "create_deploy_key"
            ? { ...recorded("deployment_create_deploy_key.json"), deployKey: key.secret }
            : { previewDeployKey: key.secret },
        );
      }
      case "GET list_deploy_keys":
        return json(200, this.keyRows(keys));
      case "GET list_preview_deploy_keys":
        return json(200, {
          ...recorded("project_list_preview_deploy_keys.json"),
          items: this.keyRows(keys),
        });
      case "POST delete_deploy_key":
      case "POST delete_preview_deploy_key": {
        const index = keys.findIndex(
          (key) => key.secret === body?.["id"] || key.name === body?.["id"],
        );
        if (index === -1) {
          return notFound(
            keyRoute === "delete_deploy_key" ? "DeployKeyNotFound" : "PreviewDeployKeyNotFound",
          );
        }
        keys.splice(index, 1);
        return empty();
      }
      case "GET list_default_environment_variables":
        return json(200, {
          ...recorded("project_list_default_environment_variables.json"),
          items: this.defaults
            .filter(
              (row) =>
                row.projectId === id &&
                row.name === url.searchParams.get("name") &&
                row.deploymentType === url.searchParams.get("deploymentType"),
            )
            .map((row) => ({
              name: row.name,
              value: "REDACTED",
              deploymentTypes: [row.deploymentType],
            })),
        });
      case "POST update_default_environment_variables": {
        for (const change of Schema.decodeUnknownSync(Changes)(body).changes) {
          const index = this.defaults.findIndex(
            (row) =>
              row.projectId === id &&
              row.name === change.name &&
              row.deploymentType === change.deploymentType,
          );
          if (index !== -1) this.defaults.splice(index, 1);
          if (change.value !== null && change.value !== undefined) {
            this.defaults.push({
              projectId: id,
              name: change.name,
              deploymentType: change.deploymentType ?? "",
            });
          }
        }
        return empty();
      }
      default:
        throw new Error(`FakeConvex has no route for ${method} ${url.pathname}`);
    }
  }

  private deploymentApi(
    deployment: string,
    method: string,
    url: URL,
    body: Record<string, unknown> | undefined,
  ): Response {
    const variables = this.variables.get(deployment) ?? {};
    this.variables.set(deployment, variables);
    switch (`${method} ${url.pathname}`) {
      case "GET /api/v1/list_environment_variables":
        return json(200, {
          ...recorded("deployment_list_environment_variables.json"),
          environmentVariables: variables,
        });
      case "POST /api/v1/update_environment_variables":
        for (const change of Schema.decodeUnknownSync(Changes)(body).changes) {
          if (change.value === null || change.value === undefined) delete variables[change.name];
          else variables[change.name] = change.value;
        }
        return empty();
      default:
        throw new Error(`FakeConvex has no route for ${method} ${url.host}${url.pathname}`);
    }
  }

  private listProjects(teamId: number, query: URLSearchParams): Response {
    const search = query.get("q")?.toLowerCase();
    const matches = this.projects
      .map((row) => Schema.decodeUnknownSync(ProjectFields)(row))
      .filter((row) => row.teamId === teamId)
      .filter((row) => search === undefined || row.name.toLowerCase().includes(search))
      .sort((a, b) => b.id - a.id);
    if (this.hideProjectsFromListings > 0) {
      this.hideProjectsFromListings -= 1;
      matches.length = 0;
    }
    const start = Number(query.get("cursor") ?? "0");
    const page = matches.slice(start, start + this.pageSize);
    const end = start + page.length;
    return json(200, {
      ...recorded("teams_projects.json"),
      items: page.map((row) => this.projects.find((candidate) => candidate["id"] === row.id)),
      pagination:
        end < matches.length ? { hasMore: true, nextCursor: String(end) } : { hasMore: false },
    });
  }

  private keysOf<K>(store: Map<K, Key[]>, owner: K) {
    const keys = store.get(owner) ?? [];
    store.set(owner, keys);
    return keys;
  }

  private keyRows(keys: readonly Key[]) {
    return keys.map((key) => ({ ...recordedKeyRow, id: key.id, name: key.name }));
  }
}
