// Convex credentials for the provider, by scope.
//
// - The access token works on the Management API: a team access token, an
//   OAuth token, or the Convex CLI login. Convex.Project needs it. A
//   Convex.Deployment needs it only when the deploy key does not fit.
// - The deploy key is optional. A deploy key of one deployment
//   (`prod:<name>|...`, `dev:<name>|...`) lets Convex.Deployment set
//   variables and push to that deployment with no access token. A preview
//   deploy key of a project (`preview:<team>:<project>|...`) lets it create,
//   push to, and delete preview deployments of that project with no access
//   token.
//
// Credentials are a layer, never props: they do not go into Alchemy state.
// Both values are Effects, so that building the providers layer never touches
// the environment or the filesystem. A value is read on the first call that
// needs it, which keeps `alchemy plan` on an unrelated stack free of Convex
// credential errors.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export interface ResolvedCredentials {
  /** Bearer token accepted by https://api.convex.dev/v1: a team access token, an OAuth token, or the Convex CLI login. */
  readonly accessToken: Redacted.Redacted<string>;
  /** Where the token came from, for error messages only. */
  readonly source: "env" | "explicit" | "convex-cli-login";
}

export interface CredentialsService {
  /** The Management API token. Dies when there is none. */
  readonly accessToken: Effect.Effect<ResolvedCredentials>;
  /** True when there is a Management API token. */
  readonly hasAccessToken: Effect.Effect<boolean>;
  /** A deploy key or a preview deploy key, or undefined. */
  readonly deployKey: Effect.Effect<Redacted.Redacted<string> | undefined>;
}

export class Credentials extends Context.Service<Credentials, CredentialsService>()(
  "@samebase/alchemy-convex/Credentials",
) {}

/** Environment variable for the access token, read by {@link fromConfig}. */
export const ACCESS_TOKEN_ENV = "CONVEX_ACCESS_TOKEN";

/** Environment variable for the deploy key, read by {@link fromConfig}. The Convex CLI reads the same name. */
export const DEPLOY_KEY_ENV = "CONVEX_DEPLOY_KEY";

/** The Convex CLI stores its device login here after `npx convex login`. */
export const convexCliConfigPath = () => join(homedir(), ".convex", "config.json");

const CliConfig = Schema.Struct({ accessToken: Schema.String });

export class CredentialsError extends Schema.TaggedError<CredentialsError>()("CredentialsError", {
  reason: Schema.String,
}) {}

/**
 * Token the Convex CLI saved on this machine. It works on the Management API
 * for the teams the logged-in user belongs to. Fails when nobody is logged in.
 */
export const readConvexCliLogin: Effect.Effect<ResolvedCredentials, CredentialsError> = Effect.gen(
  function* () {
    const path = convexCliConfigPath();
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () =>
        new CredentialsError({
          reason: `This step needs the Convex Management API. Set ${ACCESS_TOKEN_ENV} to a team access token, or run \`npx convex login\`. There is no Convex CLI login at ${path}.`,
        }),
    });
    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CliConfig))(text).pipe(
      Effect.mapError(() => new CredentialsError({ reason: `${path} has no accessToken` })),
    );
    return { accessToken: Redacted.make(parsed.accessToken), source: "convex-cli-login" } as const;
  },
);

/**
 * Default resolution through the stack ConfigProvider (process env, `.env`,
 * stack secrets): `CONVEX_ACCESS_TOKEN`, then the Convex CLI login on this
 * machine, for the access token; `CONVEX_DEPLOY_KEY` for the deploy key. A
 * developer who ran `npx convex login` needs nothing. CI sets only the
 * deploy key when the stack pushes to deployments that exist, and the access
 * token when the stack also creates projects or deployments.
 */
export const fromConfig = (): Layer.Layer<Credentials> =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolved = yield* Effect.cached(
        Config.Redacted(ACCESS_TOKEN_ENV).pipe(
          Effect.map((token): ResolvedCredentials => ({ accessToken: token, source: "env" })),
          Effect.catch(() => readConvexCliLogin),
          Effect.result,
        ),
      );
      const deployKey = yield* Effect.cached(
        Config.option(Config.Redacted(DEPLOY_KEY_ENV)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orDie,
        ),
      );
      return {
        accessToken: resolved.pipe(Effect.flatMap(Effect.fromResult), Effect.orDie),
        hasAccessToken: resolved.pipe(Effect.map(Result.isSuccess)),
        deployKey,
      };
    }),
  );

/** Explicit values, for tests or callers that already hold them. */
export const fromValues = (values: {
  readonly accessToken?: Redacted.Redacted<string>;
  readonly deployKey?: Redacted.Redacted<string>;
}): Layer.Layer<Credentials> =>
  Layer.succeed(Credentials, {
    accessToken:
      values.accessToken === undefined
        ? Effect.die(
            new CredentialsError({
              reason:
                "This step needs the Convex Management API, and fromValues got no accessToken.",
            }),
          )
        : Effect.succeed({ accessToken: values.accessToken, source: "explicit" } as const),
    hasAccessToken: Effect.succeed(values.accessToken !== undefined),
    deployKey: Effect.succeed(values.deployKey),
  });
