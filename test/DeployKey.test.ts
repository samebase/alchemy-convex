import { readFileSync } from "node:fs";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  CreatedDeployKey,
  createTrackedKey,
  DeployKeyList,
  DeployKeyRecoveryRequired,
  isKeyListed,
  keysListedAs,
  ListedKey,
  requestedKeyName,
} from "../src/DeployKey.ts";
import * as Convex from "../src/index.ts";
import { FakeConvex } from "./fakeConvex.ts";

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
    ).toEqual([{ id: 4869315, name: "tmp-alchemy-convex-fixture (0e71106d)" }]);
  });

  it("rejects an entry without a name", () => {
    const rows = recordedRows().map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "name")),
    );
    expect(() => Schema.decodeUnknownSync(DeployKeyList)(rows)).toThrow();
  });

  it("rejects an id that is not a number", () => {
    const rows = recordedRows().map((row) => ({ ...row, id: String(row["id"]) }));
    expect(() => Schema.decodeUnknownSync(DeployKeyList)(rows)).toThrow();
  });

  it("rejects the preview key list shape", () => {
    expect(() => Schema.decodeUnknownSync(DeployKeyList)({ items: recordedRows() })).toThrow();
  });
});

describe("keysListedAs", () => {
  it("finds the key Convex lists under the requested name plus an id suffix", () => {
    expect(keysListedAs([recorded], "tmp-alchemy-convex-fixture")).toEqual([recorded]);
  });

  it("finds the key Convex lists under the plain requested name", () => {
    const plain = { ...recorded, name: "tmp-alchemy-convex-fixture" };
    expect(keysListedAs([plain], "tmp-alchemy-convex-fixture")).toEqual([plain]);
  });

  it("finds a key with a UUID suffix, as Convex lists a second key with a taken name", () => {
    const second = {
      id: recorded.id + 1,
      name: "tmp-alchemy-convex-fixture (870993b4-ffe6-4911-adbd-e29f7fd712f2)",
    };
    expect(keysListedAs([second], "tmp-alchemy-convex-fixture")).toEqual([second]);
  });

  it("does not match a different requested name that shares a prefix", () => {
    expect(keysListedAs([recorded], "tmp-alchemy-convex")).toEqual([]);
    expect(keysListedAs([recorded], "tmp-alchemy-convex-fix")).toEqual([]);
  });

  it("matches a parenthesized requested name only exactly", () => {
    const parenthesized = { ...recorded, name: "tmp-alchemy-convex-fixture (old) (5b1c22aa)" };
    expect(keysListedAs([parenthesized], "tmp-alchemy-convex-fixture")).toEqual([]);
    expect(keysListedAs([parenthesized], "tmp-alchemy-convex-fixture (old)")).toEqual([
      parenthesized,
    ]);
  });

  it("returns every key with the requested name, not only the newest", () => {
    const second = { id: recorded.id + 1, name: "tmp-alchemy-convex-fixture (9a8b7c6d)" };
    expect(keysListedAs([second, recorded], "tmp-alchemy-convex-fixture")).toEqual([
      second,
      recorded,
    ]);
  });
});

describe("requestedKeyName", () => {
  it("appends a stable 12 hex character hash of the fqn and instance id", () => {
    const name = requestedKeyName("ci", "Backend/DeployKey", "instance-1");
    expect(name).toMatch(/^ci-[0-9a-f]{12}$/);
    expect(requestedKeyName("ci", "Backend/DeployKey", "instance-1")).toBe(name);
  });

  it("differs for two resources with the same name", () => {
    expect(requestedKeyName("ci", "KeyA", "instance-1")).not.toBe(
      requestedKeyName("ci", "KeyB", "instance-1"),
    );
  });

  it("differs for the old and the new generation of one replaced resource", () => {
    expect(requestedKeyName("ci", "KeyA", "instance-1")).not.toBe(
      requestedKeyName("ci", "KeyA", "instance-2"),
    );
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

describe("isKeyListed", () => {
  it("finds the key in state by numeric id, also when its name changed", () => {
    expect(isKeyListed([recorded], { keyId: recorded.id, uniqueName: "another name" })).toBe(true);
  });

  it("does not take another key with the same name for the key in state", () => {
    const other = { ...recorded, id: recorded.id + 1 };
    expect(isKeyListed([other], { keyId: recorded.id, uniqueName: recorded.name })).toBe(false);
  });

  it("finds a key from 0.1.x state, which has no id, by its listed name", () => {
    expect(isKeyListed([recorded], { keyId: undefined, uniqueName: recorded.name })).toBe(true);
    expect(isKeyListed([recorded], { keyId: undefined, uniqueName: "another name" })).toBe(false);
  });
});

describe("createTrackedKey", () => {
  const { deployKey: secret } = Schema.decodeUnknownSync(CreatedDeployKey)(
    fixture("deployment_create_deploy_key.json"),
  );
  const name = "tmp-alchemy-convex-fixture";
  const second = { id: recorded.id + 1, name: `${name} (870993b4-ffe6-4911-adbd-e29f7fd712f2)` };

  /** Runs createTrackedKey with one listing for each list call. */
  const track = (listings: ReadonlyArray<ReadonlyArray<typeof ListedKey.Type>>) => {
    const calls = { list: 0, create: 0, revoked: new Array<string>() };
    const effect = createTrackedKey({
      target: "deployment beaming-okapi-932",
      name,
      list: Effect.sync(() => listings[calls.list++] ?? []),
      create: Effect.sync(() => {
        calls.create += 1;
        return secret;
      }),
      revoke: (revoked) =>
        Effect.sync(() => {
          calls.revoked.push(revoked);
        }),
    });
    return { effect, calls };
  };

  it("returns the id, the listed name, and the secret of the one new key", async () => {
    const { effect, calls } = track([[], [recorded]]);
    const created = await Effect.runPromise(effect);
    expect({ ...created, secret: Redacted.value(created.secret) }).toEqual({
      keyId: recorded.id,
      uniqueName: recorded.name,
      secret,
    });
    expect(calls).toEqual({ list: 2, create: 1, revoked: [] });
  });

  it("fails before the create when a key with the name already exists", async () => {
    const { effect, calls } = track([[recorded]]);
    const error = await Effect.runPromise(Effect.flip(effect));
    expect(error).toBeInstanceOf(DeployKeyRecoveryRequired);
    expect(error).toMatchObject({ name, keys: [recorded], revokedNewKey: false });
    expect(error.message).toContain(`"${recorded.name}" (id ${recorded.id})`);
    expect(calls).toEqual({ list: 1, create: 0, revoked: [] });
  });

  it("revokes the new key by its secret when two listed keys have the name", async () => {
    const { effect, calls } = track([[], [recorded, second]]);
    const error = await Effect.runPromise(Effect.flip(effect));
    expect(error).toMatchObject({ keys: [recorded, second], revokedNewKey: true });
    expect(calls.revoked).toEqual([secret]);
  });

  it("revokes the new key by its secret when the listing does not show it", async () => {
    const { effect, calls } = track([[], []]);
    const error = await Effect.runPromise(Effect.flip(effect));
    expect(error).toMatchObject({ keys: [], revokedNewKey: true });
    expect(calls.revoked).toEqual([secret]);
  });
});

describe("Convex.DeployKey through the engine", () => {
  const { test } = Test.make({
    providers: Convex.providers(Convex.fromToken(Redacted.make("test-token"))),
  });
  const deployment = "beaming-okapi-932";
  const deleteCalls = (fake: FakeConvex, from: number) =>
    fake.sent.slice(from).filter((request) => request.path.endsWith("/delete_deploy_key"));

  test.provider("two keys with one name never delete each other", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const both = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* Convex.DeployKey("KeyA", { deployment, name: "ci" });
          const b = yield* Convex.DeployKey("KeyB", { deployment, name: "ci" });
          return {
            a: a.uniqueName,
            aId: a.keyId,
            aKey: a.deployKey,
            b: b.uniqueName,
            bId: b.keyId,
          };
        }),
      );
      expect(both.a).toMatch(/^ci-[0-9a-f]{12}$/);
      expect(both.b).toMatch(/^ci-[0-9a-f]{12}$/);
      expect(both.a).not.toBe(both.b);
      expect(both.aId).not.toBe(both.bId);

      const from = fake.sent.length;
      yield* stack.deploy(
        Effect.gen(function* () {
          const b = yield* Convex.DeployKey("KeyB", { deployment, name: "ci" });
          return { b: b.uniqueName };
        }),
      );
      // The delete names KeyA by its own secret, never by a listed name.
      expect(deleteCalls(fake, from).map((request) => request.body)).toEqual([
        { id: Redacted.value(both.aKey) },
      ]);
      expect(fake.keys.get(deployment)?.map((key) => key.name)).toEqual([both.b]);
    }),
  );

  test.provider(
    "deletes a key by its secret when Convex lists another key under its name",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const key = yield* Convex.DeployKey("Key", { deployment, name: "ci" });
            return { name: key.uniqueName, key: key.deployKey };
          }),
        );
        // Someone creates a second key with the same requested name outside Alchemy.
        fake.keys
          .get(deployment)
          ?.push({ id: 1, name: `${created.name} (outside)`, secret: "outside" });
        const from = fake.sent.length;
        yield* stack.destroy();
        expect(deleteCalls(fake, from).map((request) => request.body)).toEqual([
          { id: Redacted.value(created.key) },
        ]);
        expect(fake.keys.get(deployment)?.map((key) => key.secret)).toEqual(["outside"]);
      }),
  );
});
