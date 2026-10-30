// Convex.HubClient against the fake Convex control plane: the resource finds the base by name and
// runs the admin functions of the hub with a short-lived key.
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import * as Convex from "../src/index.ts";
import { fromValues } from "../src/Credentials.ts";
import { HUB_PROJECT_NAME, registerDevelopmentClient } from "../src/HubClient.ts";
import { ManagementApiLive } from "../src/ManagementApi.ts";
import { RUN_KEY_ACTIONS } from "../src/State.ts";
import { FakeConvex, Hub } from "./fakeConvex.ts";

const TEAM = 38516;
const ISSUER = "https://auth.test";
const CALLBACK = "https://happy-otter-123.convex.site/auth/hub/callback";

const { test } = Test.make({
  providers: Convex.providers(Convex.fromValues({ accessToken: Redacted.make("test-token") })),
});

const props = (overrides: Partial<Convex.HubClientProps> = {}): Convex.HubClientProps => ({
  team: TEAM,
  app: "scout",
  redirectUri: CALLBACK,
  deploymentType: "preview",
  clientName: "pr-1",
  softwareVersion: "abc",
  ...overrides,
});

const client = (input: Convex.HubClientProps) =>
  Effect.gen(function* () {
    const hubClient = yield* Convex.HubClient("HubClient", input);
    return {
      issuer: hubClient.issuer,
      clientId: hubClient.clientId,
      secret: Output.map(hubClient.clientSecret, Redacted.value),
    };
  });

/** A fake with the hub of the team on the production deployment of its project. */
const withHub = () => {
  const fake = new FakeConvex().install();
  const [deployment] = fake.deploymentsOf(
    fake.addProject({ name: HUB_PROJECT_NAME, teamId: TEAM }),
  );
  if (deployment === undefined) throw new Error("the fake project has no deployment");
  const hub = new Hub(ISSUER);
  fake.hubs.set(deployment.name, hub);
  return { fake, hub, deployment: deployment.name };
};

const KeyBody = Schema.Struct({ allowedActions: Schema.Array(Schema.String) });

describe("Convex.HubClient", () => {
  test.provider("registers with a key of the hub that runs internal functions only", (stack) =>
    Effect.gen(function* () {
      const { fake, hub, deployment } = withHub();
      const out = yield* stack.deploy(client(props()));
      expect(out).toEqual({ issuer: ISSUER, clientId: "cl_1", secret: "secret-of-cl_1" });
      expect(hub.clients.get("cl_1")).toEqual({
        appId: "scout",
        redirectUri: CALLBACK,
        deploymentType: "preview",
        clientName: "pr-1",
        softwareVersion: "abc",
        tokenEndpointAuthMethod: "client_secret_post",
      });
      const created = fake.sent.find((sent) => sent.path.endsWith("/create_deploy_key"));
      expect(Schema.decodeUnknownSync(KeyBody)(created?.body).allowedActions).toEqual([
        ...RUN_KEY_ACTIONS,
      ]);
      // The key of the call is gone again.
      expect(fake.lines().filter((line) => line.endsWith("/delete_deploy_key"))).toHaveLength(1);
      expect(fake.functionCalls).toEqual([`${deployment} identityBroker:registerClient`]);
    }),
  );

  test.provider("a deploy with the same redirect URI does not reach the hub", (stack) =>
    Effect.gen(function* () {
      const { fake, hub } = withHub();
      const first = yield* stack.deploy(client(props()));
      const again = yield* stack.deploy(
        client(props({ clientName: "other", softwareVersion: "d" })),
      );
      expect(again).toEqual(first);
      expect(hub.clients.size).toBe(1);
      expect(fake.functionCalls).toHaveLength(1);
    }),
  );

  test.provider("another app or team stores the new props and keeps the client", (stack) =>
    Effect.gen(function* () {
      const { fake, hub } = withHub();
      const first = yield* stack.deploy(client(props()));
      const again = yield* stack.deploy(client(props({ app: "other" })));
      expect(again).toEqual(first);
      expect(hub.clients.size).toBe(1);
      expect(fake.functionCalls).toHaveLength(1);
    }),
  );

  test.provider("another redirect URI is a new client, and the old one goes", (stack) =>
    Effect.gen(function* () {
      const { hub } = withHub();
      yield* stack.deploy(client(props()));
      const next = yield* stack.deploy(client(props({ redirectUri: `${CALLBACK}2` })));
      expect(next.clientId).toBe("cl_2");
      expect([...hub.clients.keys()]).toEqual(["cl_2"]);
    }),
  );

  test.provider("a destroy deletes the client", (stack) =>
    Effect.gen(function* () {
      const { hub } = withHub();
      yield* stack.deploy(client(props()));
      yield* stack.destroy();
      expect(hub.clients.size).toBe(0);
    }),
  );

  test.provider("a team without a hub project fails and names what is missing", (stack) =>
    Effect.gen(function* () {
      new FakeConvex().install();
      const error = yield* Effect.flip(stack.deploy(client(props())));
      expect(error).toBeInstanceOf(Convex.HubClientFailed);
      expect(error.message).toContain("no project identity-hub");
    }),
  );

  test.provider("a project without the hub functions fails with the Convex message", (stack) =>
    Effect.gen(function* () {
      const { fake, deployment } = withHub();
      fake.hubs.delete(deployment);
      const error = yield* Effect.flip(stack.deploy(client(props())));
      expect(error).toBeInstanceOf(Convex.HubClientFailed);
      expect(error.message).toContain(
        "Could not find function for 'identityBroker:registerClient'",
      );
    }),
  );
});

describe("registerDevelopmentClient", () => {
  const run = (convex: (args: readonly string[], input?: string) => string) =>
    registerDevelopmentClient({
      team: TEAM,
      app: "scout",
      callbackPath: "/auth/hub/callback",
      convex,
    }).pipe(
      Effect.provide(
        ManagementApiLive().pipe(
          Layer.provide(fromValues({ accessToken: Redacted.make("test-token") })),
        ),
      ),
      Effect.runPromise,
    );

  it("a deployment with all three variables keeps them", async () => {
    const { hub } = withHub();
    const convex = vi.fn(() => "HUB_ISSUER\nHUB_CLIENT_ID\nHUB_CLIENT_SECRET\nOTHER");
    expect(await run(convex)).toBeUndefined();
    expect(convex).toHaveBeenCalledTimes(1);
    expect(hub.clients.size).toBe(0);
  });

  it("a deployment with no complete client registers, and the secret goes on standard input", async () => {
    const { hub } = withHub();
    const inputs: (string | undefined)[] = [];
    const calls: string[] = [];
    const url = await run((args, input) => {
      calls.push(args.join(" "));
      inputs.push(input);
      if (args[0] === "run") return '"https://happy-otter-123.convex.site/"';
      return args[1] === "list" ? "HUB_ISSUER" : "";
    });
    expect(url).toBe(CALLBACK);
    expect(hub.clients.get("cl_1")).toMatchObject({
      appId: "scout",
      redirectUri: CALLBACK,
      deploymentType: "development",
      softwareVersion: "happy-otter-123.convex.site",
    });
    expect(calls.at(-1)).toBe("env set --force");
    expect(inputs.at(-1)).toBe(
      `HUB_ISSUER='${ISSUER}'\nHUB_CLIENT_ID='cl_1'\nHUB_CLIENT_SECRET='secret-of-cl_1'\n`,
    );
  });
});
