import { readFileSync } from "node:fs";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { keysListedAs } from "../src/DeployKey.ts";
import * as Convex from "../src/index.ts";
import { CreatedPreviewDeployKey, PreviewDeployKeyList } from "../src/PreviewDeployKey.ts";
import { FakeConvex } from "./fakeConvex.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/management/${file}`, import.meta.url), "utf8"));

/**
 * The recorded preview listing is empty. Live runs show preview rows with the
 * same fields as deploy key rows, so the non-empty cases reuse the recorded
 * deploy key rows inside the recorded `items` envelope.
 */
const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const Envelope = Schema.Record(Schema.String, Schema.Unknown);
const recordedRows = () =>
  Schema.decodeUnknownSync(Rows)(fixture("deployment_list_deploy_keys.json"));
const listBody = (items: unknown) => ({
  ...Schema.decodeUnknownSync(Envelope)(fixture("project_list_preview_deploy_keys.json")),
  items,
});

describe("PreviewDeployKeyList", () => {
  it("decodes the recorded list_preview_deploy_keys payload", () => {
    expect(
      Schema.decodeUnknownSync(PreviewDeployKeyList)(
        fixture("project_list_preview_deploy_keys.json"),
      ),
    ).toEqual({
      items: [],
    });
  });

  it("decodes a listing with a key and finds it by requested name", () => {
    const { items } = Schema.decodeUnknownSync(PreviewDeployKeyList)(listBody(recordedRows()));
    expect(keysListedAs(items, "tmp-alchemy-convex-fixture").map((key) => key.name)).toEqual([
      "tmp-alchemy-convex-fixture (0e71106d)",
    ]);
    expect(keysListedAs(items, "ci")).toEqual([]);
  });

  it("rejects a body without items", () => {
    const body = Schema.decodeUnknownSync(Envelope)(
      fixture("project_list_preview_deploy_keys.json"),
    );
    const withoutItems = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "items"),
    );
    expect(() => Schema.decodeUnknownSync(PreviewDeployKeyList)(withoutItems)).toThrow();
  });

  it("rejects the bare array shape of list_deploy_keys", () => {
    expect(() => Schema.decodeUnknownSync(PreviewDeployKeyList)(recordedRows())).toThrow();
  });

  it("rejects a row whose name is not a string", () => {
    const rows = recordedRows().map((row) => ({ ...row, name: 4869315 }));
    expect(() => Schema.decodeUnknownSync(PreviewDeployKeyList)(listBody(rows))).toThrow();
  });
});

describe("CreatedPreviewDeployKey", () => {
  /** No preview create payload is recorded; the deploy key one differs only in the field name. */
  const createdBody = () => {
    const body = Schema.decodeUnknownSync(Schema.Struct({ deployKey: Schema.String }))(
      fixture("deployment_create_deploy_key.json"),
    );
    return { previewDeployKey: body.deployKey };
  };

  it("decodes the create_preview_deploy_key payload", () => {
    expect(Schema.decodeUnknownSync(CreatedPreviewDeployKey)(createdBody())).toEqual({
      previewDeployKey: "dev:beaming-okapi-932|REDACTED",
    });
  });

  it("rejects the create_deploy_key field name", () => {
    expect(() =>
      Schema.decodeUnknownSync(CreatedPreviewDeployKey)(
        fixture("deployment_create_deploy_key.json"),
      ),
    ).toThrow();
  });

  it("rejects a secret that is not a string", () => {
    expect(() =>
      Schema.decodeUnknownSync(CreatedPreviewDeployKey)({
        ...createdBody(),
        previewDeployKey: null,
      }),
    ).toThrow();
  });
});

describe("Convex.PreviewDeployKey through the engine", () => {
  const { test } = Test.make({
    providers: Convex.providers(Convex.fromToken(Redacted.make("test-token"))),
  });
  /** The project of the recorded payloads. */
  const projectId = 3145389;

  test.provider("two preview keys with one name never delete each other", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const both = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* Convex.PreviewDeployKey("PreviewA", { projectId, name: "ci" });
          const b = yield* Convex.PreviewDeployKey("PreviewB", { projectId, name: "ci" });
          return { a: a.uniqueName, aKey: a.previewDeployKey, b: b.uniqueName };
        }),
      );
      expect(both.a).not.toBe(both.b);
      const from = fake.sent.length;
      yield* stack.deploy(
        Effect.gen(function* () {
          const b = yield* Convex.PreviewDeployKey("PreviewB", { projectId, name: "ci" });
          return { b: b.uniqueName };
        }),
      );
      const deletes = fake.sent
        .slice(from)
        .filter((request) => request.path.endsWith("/delete_preview_deploy_key"));
      expect(deletes.map((request) => request.body)).toEqual([{ id: Redacted.value(both.aKey) }]);
      expect(fake.previewKeys.get(projectId)?.map((key) => key.name)).toEqual([both.b]);
    }),
  );

  test.provider("retries a delete that Convex answers with a 500", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* Convex.PreviewDeployKey("Preview", { projectId, name: "ci" });
          return { name: key.uniqueName };
        }),
      );
      fake.scripted.set(`POST api.convex.dev/v1/projects/${projectId}/delete_preview_deploy_key`, [
        { status: 500, body: fixture("project_delete_preview_deploy_key_500.json") },
      ]);
      yield* stack.destroy();
      expect(
        fake.lines().filter((line) => line.endsWith("/delete_preview_deploy_key")).length,
      ).toBe(2);
      expect(fake.previewKeys.get(projectId)).toEqual([]);
    }),
  );
});
