// Alchemy state in Convex: `state: Convex.state()` in `Alchemy.Stack`.
//
// The state of every stage lives in the alchemyState component
// (`@samebase/alchemy-convex/convex.config`), which the app mounts and pushes
// to the production deployment of its project. The store calls the component
// functions through POST <deployment>/api/function with a component path, the
// call that `convex run --component` makes, with the deploy key in
// CONVEX_STATE_DEPLOY_KEY. Measured: a component query needs the key action
// `deployment:data:view`, a component mutation `deployment:data:write`, and a
// call without a key gets HTTP 403. See docs/design/convex-state.md.
//
// Bootstrap: Alchemy reads state before the first push, when the deployment
// has no alchemyState component yet. The store asks the component list of the
// deployment, and only a deployment without the component means empty state.
// The store then keeps the state of the run in memory and moves it to the
// component on the first write after the component is active: the first
// write after the push. A run that ends with its state still in memory fails
// at the stack output. An unmounted component keeps its rows, so it fails.
//
// The function names of the component are a wire contract. An older
// component must answer a newer store, so a name is never renamed or removed.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  encodeState,
  InMemoryService,
  type PersistedState,
  type ReplacedResourceState,
  reviveState,
  State,
  type StateService,
  STATE_STORE_VERSION,
  StateStoreError,
} from "alchemy/State";
import { keyTargetOf } from "./Push.ts";

/** Environment variable with the deploy key of the deployment that holds the state. */
export const STATE_DEPLOY_KEY_ENV = "CONVEX_STATE_DEPLOY_KEY";

/** The component path of alchemyState in the app: its default name. */
const COMPONENT_PATH = "alchemyState";

/** The body of POST /api/function and /api/query, with HTTP 200 or 560 for a function error. */
const Reply = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("error"), errorMessage: Schema.String }),
]);

/** The value of `_system/frontend/components:list`: the root has path "", a removed mount is "unmounted". */
const Components = Schema.Array(Schema.Struct({ path: Schema.String, state: Schema.String }));

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

/**
 * The deployment URL of a deploy key. The Convex CLI makes the same unofficial
 * call for every deploy key (convex 1.46 `cli/lib/deploymentSelection.js`).
 */
const urlForKey = (key: Redacted.Redacted<string>) =>
  post(
    "https://api.convex.dev/api/deployment/url_for_key",
    {},
    { deployKey: Redacted.value(key) },
  ).pipe(Effect.flatMap(decode(Schema.String, "deployment URL")));

/** The Convex function API of one deployment, with an admin key. */
export interface FunctionApi {
  /** Runs a function of the component, or a system function of the root with `componentPath` undefined. */
  readonly call: (
    path: string,
    args: Record<string, string | undefined>,
    componentPath?: string,
  ) => Effect.Effect<unknown, StateStoreError>;
}

export const makeFunctionApi = (url: string, key: Redacted.Redacted<string>): FunctionApi => ({
  call: (path, args, componentPath) =>
    post(
      // A component function answers only through /api/function. A system query
      // of the root answers only through /api/query (measured).
      `${url}/api/${componentPath === undefined ? "query" : "function"}`,
      { Authorization: `Convex ${Redacted.value(key)}` },
      { ...(componentPath === undefined ? {} : { componentPath }), path, args, format: "json" },
    ).pipe(
      Effect.flatMap(decode(Reply, `reply of ${path}`)),
      Effect.flatMap((reply) =>
        reply.status === "success"
          ? Effect.succeed(reply.value)
          : // The message names the function and the cause, such as a missing key
            // action. The key is a header, and Convex does not echo arguments.
            Effect.fail(failure(reply.errorMessage.trim())),
      ),
    ),
});

/** The state of the alchemyState mount: "active", "unmounted" (its rows are kept), or undefined. */
const mountOf = (api: FunctionApi) =>
  api.call("_system/frontend/components:list", {}).pipe(
    Effect.flatMap(decode(Components, "component list")),
    Effect.map((components) => components.find((c) => c.path === COMPONENT_PATH)?.state),
  );

/** The component functions with Alchemy's encoding: the JSON text of encodeState. */
const remoteOf = (api: FunctionApi) => {
  const run = (name: string, args: Record<string, string | undefined>) =>
    api.call(`state:${name}`, args, COMPONENT_PATH);
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

const unmounted = failure(
  `the ${COMPONENT_PATH} component of the deployment is unmounted. Its rows are kept: mount @samebase/alchemy-convex/convex.config in convex/convex.config.ts again.`,
);

/**
 * The StateService over `api`. Without an alchemyState component at
 * the start, the state of the run stays in memory until a write finds the
 * component active.
 */
export const makeConvexState = (api: FunctionApi) =>
  Effect.gen(function* () {
    const remote = remoteOf(api);
    const mount = yield* mountOf(api);
    if (mount === "unmounted") return yield* unmounted;
    let pending = mount === undefined;

    // The records that InMemoryService writes to, read again by the flush.
    const rows: Record<string, Record<string, Record<string, PersistedState>>> = {};
    const outputs: Record<string, Record<string, unknown>> = {};
    const memory = yield* InMemoryService(
      // @ts-expect-error InMemoryService types the records as ResourceState, and its set stores every PersistedState.
      rows,
      outputs,
    );

    /** Moves the memory to the component once it is active. Rows that the run did not read stop it. */
    const flush = Effect.gen(function* () {
      const now = yield* mountOf(api);
      if (now === undefined) return;
      if (now !== "active") return yield* unmounted;
      const stages = [...new Set([...Object.keys(rows), ...Object.keys(outputs)])].flatMap(
        (stack) =>
          [
            ...new Set([...Object.keys(rows[stack] ?? {}), ...Object.keys(outputs[stack] ?? {})]),
          ].map((stage) => ({ stack, stage })),
      );
      for (const { stack, stage } of stages) {
        const found = yield* remote.list({ stack, stage });
        if (found.length > 0) {
          return yield* failure(
            `${stack}/${stage} has ${found.length} rows in the deployment that this run did not read, so the run wrote none. Run it again.`,
          );
        }
      }
      for (const { stack, stage } of stages) {
        for (const [fqn, value] of Object.entries(rows[stack]?.[stage] ?? {})) {
          yield* remote.set({ stack, stage, fqn, value });
        }
        const byStage = outputs[stack];
        if (byStage !== undefined && stage in byStage) {
          yield* remote.setOutput({ stack, stage, value: byStage[stage] });
        }
      }
      pending = false;
    });

    const read = <A>(
      inMemory: Effect.Effect<A, StateStoreError>,
      inConvex: Effect.Effect<A, StateStoreError>,
    ) => Effect.suspend(() => (pending ? inMemory : inConvex));
    const write = <A>(
      inMemory: Effect.Effect<A, StateStoreError>,
      inConvex: Effect.Effect<unknown, StateStoreError>,
      result: A,
    ) =>
      Effect.suspend(() =>
        pending ? Effect.tap(inMemory, () => flush) : Effect.as(inConvex, result),
      );

    const service: StateService = {
      id: "convex",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () => read(memory.listStacks(), remote.listStacks()),
      listStages: (stack) => read(memory.listStages(stack), remote.listStages(stack)),
      list: (request) => read(memory.list(request), remote.list(request)),
      get: (request) => read(memory.get(request), remote.get(request)),
      getReplacedResources: (request) =>
        read(memory.getReplacedResources(request), remote.getReplacedResources(request)),
      getOutput: (request) => read(memory.getOutput(request), remote.getOutput(request)),
      set: (request) => write(memory.set(request), remote.set(request), request.value),
      delete: (request) => write(memory.delete(request), remote.delete(request), undefined),
      deleteStack: (request) =>
        write(memory.deleteStack(request), remote.deleteStack(request), undefined),
      // Alchemy writes the stack output last, so state still in memory here is lost.
      setOutput: (request) =>
        write(memory.setOutput(request), remote.setOutput(request), request.value).pipe(
          Effect.tap(() =>
            pending
              ? Effect.fail(
                  failure(
                    `the deployment of ${STATE_DEPLOY_KEY_ENV} has no ${COMPONENT_PATH} component at the end of the run, so this run saved no state. Mount @samebase/alchemy-convex/convex.config in convex/convex.config.ts.`,
                  ),
                )
              : Effect.void,
          ),
        ),
    };
    return service;
  });

/**
 * Alchemy state in the alchemyState component of the deployment that the
 * deploy key in CONVEX_STATE_DEPLOY_KEY names: the production deployment of
 * the project. The key needs the actions `deployment:data:view` and
 * `deployment:data:write`.
 */
export const state = (): Layer.Layer<State> =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      // The stack's ConfigProvider, for the read of the key on first use.
      const context = yield* Effect.context<never>();
      return yield* Effect.cached(
        Effect.gen(function* () {
          const key = yield* Config.Redacted(STATE_DEPLOY_KEY_ENV);
          if (keyTargetOf(Redacted.value(key)).kind !== "deployment") {
            return yield* failure(
              `${STATE_DEPLOY_KEY_ENV} must be the deploy key of one deployment, such as prod:<name>|..., not a preview deploy key.`,
            );
          }
          return yield* makeConvexState(makeFunctionApi(yield* urlForKey(key), key));
        }).pipe(Effect.provideContext(context), Effect.orDie),
      );
    }),
  );
