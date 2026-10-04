import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { CreatedDeployKey, DeployKeyList, ListedKey, selectCreatedKey } from "../src/DeployKey.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/management/${file}`, import.meta.url), "utf8"));

/** Recorded rows as plain records, so negative cases can derive mutated copies. */
const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const recordedRows = () =>
  Schema.decodeUnknownSync(Rows)(fixture("deployment_list_deploy_keys.json"));

/** The fixture holds exactly one key. */
const [recorded] = Schema.decodeUnknownSync(Schema.Tuple([ListedKey]))(
  fixture("deployment_list_deploy_keys.json"),
);

describe("DeployKeyList", () => {
  it("decodes the recorded list_deploy_keys payload", () => {
    expect(
      Schema.decodeUnknownSync(DeployKeyList)(fixture("deployment_list_deploy_keys.json")),
    ).toEqual([{ name: "tmp-alchemy-convex-fixture (0e71106d)", creationTime: 1791155252778 }]);
  });

  it("rejects an entry without a name", () => {
    const rows = recordedRows().map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "name")),
    );
    expect(() => Schema.decodeUnknownSync(DeployKeyList)(rows)).toThrow();
  });

  it("rejects a creationTime that is not a number", () => {
    const rows = recordedRows().map((row) => ({
      ...row,
      creationTime: String(row["creationTime"]),
    }));
    expect(() => Schema.decodeUnknownSync(DeployKeyList)(rows)).toThrow();
  });

  it("rejects the preview key list shape", () => {
    expect(() => Schema.decodeUnknownSync(DeployKeyList)({ items: recordedRows() })).toThrow();
  });
});

describe("selectCreatedKey", () => {
  it("finds the key Convex lists under the requested name plus an id suffix", () => {
    expect(selectCreatedKey([recorded], "tmp-alchemy-convex-fixture")).toEqual(recorded);
  });

  it("does not match a different requested name that shares a prefix", () => {
    expect(selectCreatedKey([recorded], "tmp-alchemy-convex")).toBeUndefined();
    expect(selectCreatedKey([recorded], "tmp-alchemy-convex-fixture (0e71106d)")).toBeUndefined();
  });

  it("matches a parenthesized requested name only exactly", () => {
    const parenthesized = { ...recorded, name: "tmp-alchemy-convex-fixture (old) (5b1c22aa)" };
    expect(selectCreatedKey([parenthesized], "tmp-alchemy-convex-fixture")).toBeUndefined();
    expect(selectCreatedKey([parenthesized], "tmp-alchemy-convex-fixture (old)")).toEqual(
      parenthesized,
    );
  });

  it("picks the newest key when an earlier attempt left one with the same name", () => {
    const newer = {
      name: "tmp-alchemy-convex-fixture (9a8b7c6d)",
      creationTime: recorded.creationTime + 1,
    };
    expect(selectCreatedKey([newer, recorded], "tmp-alchemy-convex-fixture")).toEqual(newer);
    expect(selectCreatedKey([recorded, newer], "tmp-alchemy-convex-fixture")).toEqual(newer);
  });
});

describe("CreatedDeployKey", () => {
  it("decodes the recorded create_deploy_key payload", () => {
    expect(
      Schema.decodeUnknownSync(CreatedDeployKey)(fixture("deployment_create_deploy_key.json")),
    ).toEqual({
      deployKey: "dev:beaming-okapi-932|REDACTED",
    });
  });

  it("rejects a body without deployKey", () => {
    const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      fixture("deployment_create_deploy_key.json"),
    );
    const withoutKey = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "deployKey"),
    );
    expect(() => Schema.decodeUnknownSync(CreatedDeployKey)(withoutKey)).toThrow();
  });
});
