import { readFileSync } from "node:fs";
import { adopt } from "alchemy/AdoptPolicy";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { CreatedDeployKey } from "../src/DeployKey.ts";
import {
  EnvironmentVariableList,
  findVariable,
  updateVariable,
} from "../src/EnvironmentVariable.ts";
import * as Convex from "../src/index.ts";
import { FakeConvex } from "./fakeConvex.ts";

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

const deployment = "beaming-okapi-932";
const deployKey = Redacted.make(
  Schema.decodeUnknownSync(CreatedDeployKey)(fixture("deployment_create_deploy_key.json"))
    .deployKey,
);
const UPDATE = `POST ${deployment}.convex.cloud/api/v1/update_environment_variables`;

describe("updateVariable", () => {
  const conflict = {
    status: 503,
    body: fixture("deployment_update_environment_variables_conflict.json"),
  };

  it("writes again after a recorded write conflict", async () => {
    const fake = new FakeConvex().install();
    fake.scripted.set(UPDATE, [conflict, conflict]);
    await Effect.runPromise(
      updateVariable(deployment, deployKey, "SITE_URL", "https://example.com"),
    );
    expect(fake.lines()).toEqual([UPDATE, UPDATE, UPDATE]);
    expect(fake.variables.get(deployment)).toEqual({ SITE_URL: "https://example.com" });
  });

  it("gives up after four retries and fails with the conflict", async () => {
    const fake = new FakeConvex().install();
    fake.scripted.set(UPDATE, [conflict, conflict, conflict, conflict, conflict, conflict]);
    const error = await Effect.runPromise(
      Effect.flip(updateVariable(deployment, deployKey, "SITE_URL", "https://example.com")),
    );
    expect(error).toMatchObject({ status: 503, code: "OptimisticConcurrencyControlFailure" });
    expect(fake.lines()).toEqual([UPDATE, UPDATE, UPDATE, UPDATE, UPDATE]);
    expect(fake.variables.get(deployment)?.["SITE_URL"]).toBeUndefined();
  });

  it("does not write again after an error that a retry cannot fix", async () => {
    const fake = new FakeConvex().install();
    fake.scripted.set(UPDATE, [{ status: 404, body: fixture("project_not_found.json") }]);
    const error = await Effect.runPromise(
      Effect.flip(updateVariable(deployment, deployKey, "SITE_URL", "https://example.com")),
    );
    expect(error).toMatchObject({ status: 404 });
    expect(fake.lines()).toEqual([UPDATE]);
  });
});

describe("Convex.EnvironmentVariable through the engine", () => {
  const { test } = Test.make({
    providers: Convex.providers(Convex.fromToken(Redacted.make("test-token"))),
  });
  /** A variable name of the recorded listing. */
  const existing = "JWKS";
  const variable = (name: string) =>
    Convex.EnvironmentVariable("Variable", { deployment, deployKey, name, value: "new value" });

  test.provider("overwrites a variable that is not in state only with adoption", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      fake.variables.set(deployment, { [existing]: "old value" });
      const refused = yield* Effect.flip(stack.deploy(variable(existing).pipe(Effect.as({}))));
      expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      expect(fake.lines().filter((line) => line === UPDATE)).toEqual([]);
      expect(fake.variables.get(deployment)).toEqual({ [existing]: "old value" });

      yield* stack.deploy(variable(existing).pipe(adopt(true), Effect.as({})));
      expect(fake.variables.get(deployment)).toEqual({ [existing]: "new value" });
    }),
  );

  test.provider("retries a create after a conflict only while the name is still free", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const conflict = fixture("deployment_update_environment_variables_conflict.json");
      fake.scripted.set(UPDATE, [
        {
          status: 503,
          body: conflict,
          meanwhile: () => fake.variables.set(deployment, { SITE_URL: "other writer" }),
        },
      ]);
      const refused = yield* Effect.flip(stack.deploy(variable("SITE_URL").pipe(Effect.as({}))));
      expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      expect(fake.variables.get(deployment)).toEqual({ SITE_URL: "other writer" });
      expect(fake.lines().filter((line) => line === UPDATE)).toEqual([UPDATE]);
    }),
  );

  test.provider("retries a create after a conflict when the name is still free", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      fake.scripted.set(UPDATE, [
        { status: 503, body: fixture("deployment_update_environment_variables_conflict.json") },
      ]);
      yield* stack.deploy(variable("SITE_URL").pipe(Effect.as({})));
      expect(fake.variables.get(deployment)).toEqual({ SITE_URL: "new value" });
      expect(fake.lines().filter((line) => line === UPDATE)).toEqual([UPDATE, UPDATE]);
    }),
  );

  test.provider("keeps the variable when a refused rename is reverted", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      fake.variables.set(deployment, { [existing]: "old value" });
      yield* stack.deploy(variable("SITE_URL").pipe(Effect.as({})));
      const refused = yield* Effect.flip(stack.deploy(variable(existing).pipe(Effect.as({}))));
      expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      // Revert the name: the variable in state is still ours, and nothing deletes it.
      yield* stack.deploy(variable("SITE_URL").pipe(Effect.as({})));
      expect(fake.variables.get(deployment)).toEqual({
        [existing]: "old value",
        SITE_URL: "new value",
      });
    }),
  );

  test.provider("renames by writing the new variable before it removes the old one", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      yield* stack.deploy(variable("SITE_URL").pipe(Effect.as({})));
      const from = fake.sent.length;
      yield* stack.deploy(variable("SITE_URL_2").pipe(Effect.as({})));
      expect(fake.variables.get(deployment)).toEqual({ SITE_URL_2: "new value" });
      expect(
        fake.sent
          .slice(from)
          .filter((request) => `${request.method} ${request.path}` === UPDATE)
          .map((request) => request.body),
      ).toEqual([
        { changes: [{ name: "SITE_URL_2", value: "new value" }] },
        { changes: [{ name: "SITE_URL", value: null }] },
      ]);
    }),
  );

  test.provider("refuses to overwrite an existing variable after a rename", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      fake.variables.set(deployment, { [existing]: "old value" });
      yield* stack.deploy(variable("SITE_URL").pipe(Effect.as({})));
      // A rename replaces the resource. The engine reads nothing for the new
      // name, so reconcile itself must refuse.
      const refused = yield* Effect.flip(stack.deploy(variable(existing).pipe(Effect.as({}))));
      expect(refused).toMatchObject({
        _tag: "OwnedBySomeoneElse",
        message: expect.stringContaining("--adopt"),
      });
      expect(fake.variables.get(deployment)).toEqual({
        [existing]: "old value",
        SITE_URL: "new value",
      });
    }),
  );
});
