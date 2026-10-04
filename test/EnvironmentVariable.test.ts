import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { EnvironmentVariableList, findVariable } from "../src/EnvironmentVariable.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/management/${file}`, import.meta.url), "utf8"));

const Envelope = Schema.Struct({
  environmentVariables: Schema.Record(Schema.String, Schema.Unknown),
});
const recorded = () =>
  Schema.decodeUnknownSync(Envelope)(fixture("deployment_list_environment_variables.json"))
    .environmentVariables;

const list = Schema.decodeUnknownSync(EnvironmentVariableList)(
  fixture("deployment_list_environment_variables.json"),
);

describe("EnvironmentVariableList", () => {
  it("decodes the recorded list_environment_variables payload", () => {
    expect(Object.keys(list.environmentVariables)).toEqual(["JWKS", "JWT_PRIVATE_KEY"]);
  });

  it("rejects a value that is not a string", () => {
    const body = { environmentVariables: { ...recorded(), JWKS: 1 } };
    expect(() => Schema.decodeUnknownSync(EnvironmentVariableList)(body)).toThrow();
  });

  it("rejects a body without environmentVariables", () => {
    expect(() => Schema.decodeUnknownSync(EnvironmentVariableList)(recorded())).toThrow();
  });
});

describe("findVariable", () => {
  it("returns attributes for a listed variable", () => {
    expect(findVariable(list, "beaming-okapi-932", "JWKS")).toEqual({
      deployment: "beaming-okapi-932",
      name: "JWKS",
    });
  });

  it("returns undefined for a variable that is not listed", () => {
    expect(findVariable(list, "beaming-okapi-932", "SITE_URL")).toBeUndefined();
  });

  it("does not match names inherited from the object prototype", () => {
    expect(findVariable(list, "beaming-okapi-932", "toString")).toBeUndefined();
    expect(findVariable(list, "beaming-okapi-932", "constructor")).toBeUndefined();
  });
});
