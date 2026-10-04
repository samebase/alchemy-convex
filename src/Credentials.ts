// Convex control-plane credentials for the provider.
//
// The service value is an Effect so that building the providers layer never
// touches the environment or the filesystem. The token is read on the first
// lifecycle call, which keeps `alchemy plan` on an unrelated stack free of
// Convex credential errors.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface ResolvedCredentials {
  /** Bearer token accepted by https://api.convex.dev/v1: a team access token, an OAuth token, or the Convex CLI login. */
  readonly accessToken: Redacted.Redacted<string>;
  /** Where the token came from, for error messages only. */
  readonly source: "env" | "explicit" | "convex-cli-login";
}

export class Credentials extends Context.Service<Credentials, Effect.Effect<ResolvedCredentials>>()(
  "@samebase/alchemy-convex/Credentials",
) {}

/** Environment variable read by {@link fromConfig}. */
export const ACCESS_TOKEN_ENV = "CONVEX_ACCESS_TOKEN";

/** The Convex CLI stores its device login here after `npx convex login`. */
export const convexCliConfigPath = () => join(homedir(), ".convex", "config.json");

const CliConfig = Schema.Struct({ accessToken: Schema.String });

/**
 * Token the Convex CLI saved on this machine. It works on the Management API
 * for the teams the logged-in user belongs to. Fails when nobody is logged in.
 */
export const readConvexCliLogin: Effect.Effect<ResolvedCredentials, CredentialsError> = Effect.gen(
  function* () {
    const path = convexCliConfigPath();
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () => new CredentialsError({ reason: `no Convex CLI login at ${path}` }),
    });
    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CliConfig))(text).pipe(
      Effect.mapError(() => new CredentialsError({ reason: `${path} has no accessToken` })),
    );
    return { accessToken: Redacted.make(parsed.accessToken), source: "convex-cli-login" } as const;
  },
);

export class CredentialsError extends Schema.TaggedError<CredentialsError>()("CredentialsError", {
  reason: Schema.String,
}) {}

/**
 * Default resolution: `CONVEX_ACCESS_TOKEN` from the stack ConfigProvider
 * (process env, `.env`, stack secrets), then the Convex CLI login on this
 * machine. CI sets the variable; a developer who ran `npx convex login` needs
 * nothing.
 */
export const fromConfig = (): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.cached(
      Config.Redacted(ACCESS_TOKEN_ENV).pipe(
        Effect.map((accessToken): ResolvedCredentials => ({ accessToken, source: "env" })),
        Effect.catch(() => readConvexCliLogin),
        Effect.orDie,
      ),
    ).pipe(Effect.flatten),
  );

/** Explicit token, for tests or callers that already hold a value. */
export const fromToken = (accessToken: Redacted.Redacted<string>): Layer.Layer<Credentials> =>
  Layer.succeed(Credentials, Effect.succeed({ accessToken, source: "explicit" } as const));
