// Live round trip for project default environment variables against the
// Management API. Runs only with ALCHEMY_CONVEX_LIVE=1 and a Convex login
// (CONVEX_ACCESS_TOKEN or `npx convex login`) that can reach the throwaway
// project in env.ts.
//
// Assertions compare values as booleans so a failure never prints one.
import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { fromConfig } from "../../src/Credentials.ts";
import {
  type DeploymentType,
  findDefault,
  listDefaults,
  updateDefault,
} from "../../src/DefaultEnvironmentVariable.ts";
import { absentAsUndefined, ManagementApi, ManagementApiLive } from "../../src/ManagementApi.ts";
import { liveEnabled, liveTargets } from "./env.ts";

const { projectId } = liveTargets;

/** The full listing row. The provider never decodes `value`; this test checks updates with it. */
const ListingWithValues = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
      deploymentTypes: Schema.Array(Schema.String),
    }),
  ),
  pagination: Schema.Struct({ hasMore: Schema.Boolean }),
});

const roundTrip = Effect.gen(function* () {
  const api = yield* ManagementApi;
  const name = `TMP_ALCHEMY_CONVEX_DEFAULT_${randomBytes(4).toString("hex").toUpperCase()}`;
  const attributes = { projectId, name, deploymentType: "preview" } as const;

  const find = (deploymentType: DeploymentType) =>
    listDefaults(api, projectId, name, deploymentType).pipe(
      Effect.map((list) => findDefault(list, projectId, name, deploymentType)),
    );
  const listWithValues = api
    .request("list default environment variables", (client) =>
      client.GET("/projects/{project_id}/list_default_environment_variables", {
        params: { path: { project_id: projectId }, query: { name, deploymentType: "preview" } },
      }),
    )
    .pipe(Effect.map((body) => Schema.decodeUnknownSync(ListingWithValues)(body)));
  const hasValue = (value: string) =>
    listWithValues.pipe(Effect.map(({ items }) => items.length === 1 && items[0]?.value === value));
  const remove = updateDefault(api, projectId, name, "preview", null);

  yield* Effect.acquireUseRelease(
    updateDefault(api, projectId, name, "preview", Redacted.make("alchemy-convex-live-1")),
    () =>
      Effect.gen(function* () {
        expect(yield* find("preview")).toEqual(attributes);
        expect(yield* find("dev")).toBeUndefined();
        expect(yield* hasValue("alchemy-convex-live-1")).toBe(true);
        const listed = yield* listWithValues;
        console.log(
          `listed: ${JSON.stringify({
            ...listed,
            items: listed.items.map((item) => ({ ...item, value: "REDACTED" })),
          })}`,
        );

        // Upsert: a second set on the same name and type replaces the value.
        yield* updateDefault(api, projectId, name, "preview", "alchemy-convex-live-2");
        expect(yield* hasValue("alchemy-convex-live-2")).toBe(true);
        console.log(`default ${name} updated in place`);

        yield* remove;
        expect(yield* find("preview")).toBeUndefined();
        // Removing an absent default also succeeds.
        yield* remove;
        console.log(`default ${name} removed; a second removal also succeeds`);
      }),
    () => absentAsUndefined(remove),
  );
});

describe.skipIf(!liveEnabled)("live: default environment variables", () => {
  it("creates, lists, updates, and removes a preview default", async () => {
    await Effect.runPromise(
      roundTrip.pipe(Effect.provide(ManagementApiLive().pipe(Layer.provide(fromConfig())))),
    );
  }, 60_000);
});
