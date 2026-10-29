import assert from "node:assert/strict";
import { Resource } from "alchemy";
import * as Namespace from "alchemy/Namespace";
import * as Provider from "alchemy/Provider";
import * as State from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expect } from "vitest";
import * as Convex from "../src/index.ts";
import { api, internal } from "../src/store/convex/_generated/api.js";
import { FakeConvex } from "./fakeConvex.ts";
import { storeTest } from "./storeTest.ts";

type Consumer = Resource<"Test.UrlConsumer", { url: string }, { url: string; revision: number }>;
const Consumer = Resource<Consumer>("Test.UrlConsumer");
const { test } = Test.make({
  providers: Layer.mergeAll(
    Convex.providers(Convex.fromValues({ accessToken: Redacted.make("test-token") })),
    Provider.succeed(Consumer, {
      reconcile: ({ news, output }) =>
        Effect.succeed({ url: news.url, revision: (output?.revision ?? 0) + 1 }),
      delete: () => Effect.void,
    }),
  ),
});

test.provider("changes component bindings without replacing resources or pushing code", (stack) =>
  Effect.gen(function* () {
    const fake = new FakeConvex().install();
    const projectId = fake.addProject({ name: "component-bindings", teamId: 38516 });
    const program = (component: string | null) =>
      Effect.gen(function* () {
        const deployment = yield* Convex.Deployment("Deployment", {
          project: { projectId },
          type: "prod",
        });
        if (component !== null) {
          yield* Namespace.push(
            "Mail",
            Effect.gen(function* () {
              yield* Convex.bindComponent({
                deployment,
                component,
                namespace: yield* Namespace.CurrentNamespace,
              });
            }),
          );
        }
        const consumer = yield* Consumer("Consumer", { url: deployment.siteUrl });
        return {
          name: deployment.name,
          url: deployment.siteUrl,
          consumerRevision: consumer.revision,
        };
      });
    const row = () =>
      Effect.gen(function* () {
        const state = yield* Effect.flatten(State.State);
        return yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Deployment" });
      }).pipe(Effect.provide(stack.state));

    const initial = yield* stack.deploy(program(null));
    const before = yield* row();
    assert.ok(before !== undefined && "instanceId" in before);
    expect(yield* stack.deploy(program("mail"))).toEqual(initial);
    const bound = yield* row();
    const binding = {
      sid: 'convex.component:["Mail"]',
      data: { type: "component", path: "mail", namespace: ["Mail"] },
    };
    expect(bound).toMatchObject({ instanceId: before.instanceId, bindings: [binding] });
    expect(yield* stack.deploy(program("mail"))).toEqual(initial);
    expect(yield* row()).toEqual(bound);
    expect(yield* stack.deploy(program("renamed"))).toEqual(initial);
    expect(yield* row()).toMatchObject({
      instanceId: before.instanceId,
      bindings: [{ data: { path: "renamed" } }],
    });
    expect(yield* stack.deploy(program(null))).toEqual(initial);
    expect(yield* row()).toMatchObject({ instanceId: before.instanceId, bindings: [] });
    expect(fake.lines().every((line) => line.startsWith("GET "))).toBe(true);

    // Feed the real Alchemy state row through the store used by live subscribers.
    yield* Effect.promise(async () => {
      const t = storeTest();
      await t.mutation(internal.state.set, {
        stack: "samebase/mail",
        stage: "prod",
        fqn: "Deployment",
        value: JSON.stringify(State.encodeState(bound)),
        run: {
          version: 1,
          repository: "samebase/mail",
          stackFile: "alchemy.run.ts",
          branch: "main",
          pullRequest: null,
          headCommit: "test-commit",
          runUrl: null,
          source: "laptop",
          recordedAt: "2026-10-24T12:00:00.000Z",
        },
      });
      const result = await t
        .withIdentity({
          subject: "test-reader",
          scope: "alchemy:read",
          repository: "samebase/mail",
        })
        .query(api.reader.repository, {});
      expect(result.stacks).toHaveLength(1);
      const value = result.stacks[0]?.stages[0]?.resources[0]?.value;
      expect(value).toBeDefined();
      expect(JSON.parse(value ?? "null")).toMatchObject({ bindings: [binding] });
    });
  }),
);

test.provider("binds nested components, the stack root, and multiple namespaces", (stack) =>
  Effect.gen(function* () {
    const fake = new FakeConvex().install();
    const projectId = fake.addProject({ name: "nested-bindings", teamId: 38516 });
    yield* stack.deploy(
      Effect.gen(function* () {
        const deployment = yield* Convex.Deployment("Deployment", {
          project: { projectId },
          type: "prod",
        });
        yield* Convex.bindComponent({
          deployment,
          component: "workspace",
          namespace: undefined,
        });
        yield* Namespace.push(
          "Other",
          Effect.gen(function* () {
            yield* Convex.bindComponent({
              deployment,
              component: "workspace",
              namespace: yield* Namespace.CurrentNamespace,
            });
          }),
        );
        yield* Namespace.push(
          "Mail/Shared",
          Namespace.push(
            "Inbox",
            Effect.gen(function* () {
              const options = {
                deployment,
                component: "workspace/mail",
                namespace: yield* Namespace.CurrentNamespace,
              };
              yield* Convex.bindComponent(options);
              yield* Convex.bindComponent(options);
            }),
          ),
        );
      }),
    );
    const state = yield* Effect.flatten(State.State).pipe(Effect.provide(stack.state));
    expect(
      yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Deployment" }),
    ).toMatchObject({
      bindings: [
        {
          sid: 'convex.component:["Mail/Shared","Inbox"]',
          data: { type: "component", path: "workspace/mail", namespace: ["Mail/Shared", "Inbox"] },
        },
        {
          sid: 'convex.component:["Other"]',
          data: { type: "component", path: "workspace", namespace: ["Other"] },
        },
        {
          sid: "convex.component:[]",
          data: { type: "component", path: "workspace", namespace: [] },
        },
      ],
    });
  }),
);

test.provider("rejects empty names and conflicting namespace assignments before apply", (stack) =>
  Effect.gen(function* () {
    const fake = new FakeConvex().install();
    const projectId = fake.addProject({ name: "bad-bindings", teamId: 38516 });
    for (const component of ["", "other"]) {
      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const deployment = yield* Convex.Deployment("Deployment", {
              project: { projectId },
              type: "prod",
            });
            yield* Namespace.push(
              "Mail",
              Effect.gen(function* () {
                const namespace = yield* Namespace.CurrentNamespace;
                yield* Convex.bindComponent({
                  deployment,
                  component: "mail",
                  namespace,
                });
                yield* Convex.bindComponent({ deployment, component, namespace });
              }),
            );
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }
    expect(fake.lines()).toEqual([]);
  }),
);
