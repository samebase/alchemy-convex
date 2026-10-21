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
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Credentials, type ResolvedCredentials } from "./Credentials.ts";

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
  /**
   * Team id for a numeric id, a slug, or nothing. A team access token names
   * its team (`GET /token_details`); a slug is then checked against the
   * `teamSlug` of the team's projects, so a token of another team fails. The
   * Convex CLI login and a personal token answer 403 there, so a slug goes to
   * the dashboard's team list, and nothing is an error.
   */
  readonly resolveTeamId: (
    team: string | number | undefined,
  ) => Effect.Effect<number, ConvexApiError>;
  /**
   * True when a deploy key that Convex returned carries the token of the
   * Management API credential itself. With an OAuth token, create_deploy_key
   * and create_preview_deploy_key create no new key: they return the OAuth
   * token with a new prefix, and the part after "|" is the same. A delete of
   * that key would revoke the credential.
   */
  readonly isCredentialToken: (secret: string) => Effect.Effect<boolean>;
  /**
   * The same calls with another bearer token, such as a preview deploy key,
   * which the Management API takes for the preview deployments of its project.
   */
  readonly withToken: (token: Redacted.Redacted<string>) => ManagementApiService;
}

/** The part of a Convex token after the first "|", or the whole value when it has none. */
const tokenPart = (value: string) => value.slice(value.indexOf("|") + 1);

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

/**
 * True when an idempotent write can succeed on a new attempt:
 *
 * - A Convex write conflict. Two parallel update_environment_variables calls
 *   on one deployment gave HTTP 503 `OptimisticConcurrencyControlFailure`,
 *   "Data read or written in this mutation changed while it was being run",
 *   in a live run. The platform codes `OCC` and `WriteConflict` and the
 *   message "... changed while this mutation was being run ..." mean the same.
 * - Any other 5xx answer. Two parallel delete_preview_deploy_key calls on one
 *   project gave HTTP 500 `InternalServerError`, "Your request couldn't be
 *   completed. Try again later.", in a live run. The next attempt succeeded.
 */
export const isRetryableWriteError = (error: ConvexApiError): boolean =>
  error.code === "OptimisticConcurrencyControlFailure" ||
  error.code === "OCC" ||
  error.code === "WriteConflict" ||
  /changed while (it|this mutation) was being run/.test(error.message) ||
  error.status >= 500;

/**
 * Runs an idempotent write again after a retryable Convex error: at most
 * four more attempts, with exponential backoff from 100 ms and jitter. Other
 * errors fail at once, and so does the last retryable error. Use it only for
 * a write that has the same result when it runs twice, such as setting a
 * value or deleting by id. Never for a create that does not check first.
 */
export const retryIdempotentWrite = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: (error: E) => error instanceof ConvexApiError && isRetryableWriteError(error),
      times: 4,
      schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
    }),
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

/** The first page of GET /teams/{team_id}/projects: every row carries the slug of the team. */
const ProjectSlugRows = Schema.Struct({
  items: Schema.Array(Schema.Struct({ teamSlug: Schema.String })),
});

/** GET /token_details: the team of a team token, or the project of a project token. */
const TokenDetails = Schema.Union([
  Schema.Struct({ type: Schema.Literal("teamToken"), teamId: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("projectToken"), projectId: Schema.Number }),
]);

/** The service for one way to get the bearer token. */
const makeService = (credentials: Effect.Effect<ResolvedCredentials>): ManagementApiService => {
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

  // Measured: a team access token answers `GET /token_details` with its
  // team id and gets HTTP 403 from the dashboard's team list; the Convex CLI
  // login answers the team list and gets HTTP 403 `NotOAuthTeamToken` from
  // token_details. Read once for each service.
  // `Effect.cached` only allocates the cache, so runSync makes one for this service.
  const tokenDetails = Effect.runSync(
    Effect.cached(
      request("get token details", (c) => c.GET("/token_details")).pipe(
        Effect.map((body) => Schema.decodeUnknownSync(TokenDetails)(body)),
        Effect.catchIf(
          (error) => error.status === 403,
          () => Effect.succeed(undefined),
        ),
      ),
    ),
  );

  /** The slug of the team, from the first project of its listing, or undefined for a team without one. Read once. */
  const teamSlug = (teamId: number) =>
    request("list projects", (c) =>
      c.GET("/teams/{team_id}/projects", { params: { path: { team_id: teamId } } }),
    ).pipe(
      Effect.map((body) => Schema.decodeUnknownSync(ProjectSlugRows)(body).items[0]?.teamSlug),
    );

  // The Management API addresses teams by numeric id. The only slug lookup
  // it offers is per project, so a slug falls back to the dashboard's team
  // list, which is unofficial. Pass the numeric team id to skip this.
  const resolveTeamId: ManagementApiService["resolveTeamId"] = (team) =>
    Effect.gen(function* () {
      if (typeof team === "number") return team;
      if (team !== undefined && /^\d+$/.test(team)) return Number(team);
      const details = yield* tokenDetails;
      if (details?.type === "teamToken") {
        if (team === undefined) return details.teamId;
        // The Management API has no team-by-id call, so the slug of the
        // team comes from any of its projects. A team without a project
        // cannot be checked: the numeric id, or no team, is the fix.
        const slug = yield* teamSlug(details.teamId);
        if (slug === undefined) {
          return yield* new ConvexApiError({
            operation: "resolve team",
            status: 0,
            message: `team "${team}" cannot be checked against the access token: team ${details.teamId} has no project yet. Set team to ${details.teamId}, or leave it out.`,
          });
        }
        if (slug !== team) {
          return yield* new ConvexApiError({
            operation: "resolve team",
            status: 403,
            message: `the access token belongs to team ${details.teamId} ("${slug}"), and team is "${team}". Use a token of "${team}", or set team to ${details.teamId}.`,
          });
        }
        return details.teamId;
      }
      if (details?.type === "projectToken") {
        return yield* new ConvexApiError({
          operation: "resolve team",
          status: 403,
          message: `the access token belongs to project ${details.projectId}, and a project token cannot create projects. Use a team access token.`,
        });
      }
      if (team === undefined) {
        return yield* new ConvexApiError({
          operation: "resolve team",
          status: 0,
          message:
            "set team to the slug or the id of the Convex team: this access token does not name a team.",
        });
      }
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

  const isCredentialToken: ManagementApiService["isCredentialToken"] = (secret) =>
    credentials.pipe(
      Effect.map(
        (resolved) => tokenPart(Redacted.value(resolved.accessToken)) === tokenPart(secret),
      ),
    );

  const withToken: ManagementApiService["withToken"] = (token) =>
    makeService(Effect.succeed({ accessToken: token, source: "explicit" }));

  return {
    request,
    requestVoid,
    deploymentRequest,
    resolveTeamId,
    isCredentialToken,
    withToken,
  };
};

export const ManagementApiLive = (): Layer.Layer<ManagementApi, never, Credentials> =>
  Layer.effect(
    ManagementApi,
    Effect.gen(function* () {
      const credentials = yield* Credentials;
      return makeService(credentials.accessToken);
    }),
  );
