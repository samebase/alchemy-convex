// A fake Convex control plane behind a stubbed `fetch`, for tests that run
// the providers through the real Alchemy engine. It answers the Management
// API (https://api.convex.dev/v1) and the deployment API
// (https://<deployment>.convex.cloud/api/v1). Every response body is a
// recorded payload from fixtures/management with only the fields that a
// scenario needs changed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { vi } from "vitest";
import { STORE_VERSION } from "../src/store/convex/version.ts";

export const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/management/${file}`, import.meta.url), "utf8"));
/** A recorded function API payload from fixtures/state. */
export const stateFixture = (file: string) =>
  Schema.decodeUnknownSync(Fields)(
    JSON.parse(readFileSync(new URL(`./fixtures/state/${file}`, import.meta.url), "utf8")),
  );

const Fields = Schema.Record(Schema.String, Schema.Unknown);
/** A recorded object payload as a plain record, so a scenario can derive a changed copy. */
export const recorded = (file: string) => Schema.decodeUnknownSync(Fields)(fixture(file));
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
  /** The Authorization header. Tests use fake values only. */
  readonly authorization: string;
}

interface Key {
  readonly id: number;
  readonly name: string;
  readonly secret: string;
  /** The `allowedActions` of the create, or undefined for every action. */
  readonly actions: readonly string[] | undefined;
}

/** One row of the `resources` table of the store. */
export interface StoreRow {
  readonly stack: string;
  readonly stage: string;
  readonly fqn: string;
  readonly value: string;
}

/** The store of src/store/convex on one deployment: its version, rows, and outputs. */
export interface Store {
  version: number;
  rows: StoreRow[];
  readonly outputs: Map<string, string>;
}

/** The admin functions of an identity hub, as the broker answers them. */
export class Hub {
  readonly clients = new Map<string, Record<string, unknown>>();
  private nextClient = 1;
  constructor(readonly issuer: string) {}
  run(path: string, args: Record<string, unknown>) {
    if (path === "identityBroker:deleteClient") {
      this.clients.delete(String(args["clientId"]));
      return null;
    }
    const clientId = `cl_${this.nextClient++}`;
    this.clients.set(clientId, args);
    return { issuer: this.issuer, clientId, clientSecret: `secret-of-${clientId}` };
  }
}

/** The internal functions of the store that a query key runs, and those that need a mutation key. */
const STORE_QUERIES = [
  "version",
  "stacks",
  "stages",
  "list",
  "get",
  "replaced",
  "getOutput",
  "readStack",
];
const STORE_MUTATIONS = ["set", "remove", "removeStack", "setOutput"];
/** The store version that added a function; every other function is in version 1 (0.6.0). */
const STORE_FUNCTION_SINCE: Record<string, number> = { readStack: 2 };
const HubCall = Schema.Struct({ args: Schema.Record(Schema.String, Schema.Unknown) });
const FunctionCall = Schema.Struct({
  path: Schema.String,
  args: Schema.Struct({
    stack: Schema.optionalKey(Schema.String),
    stage: Schema.optionalKey(Schema.String),
    fqn: Schema.optionalKey(Schema.String),
    value: Schema.optionalKey(Schema.String),
    run: Schema.optionalKey(Schema.Unknown),
  }),
});
/** One line of the fake CLI log: the hash of the key that the push got. */
const CliRun = Schema.Struct({ keySha256: Schema.String });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const RequestBody = Schema.UndefinedOr(Fields);
const Changes = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
const DeploymentFields = Schema.Struct({
  name: Schema.String,
  projectId: Schema.Number,
  deploymentType: Schema.String,
  isDefault: Schema.Boolean,
  reference: Schema.String,
  previewIdentifier: Schema.NullOr(Schema.String),
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
  /** Environment variables for each deployment name. */
  readonly variables = new Map<string, Record<string, string>>();
  /**
   * Deployment rows: recorded list_deployments rows with changed fields.
   * addProject adds the project's default production deployment.
   */
  readonly deployments: Record<string, unknown>[] = [];
  /**
   * Answers sent before the normal handler, for "METHOD host/path" keys,
   * such as a recorded write conflict. Each answer is used once.
   */
  readonly scripted = new Map<
    string,
    {
      status: number;
      body: unknown;
      meanwhile?: () => void;
    }[]
  >();
  /** The deploy key that the deployment API accepts, for each deployment that has one here. */
  readonly deploymentKeys = new Map<string, string>();
  /** The store of each deployment that has one: POST /api/function answers its functions. */
  readonly stores = new Map<string, Store>();
  /** The identity hub of each deployment that has one: POST /api/function answers its admin functions. */
  readonly hubs = new Map<string, Hub>();
  /** The store functions that ran, as "<deployment> <path>" lines. */
  readonly functionCalls: string[] = [];
  /** Every deploy key secret ever created for each deployment, also the deleted ones. */
  private readonly createdSecrets = new Map<string, string[]>();
  /** Page size of GET /teams/{team_id}/projects. */
  pageSize = 100;
  /** The bearer value that the fake takes for a team access token of `teamTokenTeamId`. Every other bearer is the Convex CLI login. */
  teamToken = "team-token";
  teamTokenTeamId = 38516;
  /** Rows that GET /teams/{team_id}/projects leaves out while this is above zero, one call at a time. */
  hideProjectsFromListings = 0;
  /**
   * Answers key creates as Convex does for an OAuth credential: no new key,
   * and the returned secret carries the bearer token after "|".
   */
  oauth = false;
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
    this.deployments.push(
      this.deploymentRow({
        name: prodDeploymentName,
        projectId: id,
        deploymentType: "prod",
        isDefault: true,
        reference: "production",
        previewIdentifier: null,
      }),
    );
    return id;
  }

  /** Gives a deployment the store at `version`, with no rows, and returns it. */
  addStore(deployment: string, version: number) {
    const store: Store = { version, rows: [], outputs: new Map() };
    this.stores.set(deployment, store);
    return store;
  }

  /** The current row of a deployment, decoded. */
  deployment(name: string) {
    const row = this.deployments.find((candidate) => candidate["name"] === name);
    return row === undefined ? undefined : Schema.decodeUnknownSync(DeploymentFields)(row);
  }

  /** The deployment rows of a project, decoded. */
  deploymentsOf(projectId: number) {
    return this.deployments
      .map((row) => Schema.decodeUnknownSync(DeploymentFields)(row))
      .filter((row) => row.projectId === projectId);
  }

  /**
   * Adds a dev or preview deployment as Convex lists it, such as one that
   * `npx convex deploy --preview-name` created, and returns its name.
   */
  addDeployment(fields: {
    readonly projectId: number;
    readonly type: "dev" | "preview";
    readonly name: string;
  }) {
    const name = `fake-${fields.type}-${this.nextId++}`;
    this.deployments.push(
      this.deploymentRow({
        name,
        projectId: fields.projectId,
        deploymentType: fields.type,
        isDefault: false,
        // Convex derives a preview reference from the preview name.
        reference:
          fields.type === "preview"
            ? `preview/${fields.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
            : fields.name,
        previewIdentifier: fields.type === "preview" ? fields.name : null,
      }),
    );
    return name;
  }

  /**
   * A row for a deployment that has received no push yet: list_deployments
   * leaves `lastDeployTime` out until the first push. `markDeployed` sets it.
   */
  private deploymentRow(fields: typeof DeploymentFields.Type) {
    const { lastDeployTime: _unset, ...row } = recordedDeploymentRow;
    return { ...row, ...fields, deploymentUrl: `https://${fields.name}.convex.cloud` };
  }

  /** Gives a deployment the recorded `lastDeployTime`, as Convex does after a push. */
  markDeployed(name: string) {
    const row = this.deployments.find((candidate) => candidate["name"] === name);
    if (row !== undefined) row["lastDeployTime"] = recordedDeploymentRow["lastDeployTime"];
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
    const authorization = request.headers.get("Authorization") ?? "";
    this.sent.push({ method: request.method, path, query: url.searchParams, body, authorization });
    const next = this.scripted.get(`${request.method} ${path}`)?.shift();
    if (next !== undefined) {
      // A change that another writer makes while this request runs.
      next.meanwhile?.();
      return json(next.status, next.body);
    }
    return this.route(request.method, url, body, authorization);
  };

  private route(
    method: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    authorization: string,
  ): Response {
    const deploymentHost = /^([a-z0-9-]+)\.convex\.cloud$/.exec(url.host);
    if (deploymentHost !== null) {
      const deployment = deploymentHost[1] ?? "";
      if (authorization.startsWith("Convex preview:")) {
        return json(403, { code: "Unauthorized", message: "Not authorized" });
      }
      if (url.pathname === "/api/function") {
        return this.functionApi(deployment, authorization.replace(/^Convex /, ""), body);
      }
      const key = this.deploymentKeys.get(deployment);
      if (key !== undefined && authorization !== `Convex ${key}`) {
        return json(401, {
          ...recorded("project_not_found.json"),
          code: "Unauthorized",
          message: `The deploy key is not for ${deployment} (fake)`,
        });
      }
      return this.deploymentApi(deployment, method, url, body);
    }
    const bearer = authorization.replace(/^Bearer /, "");
    // Measured: a team access token names its team in /token_details and
    // cannot list teams; the Convex CLI login lists teams and gets 403 there.
    if (method === "GET" && url.pathname === "/v1/token_details") {
      return bearer === this.teamToken
        ? json(200, { ...recorded("token_details_team_token.json"), teamId: this.teamTokenTeamId })
        : json(403, recorded("token_details_cli_login.json"));
    }
    if (method === "GET" && url.pathname === "/api/dashboard/teams") {
      return bearer === this.teamToken
        ? json(403, recorded("dashboard_teams_team_token.json"))
        : json(200, fixture("dashboard_teams_cli_login.json"));
    }
    const route = `${method} ${url.pathname.replace(/\/\d+(?=\/|$)/g, "/{id}")}`;
    const id = Number(/\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1]);
    const deployment = /^\/v1\/deployments\/([^/]+)\//.exec(url.pathname)?.[1] ?? "";
    const bySlug = /^\/v1\/teams\/([^/]+)\/projects\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && bySlug !== null) {
      const [, team, slug] = bySlug;
      const row = this.projects.find(
        (candidate) =>
          candidate["slug"] === slug &&
          (String(candidate["teamId"]) === team || candidate["teamSlug"] === team),
      );
      return row === undefined
        ? json(404, recorded("team_get_project_by_slug_not_found.json"))
        : json(200, { ...recorded("team_get_project_by_slug.json"), ...row });
    }
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
        for (const row of this.deploymentsOf(id)) this.removeDeployment(row.name);
        return empty();
      }
      case "GET /v1/projects/{id}/list_deployments": {
        if (this.project(id) === undefined) return notFound("ProjectNotFound");
        const type = url.searchParams.get("deploymentType");
        const isDefault = url.searchParams.get("isDefault");
        const names = this.deploymentsOf(id)
          .filter((row) => type === null || row.deploymentType === type)
          .filter((row) => isDefault === null || String(row.isDefault) === isDefault)
          .map((row) => row.name);
        return json(
          200,
          this.deployments.filter((row) => names.includes(String(row["name"]))),
        );
      }
      case "POST /v1/projects/{id}/create_deployment":
        return this.createDeployment(id, body);
      default:
        break;
    }
    const deploymentPath = /^\/v1\/deployments\/([^/]+)$/.exec(url.pathname)?.[1];
    if (method === "GET" && deploymentPath !== undefined) {
      const row = this.deployments.find((candidate) => candidate["name"] === deploymentPath);
      // GET /deployments/{name} answers no preview identifier, also for a preview.
      return row === undefined
        ? this.deploymentNotFound(deploymentPath)
        : json(200, {
            ...recorded("deployment_get_preview.json"),
            ...row,
            previewIdentifier: null,
          });
    }
    // Deploy keys and deletes: /v1/deployments/{name}/<route>.
    const keyRoute = /^\/v1\/deployments\/[^/]+\/(\w+)$/.exec(url.pathname)?.[1];
    const keys = this.keysOf(this.keys, deployment);
    switch (`${method} ${keyRoute}`) {
      case "POST create_deploy_key": {
        if (bearer.startsWith("preview:")) {
          return json(403, recorded("deployment_create_deploy_key_preview_key_refused.json"));
        }
        if (this.oauth) {
          const prefix = recordedSecret.slice(0, recordedSecret.indexOf("|"));
          const secret = `${prefix.replace("beaming-okapi-932", deployment)}|${bearer}`;
          return json(200, { ...recorded("deployment_create_deploy_key.json"), deployKey: secret });
        }
        const actions = body?.["allowedActions"];
        const key = {
          id: this.nextId++,
          name: String(body?.["name"]),
          // The recorded secret with this key's deployment in the prefix, as
          // Convex makes them: `dev:<deployment>|...`.
          secret: `${recordedSecret.replace("beaming-okapi-932", deployment)}-${this.nextId}`,
          actions:
            actions === undefined
              ? undefined
              : Schema.decodeUnknownSync(Schema.Array(Schema.String))(actions),
        };
        keys.push(key);
        this.keysOf(this.createdSecrets, deployment).push(key.secret);
        return json(200, {
          ...recorded("deployment_create_deploy_key.json"),
          deployKey: key.secret,
        });
      }
      case "POST delete": {
        if (this.deployment(deployment) === undefined) return this.deploymentNotFound(deployment);
        this.removeDeployment(deployment);
        return empty();
      }
      case "POST delete_deploy_key": {
        const index = keys.findIndex((key) => key.secret === body?.["id"]);
        if (index === -1) return notFound("DeployKeyNotFound");
        keys.splice(index, 1);
        return empty();
      }
      default:
        throw new Error(`FakeConvex has no route for ${method} ${url.pathname}`);
    }
  }

  /**
   * POST /api/function as the store deployment answers it: a key of the
   * deployment with the action of the function, else the recorded refusals;
   * a function that the deployment does not have, else its value.
   */
  private functionApi(
    deployment: string,
    secret: string,
    body: Record<string, unknown> | undefined,
  ): Response {
    const key = this.keysOf(this.keys, deployment).find((candidate) => candidate.secret === secret);
    if (key === undefined) return json(403, stateFixture("function_no_key.json"));
    const { path, args } = Schema.decodeUnknownSync(FunctionCall)(body);
    const hub = this.hubs.get(deployment);
    if (path.startsWith("identityBroker:") && hub !== undefined) {
      if (
        key.actions !== undefined &&
        !key.actions.includes("deployment:functions:runInternalMutations")
      ) {
        return json(200, {
          ...stateFixture("function_version_missing.json"),
          errorMessage: "no permission",
        });
      }
      this.functionCalls.push(`${deployment} ${path}`);
      const { args: hubArgs } = Schema.decodeUnknownSync(HubCall)(body);
      return json(200, { ...stateFixture("function_version.json"), value: hub.run(path, hubArgs) });
    }
    const name = path.replace(/^state:/, "");
    // A push of the fake CLI with a key of this deployment installs the
    // store, or raises an older one to the current version with its rows.
    if (this.pushedByCli(deployment)) {
      const pushed = this.stores.get(deployment);
      if (pushed === undefined) this.addStore(deployment, STORE_VERSION);
      else if (pushed.version < STORE_VERSION) pushed.version = STORE_VERSION;
    }
    const store = this.stores.get(deployment);
    const reply = (value: unknown) =>
      json(200, { ...stateFixture("function_version.json"), value });
    const error = (message: string) =>
      json(200, { ...stateFixture("function_version_missing.json"), errorMessage: message });
    if (
      store === undefined ||
      !(STORE_QUERIES.includes(name) || STORE_MUTATIONS.includes(name)) ||
      store.version < (STORE_FUNCTION_SINCE[name] ?? 1)
    ) {
      return error(
        `[Request ID: fake] Server Error\nCould not find function for '${path}'. Did you forget to run \`npx convex dev\`?\n`,
      );
    }
    const action = STORE_QUERIES.includes(name)
      ? "deployment:functions:runInternalQueries"
      : "deployment:functions:runInternalMutations";
    if (key.actions !== undefined && !key.actions.includes(action)) {
      return error(
        `[Request ID: fake] Server Error\nYou do not have permission to perform this operation (${action}).\n`,
      );
    }
    this.functionCalls.push(`${deployment} ${path}`);
    const { stack, stage, fqn, value = "" } = args;
    const inStage = (row: StoreRow) => row.stack === stack && row.stage === stage;
    const index = store.rows.findIndex((row) => inStage(row) && row.fqn === fqn);
    const output = `${stack}/${stage}`;
    switch (name) {
      case "version":
        return reply(store.version);
      case "stacks":
        return reply([...new Set(store.rows.map((row) => row.stack))].sort());
      case "stages":
        return reply(
          [
            ...new Set(store.rows.filter((row) => row.stack === stack).map((row) => row.stage)),
          ].sort(),
        );
      case "list":
        return reply(
          store.rows
            .filter(inStage)
            .map((row) => row.fqn)
            .sort(),
        );
      case "get":
        return reply(store.rows[index]?.value ?? null);
      case "replaced":
        return reply(
          store.rows
            .filter(inStage)
            .map((row) => row.value)
            .filter(
              (text) => Schema.decodeUnknownSync(Fields)(JSON.parse(text))["status"] === "replaced",
            ),
        );
      case "set": {
        const row = store.rows[index];
        if (row === undefined)
          store.rows.push({ stack: stack ?? "", stage: stage ?? "", fqn: fqn ?? "", value });
        else store.rows[index] = { ...row, value };
        return reply(null);
      }
      case "remove":
        if (index >= 0) store.rows.splice(index, 1);
        return reply(null);
      case "removeStack": {
        const gone = (row: StoreRow) =>
          row.stack === stack && (stage === undefined || row.stage === stage);
        store.rows = store.rows.filter((row) => !gone(row));
        for (const name of store.outputs.keys()) {
          if (stage === undefined ? name.startsWith(`${stack}/`) : name === output)
            store.outputs.delete(name);
        }
        return reply(null);
      }
      case "getOutput":
        return reply(store.outputs.get(output) ?? null);
      case "setOutput":
        store.outputs.set(output, value);
        return reply(null);
      case "readStack": {
        const stages = [
          ...new Set([
            ...store.rows.filter((row) => row.stack === stack).map((row) => row.stage),
            ...[...store.outputs.keys()]
              .filter((name) => name.startsWith(`${stack}/`))
              .map((name) => name.slice(`${stack}/`.length)),
          ]),
        ].sort();
        return reply({
          stages: stages.map((name) => ({
            stage: name,
            resources: store.rows
              .filter((row) => row.stack === stack && row.stage === name)
              .map((row) => ({ fqn: row.fqn, value: row.value }))
              .sort((a, b) => (a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0)),
            output: store.outputs.get(`${stack}/${name}`) ?? null,
          })),
        });
      }
      default:
        throw new Error(`FakeConvex has no store function ${path}`);
    }
  }

  /** True when the fake CLI log (fixtures/fake-convex-cli.ts) has a run with a key of `deployment`. */
  private pushedByCli(deployment: string) {
    const log = process.env["ALCHEMY_CONVEX_FAKE_CLI_LOG"];
    if (log === undefined || !existsSync(log)) return false;
    const hashes = new Set(this.keysOf(this.createdSecrets, deployment).map(sha256));
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .some((line) =>
        hashes.has(Schema.decodeUnknownSync(Schema.fromJsonString(CliRun))(line).keySha256),
      );
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
      case "GET /api/v1/deployment_info": {
        const row = this.deployment(deployment);
        return row === undefined
          ? this.deploymentNotFound(deployment)
          : json(200, {
              ...recorded("deployment_info.json"),
              projectId: row.projectId,
              deploymentType: row.deploymentType,
              reference: row.reference,
            });
      }
      case "GET /api/v1/get_canonical_urls":
        return json(200, {
          ...recorded("deployment_get_canonical_urls.json"),
          convexCloudUrl: `https://${deployment}.convex.cloud`,
          convexSiteUrl: `https://${deployment}.convex.site`,
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

  /**
   * POST /projects/{id}/create_deployment as Convex answers it: a preview
   * needs a reference, a preview create replaces the preview deployment with
   * the same preview name, and a dev reference must be new.
   */
  private createDeployment(projectId: number, body: Record<string, unknown> | undefined) {
    const type = body?.["type"];
    const reference = body?.["reference"];
    if (type !== "dev" && type !== "preview")
      throw new Error(`FakeConvex cannot create ${String(type)}`);
    if (typeof reference !== "string") {
      return json(400, recorded("project_create_deployment_missing_reference.json"));
    }
    if (type === "preview") {
      for (const row of this.deploymentsOf(projectId)) {
        if (row.previewIdentifier === reference) this.removeDeployment(row.name);
      }
    } else if (this.deploymentsOf(projectId).some((row) => row.reference === reference)) {
      return json(400, {
        ...recorded("project_create_deployment_reference_exists.json"),
        message: `A deployment with the reference '${reference}' already exists in this project.`,
      });
    }
    const name = this.addDeployment({ projectId, type, name: reference });
    const row = this.deployments.find((candidate) => candidate["name"] === name);
    return json(200, { ...recorded(`project_create_deployment_${type}.json`), ...row });
  }

  private removeDeployment(name: string) {
    const index = this.deployments.findIndex((row) => row["name"] === name);
    if (index !== -1) this.deployments.splice(index, 1);
  }

  private deploymentNotFound(name: string) {
    return json(404, {
      ...recorded("deployment_not_found.json"),
      message: `The requested deployment ${name} does not exist`,
    });
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

  private keysOf<T>(store: Map<string, T[]>, owner: string) {
    const keys = store.get(owner) ?? [];
    store.set(owner, keys);
    return keys;
  }
}
