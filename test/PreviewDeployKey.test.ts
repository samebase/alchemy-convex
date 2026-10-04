import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { selectCreatedKey } from "../src/DeployKey.ts";
import { CreatedPreviewDeployKey, PreviewDeployKeyList } from "../src/PreviewDeployKey.ts";

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
    expect(selectCreatedKey(items, "tmp-alchemy-convex-fixture")?.name).toBe(
      "tmp-alchemy-convex-fixture (0e71106d)",
    );
    expect(selectCreatedKey(items, "ci")).toBeUndefined();
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
