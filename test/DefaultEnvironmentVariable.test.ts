import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { DefaultEnvironmentVariableList, findDefault } from "../src/DefaultEnvironmentVariable.ts";

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
