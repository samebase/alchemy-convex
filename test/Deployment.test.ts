// Convex.Deployment through the real Alchemy engine, against FakeConvex. Each
// test gets a fresh in-memory state.
import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect } from "vitest";
import * as Convex from "../src/index.ts";
import { FakeConvex } from "./fakeConvex.ts";

const TEAM = 38516;
const NAME = "tmp-alchemy-convex-fixture";
const API = "api.convex.dev/v1";

const { test } = Test.make({
  providers: Convex.providers(Convex.fromToken(Redacted.make("test-token"))),
});

const attributes = (deployment: Convex.Deployment) => ({
  projectId: deployment.projectId,
  type: deployment.type,
  name: deployment.name,
  reference: deployment.reference,
  previewName: deployment.previewName,
  url: deployment.url,
  siteUrl: deployment.siteUrl,
});

const deployment = (props: Convex.DeploymentProps) =>
  Effect.gen(function* () {
    return attributes(yield* Convex.Deployment("Deployment", props));
  });

const destroyable = (props: Convex.DeploymentProps) =>
  Effect.gen(function* () {
    return attributes(yield* Convex.Deployment("Deployment", props).pipe(RemovalPolicy.destroy()));
  });

describe("Convex.Deployment", () => {
  test.provider("takes over the production deployment of a new project without --adopt", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Convex.Project("Project", { team: TEAM, name: NAME });
          const prod = yield* Convex.Deployment("Prod", {
            projectId: project.projectId,
            type: "prod",
          });
          return { projectId: project.projectId, prod: attributes(prod) };
        }),
      );
      const name = fake.project(out.projectId)?.prodDeploymentName;
      expect(out.prod).toEqual({
        projectId: out.projectId,
        type: "prod",
        name,
        reference: "production",
        previewName: undefined,
        url: `https://${name}.convex.cloud`,
        siteUrl: `https://${name}.convex.site`,
      });
      expect(fake.lines().filter((line) => line.endsWith("/create_deployment"))).toEqual([]);
    }),
  );

  test.provider("takes over the production deployment of an existing project", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const out = yield* stack.deploy(deployment({ projectId, type: "prod" }));
      expect(out.name).toBe(fake.project(projectId)?.prodDeploymentName);
      // Reads only: the takeover changes nothing in Convex.
      expect(fake.lines().filter((line) => !line.startsWith("GET "))).toEqual([]);
    }),
  );

  test.provider("fails with ProductionDeploymentNotFound when the project has none", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      fake.deployments.length = 0;
      const error = yield* Effect.flip(stack.deploy(deployment({ projectId, type: "prod" })));
      expect(error).toBeInstanceOf(Convex.ProductionDeploymentNotFound);
      expect(error).toMatchObject({
        projectId,
        message: expect.stringContaining("npx convex deployment create --type prod --default"),
      });
    }),
  );

  test.provider("creates a preview deployment with the name as preview name", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const out = yield* stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" }));
      expect(out).toMatchObject({
        projectId,
        type: "preview",
        reference: "preview/pr-42",
        previewName: "pr-42",
        url: `https://${out.name}.convex.cloud`,
        siteUrl: `https://${out.name}.convex.site`,
      });
      expect(fake.deployment(out.name)?.previewIdentifier).toBe("pr-42");
      const create = fake.sent.find((request) => request.path.endsWith("/create_deployment"));
      expect(create?.body).toEqual({ type: "preview", reference: "pr-42" });
    }),
  );

  test.provider("creates a dev deployment with the name as reference", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const out = yield* stack.deploy(deployment({ projectId, type: "dev", name: "staging" }));
      expect(out).toMatchObject({ type: "dev", reference: "staging", previewName: undefined });
      expect(fake.deployment(out.name)).toMatchObject({ deploymentType: "dev", isDefault: false });
    }),
  );

  test.provider("keeps the deployment on the next deploy without a new create", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const first = yield* stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" }));
      const from = fake.sent.length;
      const second = yield* stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" }));
      expect(second).toEqual(first);
      expect(fake.lines(from)).toEqual([`GET ${API}/deployments/${first.name}`]);
    }),
  );

  test.provider("creates an expired preview deployment again", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const first = yield* stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" }));
      // Convex deletes a preview deployment when it expires.
      fake.deployments.splice(
        fake.deployments.findIndex((row) => row["name"] === first.name),
        1,
      );
      const second = yield* stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" }));
      expect(second.name).not.toBe(first.name);
      expect(second.previewName).toBe("pr-42");
      expect(fake.deploymentsOf(projectId).map((row) => row.name)).toContain(second.name);
    }),
  );

  test.provider(
    "refuses a preview deployment that is not in state, and never creates over it",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        // Such as a preview that `npx convex deploy --preview-name pr-42` created in CI.
        const existing = fake.addDeployment({ projectId, type: "preview", name: "pr-42" });
        const refused = yield* Effect.flip(
          stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" })),
        );
        expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return attributes(
              yield* Convex.Deployment("Deployment", {
                projectId,
                type: "preview",
                name: "pr-42",
              }).pipe(adopt(true)),
            );
          }),
        );
        expect(adopted.name).toBe(existing);
        expect(fake.lines().filter((line) => line.endsWith("/create_deployment"))).toEqual([]);
        expect(fake.deployment(existing)).toBeDefined();
      }),
  );

  test.provider("refuses a preview deployment that appears after the plan", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const created = yield* stack.deploy(
        deployment({ projectId, type: "preview", name: "pr-42" }),
      );
      // The preview in state expires, and CI creates a new one with the same name.
      fake.deployments.splice(
        fake.deployments.findIndex((row) => row["name"] === created.name),
        1,
      );
      const other = fake.addDeployment({ projectId, type: "preview", name: "pr-42" });
      const refused = yield* Effect.flip(
        stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" })),
      );
      expect(refused).toMatchObject({
        _tag: "OwnedBySomeoneElse",
        message: expect.stringContaining("--adopt"),
      });
      expect(fake.deployment(other)).toBeDefined();
      expect(fake.lines().filter((line) => line.endsWith("/create_deployment")).length).toBe(1);
    }),
  );

  test.provider("fails with AmbiguousDeployment for two previews with one name", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const a = fake.addDeployment({ projectId, type: "preview", name: "pr-42" });
      const b = fake.addDeployment({ projectId, type: "preview", name: "pr-42" });
      const error = yield* Effect.flip(
        stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" })),
      );
      expect(error).toBeInstanceOf(Convex.AmbiguousDeployment);
      expect(error).toMatchObject({ deployments: [a, b] });
    }),
  );

  test.provider("fails a type change with DeploymentIdentityChange before any call", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const first = yield* stack.deploy(deployment({ projectId, type: "prod" }));
      const from = fake.sent.length;
      const error = yield* Effect.flip(
        stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" })),
      );
      expect(error).toBeInstanceOf(Convex.DeploymentIdentityChange);
      expect(error).toMatchObject({
        deployment: first.name,
        field: "type",
        current: "prod",
        requested: "preview",
        message: expect.stringContaining("new resource with a new logical id"),
      });
      expect(fake.lines(from)).toEqual([]);
    }),
  );

  test.provider("fails a preview name change with DeploymentIdentityChange", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const first = yield* stack.deploy(deployment({ projectId, type: "preview", name: "pr-42" }));
      const from = fake.sent.length;
      const error = yield* Effect.flip(
        stack.deploy(deployment({ projectId, type: "preview", name: "pr-43" })),
      );
      expect(error).toMatchObject({
        _tag: "DeploymentIdentityChange",
        field: "name",
        current: "pr-42",
        requested: "pr-43",
      });
      expect(fake.lines(from)).toEqual([]);
      expect(fake.deployment(first.name)).toBeDefined();
    }),
  );

  test.provider("fails a projectId change with DeploymentIdentityChange", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const otherProject = fake.addProject({ name: `${NAME}-2`, teamId: TEAM });
      yield* stack.deploy(deployment({ projectId, type: "dev", name: "staging" }));
      const error = yield* Effect.flip(
        stack.deploy(deployment({ projectId: otherProject, type: "dev", name: "staging" })),
      );
      expect(error).toMatchObject({
        _tag: "DeploymentIdentityChange",
        field: "projectId",
        current: String(projectId),
        requested: String(otherProject),
      });
    }),
  );

  test.provider("keeps every type of deployment with the default policy", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const prod = yield* Convex.Deployment("Prod", { projectId, type: "prod" });
          const dev = yield* Convex.Deployment("Dev", { projectId, type: "dev", name: "staging" });
          const preview = yield* Convex.Deployment("Preview", {
            projectId,
            type: "preview",
            name: "pr-42",
          });
          return { names: [prod.name, dev.name, preview.name] };
        }),
      );
      const from = fake.sent.length;
      yield* stack.destroy();
      expect(fake.lines(from)).toEqual([]);
      for (const name of out.names) expect(fake.deployment(name)).toBeDefined();
    }),
  );

  test.provider("deletes a preview deployment with RemovalPolicy.destroy()", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const out = yield* stack.deploy(destroyable({ projectId, type: "preview", name: "pr-42" }));
      yield* stack.destroy();
      expect(fake.lines()).toContain(`POST ${API}/deployments/${out.name}/delete`);
      expect(fake.deployment(out.name)).toBeUndefined();
    }),
  );

  test.provider("keeps the preview deployment with RemovalPolicy.retain()", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          return attributes(
            yield* Convex.Deployment("Deployment", {
              projectId,
              type: "preview",
              name: "pr-42",
            }).pipe(RemovalPolicy.retain()),
          );
        }),
      );
      yield* stack.destroy();
      expect(fake.lines().filter((line) => line.endsWith("/delete"))).toEqual([]);
      expect(fake.deployment(out.name)).toBeDefined();
    }),
  );

  test.provider(
    "never deletes a production deployment, also with RemovalPolicy.destroy()",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const projectId = fake.addProject({ name: NAME, teamId: TEAM });
        const out = yield* stack.deploy(destroyable({ projectId, type: "prod" }));
        yield* stack.destroy();
        expect(fake.lines().filter((line) => line.endsWith("/delete"))).toEqual([]);
        expect(fake.deployment(out.name)).toBeDefined();
      }),
  );

  test.provider("treats a deployment that is already gone as deleted", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const projectId = fake.addProject({ name: NAME, teamId: TEAM });
      const out = yield* stack.deploy(destroyable({ projectId, type: "dev", name: "staging" }));
      fake.deployments.splice(
        fake.deployments.findIndex((row) => row["name"] === out.name),
        1,
      );
      yield* stack.destroy();
      expect(fake.lines()).toContain(`POST ${API}/deployments/${out.name}/delete`);
    }),
  );
});
