// Alchemy state in Convex: `state: Convex.state({ team })` in `Alchemy.Stack`.
//
// One project for each Convex team, `alchemy-state`, holds the state of
// every stack and stage of the team in its production deployment: the
// tables `resources (stack, stage, fqn, value)` and `outputs (stack, stage,
// value)`, served by the functions of src/store/convex. The store lives
// outside every resource that a stack manages, so a stack can create and
// destroy its own project. See docs/design/convex-state.md.
//
// Bootstrap, on the first call of the run: the team token (CONVEX_ACCESS_TOKEN,
// or the Convex CLI login) finds the project by name, or creates it; a deploy
// key of its production deployment that can run internal queries and
// mutations, and nothing else, is created for the run and deleted at its
// end; the `state:version` query says whether the deployment has the store
// of this version. Without one, or with an older one, the installed Convex
// CLI pushes src/store/convex to it, with a push key that is deleted after
// the push. The functions are internal, so only POST /api/function with such
// a key reaches them: a public function of a root app answers anyone who
// knows the deployment URL (measured). A key that stops working during a
// long run (it expires after two hours) is replaced once per call.
//
// Two first runs of a team can both create a project named `alchemy-state`.
// The run whose project is not the oldest deletes its own, before it writes
// anything, and uses the oldest: both runs end on one store.
//
// The function names are a wire contract: Samebase reads `stacks`,
// `getOutput`, and `readStack` by name, and an older client calls an older
// set of names. A name is never renamed or removed. STORE_VERSION rises when
// a function is added or changes in a way that an older client cannot use,
// and a client never pushes an older store over a newer one.
//
// The stage output that `setOutput` stores is the stack's output plus the
// run record of src/RunRecord.ts under the key `samebase.run`: the
// repository, stack file, branch, pull request, commit, and run that wrote
// the stage. `getOutput` gives the document back as stored.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  encodeState,
  type PersistedState,
  type ReplacedResourceState,
  reviveState,
  State,
  type StateService,
  STATE_STORE_VERSION,
  StateStoreError,
} from "alchemy/State";
import { fromConfig } from "./Credentials.ts";
import { ProductionDeploymentNotFound } from "./Deployment.ts";
import {
  absentAsUndefined,
  ManagementApi,
  ManagementApiLive,
  type ManagementApiService,
  retryIdempotentWrite,
} from "./ManagementApi.ts";
import {
  createProject,
  findProjectByName,
  listProjectsByName,
  prodDeploymentOf,
} from "./Project.ts";
import {
  createDeployKey,
  deleteDeployKey,
  installedCli,
  push,
  PUSH_KEY_ACTIONS,
  withPushKey,
} from "./Push.ts";
import { type RunRecord, runRecord, withRunRecord } from "./RunRecord.ts";
import { STORE_VERSION } from "./store/convex/version.ts";

/** The name of the state project in each team. */
export const STORE_PROJECT_NAME = "alchemy-state";

/**
 * The actions of the key of one run: the internal queries and mutations of
 * the store, nothing else. Measured: `deployment:data:view` and
 * `deployment:data:write` do not run an internal function.
 */
export const RUN_KEY_ACTIONS = [
  "deployment:functions:runInternalQueries",
  "deployment:functions:runInternalMutations",
] as const;

/** The body of POST /api/function, with HTTP 200 for a function error too. */
const Reply = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("error"), errorMessage: Schema.String }),
]);
type Reply = typeof Reply.Type;

/** The error reply of /api/function for a function that the deployment does not have (recorded). */
const MISSING_FUNCTION = /Could not find function for '/;

/** HTTP 401 or 403 from the function API: the key is gone or expired (recorded: 403 without a key). */
const isUnauthorized = (error: StateStoreError) =>
  error.http?.status === 401 || error.http?.status === 403;

const failure = (message: string) => new StateStoreError({ message: `Convex state: ${message}` });

/** No reply, HTTP 429, or HTTP 5xx: a new attempt can succeed. Every call of the store is idempotent. */
const isTransient = (error: StateStoreError) =>
  error.http !== undefined &&
  (error.http.status === undefined || error.http.status === 429 || error.http.status >= 500);

const post = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Effect.Effect<unknown, StateStoreError> =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    catch: () => new StateStoreError({ message: `Convex state: POST ${url} failed`, http: {} }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok || response.status === 560
        ? Effect.tryPromise({
            try: (): Promise<unknown> => response.json(),
            catch: () => failure(`${url} gave no JSON`),
          })
        : Effect.fail(
            new StateStoreError({
              message: `Convex state: POST ${url} failed with HTTP ${response.status}`,
              http: { status: response.status },
            }),
          ),
    ),
    Effect.retry({
      while: isTransient,
      schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
      times: 5,
    }),
  );

const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S, what: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => failure(`bad ${what}`)));

/** The function API of the store deployment, with a deploy key. */
export interface FunctionApi {
  /** POST /api/function, the call that `convex run` makes: the reply, which can be a function error. */
  readonly call: (
    path: string,
    args: Record<string, string | undefined>,
  ) => Effect.Effect<Reply, StateStoreError>;
}

export const makeFunctionApi = (url: string, key: Redacted.Redacted<string>): FunctionApi => ({
  call: (path, args) =>
    post(
      `${url}/api/function`,
      { Authorization: `Convex ${Redacted.value(key)}` },
      { path, args, format: "json" },
    ).pipe(Effect.flatMap(decode(Reply, `reply of ${path}`))),
});

/** The value of a reply, or the Convex message, which names the function and the cause, such as a missing key action. */
const valueOf = (reply: Reply) =>
  reply.status === "success"
    ? Effect.succeed(reply.value)
    : Effect.fail(failure(reply.errorMessage.trim()));

/** The functions of the store with Alchemy's encoding: the JSON text of encodeState. */
const remoteOf = (api: FunctionApi) => {
  const run = (name: string, args: Record<string, string | undefined>) =>
    api.call(`state:${name}`, args).pipe(Effect.flatMap(valueOf));
  const strings = (name: string, args: Record<string, string>) =>
    run(name, args).pipe(Effect.flatMap(decode(Schema.Array(Schema.String), name)));
  const optional = (name: string, args: Record<string, string>) =>
    run(name, args).pipe(Effect.flatMap(decode(Schema.NullOr(Schema.String), name)));
  const encode = (value: unknown) => JSON.stringify(encodeState(value));
  return {
    listStacks: () => strings("stacks", {}),
    listStages: (stack: string) => strings("stages", { stack }),
    list: (r: { stack: string; stage: string }) =>
      strings("list", { stack: r.stack, stage: r.stage }),
    // Like Alchemy's own stores, the store gives back the state that it got.
    get: (r: { stack: string; stage: string; fqn: string }) =>
      optional("get", { stack: r.stack, stage: r.stage, fqn: r.fqn }).pipe(
        Effect.map((text): PersistedState | undefined =>
          text === null ? undefined : JSON.parse(text, reviveState),
        ),
      ),
    getReplacedResources: (r: { stack: string; stage: string }) =>
      strings("replaced", { stack: r.stack, stage: r.stage }).pipe(
        Effect.map((texts) =>
          texts.map((text): ReplacedResourceState => JSON.parse(text, reviveState)),
        ),
      ),
    getOutput: (r: { stack: string; stage: string }) =>
      optional("getOutput", { stack: r.stack, stage: r.stage }).pipe(
        Effect.map((text): unknown => (text === null ? undefined : JSON.parse(text, reviveState))),
      ),
    set: (r: { stack: string; stage: string; fqn: string; value: PersistedState }) =>
      run("set", { stack: r.stack, stage: r.stage, fqn: r.fqn, value: encode(r.value) }),
    delete: (r: { stack: string; stage: string; fqn: string }) =>
      run("remove", { stack: r.stack, stage: r.stage, fqn: r.fqn }),
    deleteStack: (r: { stack: string; stage?: string }) =>
      run("removeStack", { stack: r.stack, stage: r.stage }),
    setOutput: (r: { stack: string; stage: string; value: unknown }) =>
      run("setOutput", { stack: r.stack, stage: r.stage, value: encode(r.value) }),
  };
};

/** The version that the store answers, or undefined when the deployment has no `state:version`. */
const storeVersion = (api: FunctionApi) =>
  api
    .call("state:version", {})
    .pipe(
      Effect.flatMap((reply) =>
        reply.status === "error" && MISSING_FUNCTION.test(reply.errorMessage)
          ? Effect.succeed(undefined)
          : valueOf(reply).pipe(Effect.flatMap(decode(Schema.Number, "store version"))),
      ),
    );

/**
 * The functions directory of the store app, `src/store/convex` of this
 * package. This file is `src/State.ts` in a checkout and a chunk in `lib/`
 * in the installed package, which ships `src` too, so the directory is
 * `../src/store/convex` from either place.
 */
export const storeDirectory = () =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "store", "convex");

export interface StoreOptions {
  /** Team slug or numeric team id of the `alchemy-state` project, or undefined with a team access token, which names its team. */
  readonly team: string | number | undefined;
  readonly api: ManagementApiService;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** The key of the run is deleted when this scope closes. */
  readonly scope: Scope.Scope;
  /** The functions directory that an outdated store gets: {@link storeDirectory}. */
  readonly store: string;
  /** The record of this run, which `setOutput` adds to the stage output with the time of the write. */
  readonly run: RunRecord;
}

/**
 * Pushes `store` to the production deployment of the state project with the
 * installed Convex CLI: no typecheck, no codegen, the key only in the
 * environment of the CLI.
 */
const pushStore = (
  options: StoreOptions,
  deployment: { readonly name: string; readonly deploymentUrl: string },
) =>
  Effect.gen(function* () {
    const cli = yield* installedCli(join(options.store, ".."));
    yield* Effect.logInfo(
      `Convex state: pushing the store version ${STORE_VERSION} to ${deployment.name}`,
    );
    yield* withPushKey(options.api, deployment.name, PUSH_KEY_ACTIONS, (key) =>
      push(options.spawner, key, {
        deployment: deployment.name,
        url: deployment.deploymentUrl,
        source: {
          path: options.store,
          command: [...cli, "deploy", "--typecheck", "disable", "--codegen", "disable"],
        },
        env: {},
        previousEnvNames: [],
        adopt: false,
        previewName: undefined,
      }),
    );
  });

/**
 * Creates the state project of the team. Two first runs can both create one:
 * the run whose project is not the oldest deletes its own, which holds
 * nothing yet, and uses the oldest, so that every run ends on one store.
 */
const createStoreProject = (api: ManagementApiService, teamId: number, team: string | number) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(
      `Convex state: creating the project ${STORE_PROJECT_NAME} in team ${team}`,
    );
    const created = yield* createProject(api, teamId, {
      name: STORE_PROJECT_NAME,
      deploymentType: "prod",
      deploymentRegion: undefined,
    });
    const all = yield* listProjectsByName(api, teamId, STORE_PROJECT_NAME);
    const oldest = all.reduce((a, b) => (b.id < a.id ? b : a), created);
    if (oldest.id === created.id) return created;
    yield* Effect.logInfo(
      `Convex state: another run created ${STORE_PROJECT_NAME} ${oldest.id} first; project ${created.id} is deleted again.`,
    );
    yield* absentAsUndefined(
      retryIdempotentWrite(
        api.requestVoid("delete project", (client) =>
          client.POST("/projects/{project_id}/delete", {
            params: { path: { project_id: created.id } },
          }),
        ),
      ),
    );
    return oldest;
  });

/**
 * The StateService over the `alchemy-state` project of the team: found or
 * created, its store pushed when it is missing or older, and read and
 * written with the keys of this run.
 */
export const makeConvexState = (options: StoreOptions) =>
  Effect.gen(function* () {
    const { api } = options;
    const teamId = yield* api.resolveTeamId(options.team);
    const team = options.team ?? teamId;
    const found = yield* findProjectByName(api, teamId, STORE_PROJECT_NAME);
    const project = found ?? (yield* createStoreProject(api, teamId, team));
    const deployment = yield* prodDeploymentOf(api, project.id);
    if (deployment === undefined) {
      return yield* new ProductionDeploymentNotFound({ projectId: project.id });
    }

    // The keys of this run, deleted together when the scope closes. A call
    // that the current key no longer authorizes gets one new key and one
    // more attempt.
    const keys: Redacted.Redacted<string>[] = [];
    yield* Scope.addFinalizer(
      options.scope,
      Effect.suspend(() =>
        Effect.forEach(keys, (key) => deleteDeployKey(api, deployment.name, key), {
          discard: true,
        }),
      ),
    );
    const mint = createDeployKey(api, deployment.name, "alchemy-state", RUN_KEY_ACTIONS).pipe(
      Effect.map((key) => {
        keys.push(key);
        return makeFunctionApi(deployment.deploymentUrl, key);
      }),
      Effect.mapError((error) => failure(`no key for ${deployment.name}: ${error.message}`)),
    );
    let current = yield* mint;
    const functions: FunctionApi = {
      call: (path, args) =>
        current.call(path, args).pipe(
          Effect.catchIf(isUnauthorized, () =>
            mint.pipe(
              Effect.flatMap((next) => {
                current = next;
                return next.call(path, args);
              }),
            ),
          ),
        ),
    };

    const version = yield* storeVersion(functions);
    if (version === undefined || version < STORE_VERSION) {
      // Code without `state:version` is another app with the name of the store.
      if (version === undefined && deployment.lastDeployTime) {
        return yield* failure(
          `project ${STORE_PROJECT_NAME} (${project.id}) of team ${team} has code that is not the state store, and Convex.state does not push over it. Rename that project in the Convex dashboard.`,
        );
      }
      // Another run can push a newer store in the meantime: read again right
      // before the push. The push itself has no lock (see the design note).
      const now = yield* storeVersion(functions);
      if (now === undefined || now < STORE_VERSION) {
        yield* pushStore(options, deployment);
        const pushed = yield* storeVersion(functions);
        if (pushed === undefined || pushed < STORE_VERSION) {
          return yield* failure(
            `${deployment.name} answers store version ${pushed ?? "none"} after the push of version ${STORE_VERSION}.`,
          );
        }
      }
    } else if (version > STORE_VERSION) {
      // The names are a wire contract, so a newer store serves this client.
      yield* Effect.logInfo(
        `Convex state: the store of team ${team} is version ${version}, newer than version ${STORE_VERSION} of this package, and it stays.`,
      );
    }

    const remote = remoteOf(functions);
    const service: StateService = {
      id: "convex",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: remote.listStacks,
      listStages: remote.listStages,
      list: remote.list,
      get: remote.get,
      getReplacedResources: remote.getReplacedResources,
      getOutput: remote.getOutput,
      set: (request) => remote.set(request).pipe(Effect.as(request.value)),
      delete: (request) => remote.delete(request).pipe(Effect.asVoid),
      deleteStack: (request) => remote.deleteStack(request).pipe(Effect.asVoid),
      // The document is the stack's output plus the record under `samebase.run`.
      setOutput: (request) =>
        Effect.gen(function* () {
          const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          const document = withRunRecord(request.value, { ...options.run, recordedAt });
          if (document === undefined) {
            yield* Effect.logWarning(
              `Convex state: the output of ${request.stack}/${request.stage} is not an object, so it carries no run record.`,
            );
          }
          const value = document ?? request.value;
          yield* remote.setOutput({ stack: request.stack, stage: request.stage, value });
          return value;
        }),
    };
    return service;
  });

/**
 * Alchemy state in the `alchemy-state` project of `team`, with the team token
 * in CONVEX_ACCESS_TOKEN or the Convex CLI login. A team access token names
 * its team, so `team` is optional with one; the Convex CLI login needs the
 * slug or the id. The first use of the run finds or creates the project and
 * pushes the store when it is missing or older. `alchemy plan` on another
 * stack never touches Convex.
 */
export const state = (
  options: { readonly team?: string | number } = {},
): Layer.Layer<State, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Scope.Scope;
      // The stack's ConfigProvider, for the read of the token on first use.
      const context = yield* Effect.context<never>();
      return yield* Effect.cached(
        Effect.gen(function* () {
          const api = yield* ManagementApi.pipe(
            Effect.provide(ManagementApiLive().pipe(Layer.provide(fromConfig()))),
          );
          // The record comes before the first read, so a checkout that gives
          // none stops the run before it changes anything.
          const run = yield* runRecord({ cwd: process.cwd(), env: process.env });
          return yield* makeConvexState({
            team: options.team,
            api,
            spawner,
            scope,
            store: storeDirectory(),
            run,
          });
        }).pipe(Effect.provideContext(context), Effect.orDie),
      );
    }),
  );
