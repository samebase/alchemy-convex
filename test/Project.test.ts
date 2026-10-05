// Convex.Project through the real Alchemy engine, against FakeConvex. Each
// test gets a fresh in-memory state.
import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect } from "vitest";
import * as Convex from "../src/index.ts";
import { FakeConvex, recorded } from "./fakeConvex.ts";

/** Team of the recorded project.json. */
const TEAM = 522530;
/** Team of the recorded project_update.json. */
const OTHER_TEAM = 38516;
const NAME = "tmp-alchemy-convex-fixture";
const API = "api.convex.dev/v1";

const { test } = Test.make({
  providers: Convex.providers(Convex.fromToken(Redacted.make("test-token"))),
});

const project = (props: Convex.ProjectProps) =>
  Effect.gen(function* () {
    const created = yield* Convex.Project("Project", props);
    return { projectId: created.projectId, name: created.name, slug: created.slug };
  });

describe("Convex.Project", () => {
  test.provider("creates a project and takes its id from the create response", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const out = yield* stack.deploy(project({ team: TEAM, name: NAME }));
      expect(fake.project(out.projectId)?.name).toBe(NAME);
      expect(fake.lines()).toEqual([
        `GET ${API}/teams/${TEAM}/projects`,
        `GET ${API}/teams/${TEAM}/projects`,
        `POST ${API}/teams/${TEAM}/create_project`,
        `GET ${API}/projects/${out.projectId}`,
        `GET ${API}/projects/${out.projectId}/list_deployments`,
      ]);
    }),
  );

  test.provider("renames with PATCH, keeps the id and slug, and never lists projects", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const first = yield* stack.deploy(project({ team: TEAM, name: NAME }));
      const from = fake.sent.length;
      const renamed = yield* stack.deploy(project({ team: TEAM, name: `${NAME}-renamed` }));
      expect(renamed).toEqual({
        projectId: first.projectId,
        name: `${NAME}-renamed`,
        slug: first.slug,
      });
      expect(fake.lines(from)).toEqual([
        `GET ${API}/projects/${first.projectId}`,
        `PATCH ${API}/projects/${first.projectId}`,
        `GET ${API}/projects/${first.projectId}/list_deployments`,
      ]);
      expect(fake.sent.find((request) => request.method === "PATCH")?.body).toEqual({
        name: `${NAME}-renamed`,
      });
      expect(fake.projects.length).toBe(1);
    }),
  );

  test.provider("fails a team change with ProjectTeamChange before any call", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const first = yield* stack.deploy(project({ team: TEAM, name: NAME }));
      const from = fake.sent.length;
      const error = yield* Effect.flip(stack.deploy(project({ team: OTHER_TEAM, name: NAME })));
      expect(error).toBeInstanceOf(Convex.ProjectTeamChange);
      expect(error).toMatchObject({
        projectId: first.projectId,
        teamId: TEAM,
        requestedTeamId: OTHER_TEAM,
        message: expect.stringContaining("new resource with a new logical id"),
      });
      expect(fake.lines(from)).toEqual([]);
      expect(fake.project(first.projectId)?.teamId).toBe(TEAM);
    }),
  );

  test.provider("fails a deploymentType change with ProjectDeploymentChange", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const first = yield* stack.deploy(project({ team: TEAM, name: NAME }));
      const from = fake.sent.length;
      const error = yield* Effect.flip(
        stack.deploy(project({ team: TEAM, name: NAME, deploymentType: "dev" })),
      );
      expect(error).toBeInstanceOf(Convex.ProjectDeploymentChange);
      expect(error).toMatchObject({
        projectId: first.projectId,
        field: "deploymentType",
        current: "prod",
        requested: "dev",
        message: expect.stringContaining("new resource with a new logical id"),
      });
      expect(fake.lines(from)).toEqual([]);
    }),
  );

  test.provider("fails a deploymentRegion change with ProjectDeploymentChange", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      yield* stack.deploy(project({ team: TEAM, name: NAME }));
      const from = fake.sent.length;
      const error = yield* Effect.flip(
        stack.deploy(project({ team: TEAM, name: NAME, deploymentRegion: "aws-eu-west-1" })),
      );
      expect(error).toMatchObject({
        _tag: "ProjectDeploymentChange",
        field: "deploymentRegion",
        current: undefined,
        requested: "aws-eu-west-1",
      });
      expect(fake.lines(from)).toEqual([]);
    }),
  );

  test.provider(
    "keeps the project when the resource is destroyed with the default policy",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        const out = yield* stack.deploy(project({ team: TEAM, name: NAME }));
        const from = fake.sent.length;
        yield* stack.destroy();
        expect(fake.lines(from)).toEqual([]);
        expect(fake.project(out.projectId)?.name).toBe(NAME);
      }),
  );

  test.provider("deletes the project only with RemovalPolicy.destroy()", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const created = yield* Convex.Project("Project", { team: TEAM, name: NAME }).pipe(
            RemovalPolicy.destroy(),
          );
          return { projectId: created.projectId };
        }),
      );
      yield* stack.destroy();
      expect(fake.lines()).toContain(`POST ${API}/projects/${out.projectId}/delete`);
      expect(fake.project(out.projectId)).toBeUndefined();
    }),
  );

  test.provider(
    "records retain over the destroy policy of older state on the next deploy",
    (stack) =>
      Effect.gen(function* () {
        const fake = new FakeConvex().install();
        // State written with the destroy policy, as 0.1.x wrote it.
        const out = yield* stack.deploy(
          Effect.gen(function* () {
            const created = yield* Convex.Project("Project", { team: TEAM, name: NAME }).pipe(
              RemovalPolicy.destroy(),
            );
            return { projectId: created.projectId };
          }),
        );
        // One deploy with the default policy, then destroy.
        yield* stack.deploy(project({ team: TEAM, name: NAME }));
        yield* stack.destroy();
        expect(fake.lines().filter((line) => line.endsWith("/delete"))).toEqual([]);
        expect(fake.project(out.projectId)?.name).toBe(NAME);
      }),
  );

  test.provider("takes over a project with the same name only with adoption", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const existing = fake.addProject({ name: NAME, teamId: TEAM });
      const refused = yield* Effect.flip(stack.deploy(project({ team: TEAM, name: NAME })));
      expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          const created = yield* Convex.Project("Project", { team: TEAM, name: NAME }).pipe(
            adopt(true),
          );
          return { projectId: created.projectId };
        }),
      );
      expect(adopted.projectId).toBe(existing);
      expect(fake.lines().filter((line) => line.endsWith("/create_project"))).toEqual([]);
      expect(fake.projects.length).toBe(1);
    }),
  );

  test.provider("refuses a same-name project that appears after the plan", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      fake.addProject({ name: NAME, teamId: TEAM });
      // The plan reads an empty listing; reconcile reads the project.
      fake.hideProjectsFromListings = 1;
      const refused = yield* Effect.flip(stack.deploy(project({ team: TEAM, name: NAME })));
      expect(refused).toMatchObject({
        _tag: "OwnedBySomeoneElse",
        message: expect.stringContaining("--adopt"),
      });
      expect(fake.lines().filter((line) => line.endsWith("/create_project"))).toEqual([]);
    }),
  );

  test.provider("reads every page of the listing and finds a project on page two", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const existing = fake.addProject({ name: NAME, teamId: TEAM });
      // A newer project that the search also returns comes first.
      fake.addProject({ name: `${NAME}-2`, teamId: TEAM });
      fake.pageSize = 1;
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          const created = yield* Convex.Project("Project", { team: TEAM, name: NAME }).pipe(
            adopt(true),
          );
          return { projectId: created.projectId };
        }),
      );
      expect(adopted.projectId).toBe(existing);
      const listings = fake.sent.filter((request) => request.path.endsWith("/projects"));
      expect(listings.map((request) => request.query.toString())).toEqual([
        `q=${NAME}`,
        `q=${NAME}&cursor=1`,
      ]);
    }),
  );

  test.provider("fails with AmbiguousProject when two projects have the name", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const first = fake.addProject({ name: NAME, teamId: TEAM });
      const second = fake.addProject({ name: NAME, teamId: TEAM });
      const error = yield* Effect.flip(stack.deploy(project({ team: TEAM, name: NAME })));
      expect(error).toBeInstanceOf(Convex.AmbiguousProject);
      expect(error).toMatchObject({ teamId: TEAM, name: NAME, projectIds: [second, first] });
      expect(fake.lines().filter((line) => line.endsWith("/create_project"))).toEqual([]);
    }),
  );

  test.provider("stops on a repeated listing cursor", (stack) =>
    Effect.gen(function* () {
      const fake = new FakeConvex().install();
      const page = {
        ...recorded("teams_projects.json"),
        items: [],
        pagination: { hasMore: true, nextCursor: "repeated" },
      };
      fake.scripted.set(`GET ${API}/teams/${TEAM}/projects`, [
        { status: 200, body: page },
        { status: 200, body: page },
      ]);
      const error = yield* Effect.flip(stack.deploy(project({ team: TEAM, name: NAME })));
      expect(error).toMatchObject({ _tag: "ConvexApiError", code: "InvalidPagination" });
      expect(fake.lines()).toEqual([
        `GET ${API}/teams/${TEAM}/projects`,
        `GET ${API}/teams/${TEAM}/projects`,
      ]);
    }),
  );
});
