import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromValues } from "../src/Credentials.ts";
import { FakeConvex } from "./fakeConvex.ts";
import {
  ConvexApiError,
  isRetryableWriteError,
  ManagementApi,
  ManagementApiLive,
} from "../src/ManagementApi.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/management/${file}`, import.meta.url), "utf8"));

const ErrorBody = Schema.Struct({ code: Schema.String, message: Schema.String });

/** The error that ManagementApi makes from a recorded error body. */
const errorFrom = (
  file: string,
  status: number,
  change: { code?: string; message?: string } = {},
) =>
  new ConvexApiError({
    operation: "test",
    status,
    ...Schema.decodeUnknownSync(ErrorBody)(fixture(file)),
    ...change,
  });

describe("isRetryableWriteError", () => {
  it("retries the recorded write conflict of update_environment_variables", () => {
    expect(
      isRetryableWriteError(
        errorFrom("deployment_update_environment_variables_conflict.json", 503),
      ),
    ).toBe(true);
  });

  it("retries the recorded 500 of a parallel delete_preview_deploy_key", () => {
    expect(
      isRetryableWriteError(errorFrom("project_delete_preview_deploy_key_500.json", 500)),
    ).toBe(true);
  });

  it("retries the platform codes OCC and WriteConflict and the conflict message", () => {
    const file = "deployment_update_environment_variables_conflict.json";
    expect(isRetryableWriteError(errorFrom(file, 400, { code: "OCC" }))).toBe(true);
    expect(isRetryableWriteError(errorFrom(file, 400, { code: "WriteConflict" }))).toBe(true);
    expect(
      isRetryableWriteError(
        errorFrom(file, 400, {
          code: "Other",
          message:
            'Documents read from or written to the "_environment_variables" table changed while this mutation was being run and on every subsequent retry.',
        }),
      ),
    ).toBe(true);
  });

  it("does not retry the recorded 404", () => {
    expect(isRetryableWriteError(errorFrom("project_not_found.json", 404))).toBe(false);
  });
});

describe("isCredentialToken", () => {
  /** The recorded deploy key: `dev:beaming-okapi-932|REDACTED`. */
  const { deployKey } = Schema.decodeUnknownSync(Schema.Struct({ deployKey: Schema.String }))(
    fixture("deployment_create_deploy_key.json"),
  );
  const withCredential = (accessToken: string, secret: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ManagementApi;
        return yield* api.isCredentialToken(secret);
      }).pipe(
        Effect.provide(
          ManagementApiLive().pipe(
            Layer.provide(fromValues({ accessToken: Redacted.make(accessToken) })),
          ),
        ),
      ),
    );

  it("matches a key that carries the OAuth token after a new prefix", async () => {
    expect(await withCredential("team:samebase-live-tests|REDACTED", deployKey)).toBe(true);
  });

  it("matches a key that carries a token without a prefix", async () => {
    expect(await withCredential("REDACTED", deployKey)).toBe(true);
  });

  it("does not match a key with a token of its own", async () => {
    expect(await withCredential("team:samebase-live-tests|other", deployKey)).toBe(false);
  });
});

describe("ManagementApi.resolveTeamId", () => {
  const resolve = (token: string, team: string | number | undefined) =>
    Effect.gen(function* () {
      const api = yield* ManagementApi;
      return yield* api.resolveTeamId(team);
    }).pipe(
      Effect.provide(
        ManagementApiLive().pipe(Layer.provide(fromValues({ accessToken: Redacted.make(token) }))),
      ),
    );
  const failureOf = (effect: Effect.Effect<number, ConvexApiError>) =>
    Effect.runPromise(Effect.flip(effect)).then((error) => error.message);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a numeric id as it is, with no request", async () => {
    const fake = new FakeConvex().install();
    expect(await Effect.runPromise(resolve("cli-login", 38516))).toBe(38516);
    expect(await Effect.runPromise(resolve("cli-login", "38516"))).toBe(38516);
    expect(fake.sent).toEqual([]);
  });

  it("takes the team of a team access token, with or without a slug, read once", async () => {
    const fake = new FakeConvex().install();
    const both = Effect.gen(function* () {
      const api = yield* ManagementApi;
      return [yield* api.resolveTeamId("nicu"), yield* api.resolveTeamId(undefined)];
    }).pipe(
      Effect.provide(
        ManagementApiLive().pipe(
          Layer.provide(fromValues({ accessToken: Redacted.make(fake.teamToken) })),
        ),
      ),
    );
    expect(await Effect.runPromise(both)).toEqual([38516, 38516]);
    expect(fake.lines()).toEqual(["GET api.convex.dev/v1/token_details"]);
  });

  it("looks a slug up in the dashboard's team list for the Convex CLI login", async () => {
    const fake = new FakeConvex().install();
    expect(await Effect.runPromise(resolve("cli-login", "nicu"))).toBe(38516);
    expect(fake.lines()).toEqual([
      "GET api.convex.dev/v1/token_details",
      "GET api.convex.dev/api/dashboard/teams",
    ]);
    expect(await failureOf(resolve("cli-login", "no-such-team"))).toContain(
      'no team with slug "no-such-team"',
    );
    expect(await failureOf(resolve("cli-login", undefined))).toContain("set team to the slug");
  });
});
