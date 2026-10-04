// Effect wrapper around the official Convex platform client.
//
// `@convex-dev/platform` is an openapi-fetch client: every call resolves to
// `{ data, error, response }`. This service turns that into an Effect with one
// typed error, resolves credentials lazily, and validates the fields the
// provider relies on at runtime.
import { createDeploymentClient, createManagementClient } from "@convex-dev/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Credentials } from "./Credentials.ts";

export type ManagementClient = ReturnType<typeof createManagementClient>;
export type DeploymentClient = ReturnType<typeof createDeploymentClient>;

/** Shape of every openapi-fetch result we consume. */
export interface FetchResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

/**
 * One error for every control-plane and deployment call. Resources branch on
 * `status` (404 means absent for read and delete), so the class is load
 * bearing, not decorative.
 */
export class ConvexApiError extends Schema.TaggedError<ConvexApiError>()("ConvexApiError", {
  operation: Schema.String,
  status: Schema.Number,
  code: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

const ErrorBody = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

const toApiError = (operation: string, result: FetchResult<unknown>) => {
  const body = Schema.decodeUnknownSync(Schema.NullishOr(ErrorBody))(result.error ?? null);
  const code = body?.code;
  return new ConvexApiError({
    operation,
    status: result.response.status,
    ...(code === undefined ? {} : { code }),
    message: body?.message ?? `${operation} failed with HTTP ${result.response.status}`,
  });
};

export interface ManagementApiService {
  /** Run one management call with the resolved credentials. */
  readonly request: <T>(
    operation: string,
    run: (client: ManagementClient) => Promise<FetchResult<T>>,
  ) => Effect.Effect<T, ConvexApiError>;
  /** Run one management call whose success response has no body. */
  readonly requestVoid: (
    operation: string,
    run: (client: ManagementClient) => Promise<FetchResult<unknown>>,
  ) => Effect.Effect<void, ConvexApiError>;
  /** Run one deployment-scoped call authenticated with a deploy key. */
  readonly deploymentRequest: <T>(
    operation: string,
    deploymentUrlOrName: string,
    deployKey: Redacted.Redacted<string>,
    run: (client: DeploymentClient) => Promise<FetchResult<T>>,
  ) => Effect.Effect<T, ConvexApiError>;
  /** Team id for a slug or numeric id. */
  readonly resolveTeamId: (team: string | number) => Effect.Effect<number, ConvexApiError>;
}

export class ManagementApi extends Context.Service<ManagementApi, ManagementApiService>()(
  "@samebase/alchemy-convex/ManagementApi",
) {}

const attempt = <T>(operation: string, run: () => Promise<FetchResult<T>>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ConvexApiError({
        operation,
        status: 0,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/** Reads `data` or fails with the HTTP status and the API's own code and message. */
export const settle = <T>(
  operation: string,
  run: () => Promise<FetchResult<T>>,
): Effect.Effect<T, ConvexApiError> =>
  attempt(operation, run).pipe(
    Effect.flatMap((result) =>
      result.response.ok && result.data !== undefined
        ? Effect.succeed(result.data)
        : Effect.fail(toApiError(operation, result)),
    ),
  );

/** For endpoints that answer with an empty body, such as delete calls. */
export const settleVoid = (
  operation: string,
  run: () => Promise<FetchResult<unknown>>,
): Effect.Effect<void, ConvexApiError> =>
  attempt(operation, run).pipe(
    Effect.flatMap((result) =>
      result.response.ok ? Effect.void : Effect.fail(toApiError(operation, result)),
    ),
  );

/** Turns a 404 into `undefined` so read and delete stay idempotent. */
export const absentAsUndefined = <A, R>(
  effect: Effect.Effect<A, ConvexApiError, R>,
): Effect.Effect<A | undefined, ConvexApiError, R> =>
  effect.pipe(
    Effect.catchIf(
      (error) => error.status === 404,
      () => Effect.succeed(undefined),
    ),
  );

const TeamRow = Schema.Struct({ id: Schema.Number, slug: Schema.String });
const TeamRows = Schema.Array(TeamRow);

export const ManagementApiLive = (): Layer.Layer<ManagementApi, never, Credentials> =>
  Layer.effect(
    ManagementApi,
    Effect.gen(function* () {
      const credentials = yield* Credentials;
      const client = Effect.cached(
        credentials.pipe(
          Effect.map((resolved) => createManagementClient(Redacted.value(resolved.accessToken))),
        ),
      ).pipe(Effect.flatten);

      const request: ManagementApiService["request"] = (operation, run) =>
        client.pipe(Effect.flatMap((c) => settle(operation, () => run(c))));

      const requestVoid: ManagementApiService["requestVoid"] = (operation, run) =>
        client.pipe(Effect.flatMap((c) => settleVoid(operation, () => run(c))));

      const deploymentRequest: ManagementApiService["deploymentRequest"] = (
        operation,
        deploymentUrlOrName,
        deployKey,
        run,
      ) =>
        settle(operation, () =>
          run(createDeploymentClient(deploymentUrlOrName, Redacted.value(deployKey))),
        );

      // The Management API addresses teams by numeric id. The only slug lookup
      // it offers is per project, so a slug falls back to the dashboard's team
      // list, which is unofficial. Pass the numeric team id to skip this.
      const resolveTeamId: ManagementApiService["resolveTeamId"] = (team) =>
        Effect.gen(function* () {
          if (typeof team === "number") return team;
          if (/^\d+$/.test(team)) return Number(team);
          const resolved = yield* credentials;
          const rows = yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch("https://api.convex.dev/api/dashboard/teams", {
                headers: { Authorization: `Bearer ${Redacted.value(resolved.accessToken)}` },
              });
              if (!response.ok) {
                throw new Error(`team lookup for "${team}" failed with HTTP ${response.status}`);
              }
              return Schema.decodeUnknownSync(TeamRows)(await response.json());
            },
            catch: (cause) =>
              new ConvexApiError({
                operation: "resolve team",
                status: 0,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
          const match = rows.find((row) => row.slug === team);
          if (match === undefined) {
            return yield* new ConvexApiError({
              operation: "resolve team",
              status: 404,
              message: `no team with slug "${team}" for this token`,
            });
          }
          return match.id;
        });

      return { request, requestVoid, deploymentRequest, resolveTeamId };
    }),
  );
