import { readFileSync } from "node:fs";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { fromToken } from "../src/Credentials.ts";
import {
  DefaultEnvironmentVariableList,
  findDefault,
  updateDefault,
} from "../src/DefaultEnvironmentVariable.ts";
import * as Convex from "../src/index.ts";
import { ManagementApi, ManagementApiLive } from "../src/ManagementApi.ts";
import { FakeConvex } from "./fakeConvex.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/management/${file}`, import.meta.url), "utf8"));

/**
 * The recorded unfiltered listing has a preview-only row and a row that
 * Convex merged for dev and preview because both share one value.
 */
const PREVIEW_ONLY = "TMP_ALCHEMY_CONVEX_DEFAULT_50A7FA0F";
const SHARED = "TMP_ALCHEMY_CONVEX_DEFAULT_50A7FA0F_SHARED";
const PROJECT_ID = 3145389;

const Rows = Schema.Struct({ items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) });
const recordedRows = () =>
  Schema.decodeUnknownSync(Rows)(fixture("project_list_default_environment_variables.json")).items;

const list = Schema.decodeUnknownSync(DefaultEnvironmentVariableList)(
  fixture("project_list_default_environment_variables.json"),
);

describe("DefaultEnvironmentVariableList", () => {
  it("decodes the recorded list_default_environment_variables payload", () => {
    expect(list).toEqual({
      items: [
        { name: PREVIEW_ONLY, deploymentTypes: ["preview"] },
        { name: SHARED, deploymentTypes: ["dev", "preview"] },
      ],
    });
  });

  it("rejects a row whose deploymentTypes is a single string", () => {
    const items = recordedRows().map((row) => ({ ...row, deploymentTypes: "preview" }));
    expect(() => Schema.decodeUnknownSync(DefaultEnvironmentVariableList)({ items })).toThrow();
  });

  it("rejects a row without a name", () => {
    const items = recordedRows().map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "name")),
    );
    expect(() => Schema.decodeUnknownSync(DefaultEnvironmentVariableList)({ items })).toThrow();
  });

  it("rejects a body without items", () => {
    expect(() =>
      Schema.decodeUnknownSync(DefaultEnvironmentVariableList)(recordedRows()),
    ).toThrow();
  });
});

describe("findDefault", () => {
  it("returns attributes for a listed name and deployment type", () => {
    expect(findDefault(list, PROJECT_ID, PREVIEW_ONLY, "preview")).toEqual({
      projectId: PROJECT_ID,
      name: PREVIEW_ONLY,
      deploymentType: "preview",
    });
  });

  it("matches each deployment type of a merged row", () => {
    expect(findDefault(list, PROJECT_ID, SHARED, "dev")?.deploymentType).toBe("dev");
    expect(findDefault(list, PROJECT_ID, SHARED, "preview")?.deploymentType).toBe("preview");
  });

  it("returns undefined for a deployment type the row does not cover", () => {
    expect(findDefault(list, PROJECT_ID, PREVIEW_ONLY, "dev")).toBeUndefined();
    expect(findDefault(list, PROJECT_ID, SHARED, "prod")).toBeUndefined();
  });

  it("returns undefined for a name that is not listed", () => {
    expect(findDefault(list, PROJECT_ID, "SITE_URL", "preview")).toBeUndefined();
  });
});

const UPDATE = `POST api.convex.dev/v1/projects/${PROJECT_ID}/update_default_environment_variables`;

describe("updateDefault", () => {
  it("writes again after a write conflict", async () => {
    const fake = new FakeConvex().install();
    // The recorded conflict of the deployment API, sent by the Management API.
    fake.scripted.set(UPDATE, [
      { status: 503, body: fixture("deployment_update_environment_variables_conflict.json") },
    ]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ManagementApi;
        yield* updateDefault(api, PROJECT_ID, PREVIEW_ONLY, "preview", "value");
      }).pipe(
        Effect.provide(ManagementApiLive().pipe(Layer.provide(fromToken(Redacted.make("t"))))),
      ),
    );
    expect(fake.lines()).toEqual([UPDATE, UPDATE]);
    expect(fake.defaults).toEqual([
      { projectId: PROJECT_ID, name: PREVIEW_ONLY, deploymentType: "preview" },
    ]);
  });
});

describe("Convex.DefaultEnvironmentVariable through the engine", () => {
  const { test } = Test.make({
    providers: Convex.providers(Convex.fromToken(Redacted.make("test-token"))),
  });

  test.provider("retries a create after a conflict only while the name is still free", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      fake.scripted.set(UPDATE, [
        {
          status: 503,
          body: fixture("deployment_update_environment_variables_conflict.json"),
          meanwhile: () =>
            fake.defaults.push({
              projectId: PROJECT_ID,
              name: PREVIEW_ONLY,
              deploymentType: "preview",
            }),
        },
      ]);
      const refused = yield* Effect.flip(
        stack.deploy(
          Convex.DefaultEnvironmentVariable("Default", {
            projectId: PROJECT_ID,
            name: PREVIEW_ONLY,
            deploymentType: "preview",
            value: "new value",
          }).pipe(Effect.as({})),
        ),
      );
      expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      expect(fake.lines().filter((line) => line === UPDATE)).toEqual([UPDATE]);
    }),
  );

  const preview = (name: string, value = "new value") =>
    Convex.DefaultEnvironmentVariable("Default", {
      projectId: PROJECT_ID,
      name,
      deploymentType: "preview",
      value,
    }).pipe(Effect.as({}));

  test.provider("updates the value in place", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      yield* stack.deploy(preview(PREVIEW_ONLY));
      const from = fake.sent.length;
      yield* stack.deploy(preview(PREVIEW_ONLY, "second value"));
      expect(
        fake.sent
          .slice(from)
          .filter((request) => `${request.method} ${request.path}` === UPDATE)
          .map((request) => request.body),
      ).toEqual([
        { changes: [{ name: PREVIEW_ONLY, deploymentType: "preview", value: "second value" }] },
      ]);
    }),
  );

  test.provider("fails a rename with VariableIdentityChange before any write", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      yield* stack.deploy(preview(PREVIEW_ONLY));
      const from = fake.sent.length;
      const refused = yield* Effect.flip(stack.deploy(preview(SHARED)));
      expect(refused).toMatchObject({
        _tag: "VariableIdentityChange",
        field: "name",
        current: PREVIEW_ONLY,
        requested: SHARED,
      });
      expect(fake.lines(from)).toEqual([]);
    }),
  );

  test.provider("fails a deploymentType change with VariableIdentityChange", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      yield* stack.deploy(preview(PREVIEW_ONLY));
      const from = fake.sent.length;
      const refused = yield* Effect.flip(
        stack.deploy(
          Convex.DefaultEnvironmentVariable("Default", {
            projectId: PROJECT_ID,
            name: PREVIEW_ONLY,
            deploymentType: "dev",
            value: "new value",
          }).pipe(Effect.as({})),
        ),
      );
      expect(refused).toMatchObject({
        _tag: "VariableIdentityChange",
        field: "deploymentType",
        current: "preview",
        requested: "dev",
      });
      expect(fake.lines(from)).toEqual([]);
    }),
  );

  test.provider("overwrites a default that is not in state only with adoption", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      fake.defaults.push({ projectId: PROJECT_ID, name: PREVIEW_ONLY, deploymentType: "preview" });
      const refused = yield* Effect.flip(
        stack.deploy(
          Convex.DefaultEnvironmentVariable("Default", {
            projectId: PROJECT_ID,
            name: PREVIEW_ONLY,
            deploymentType: "preview",
            value: "new value",
          }).pipe(Effect.as({})),
        ),
      );
      expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      expect(fake.lines().filter((line) => line === UPDATE)).toEqual([]);
    }),
  );
});
