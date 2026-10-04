// Convex.Project: a project in a Convex team, with its default production deployment.
//
// The Management API has no project update endpoint, so every property change
// is a replacement. Deleting a project deletes all of its deployments and data.
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { components } from "@convex-dev/platform/managementApi";
import { absentAsUndefined, ManagementApi } from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/** Region names the Management API accepts, from the generated schema. */
export type DeploymentRegion = components["schemas"]["RegionName"];

export interface ProjectProps {
  /** Team slug or numeric team id. A slug costs one extra lookup per run. */
  readonly team: string | number;
  /** Display name. Convex derives the slug from it. */
  readonly name: string;
  /** Region of the deployment created with the project. Defaults to the team default. */
  readonly deploymentRegion?: DeploymentRegion;
  /** Deployment created with the project. Defaults to `prod`. */
  readonly deploymentType?: "prod" | "dev";
}

export interface ProjectAttributes {
  readonly projectId: number;
  readonly slug: string;
  readonly name: string;
  readonly teamId: number;
  readonly prodDeploymentName: string | undefined;
  readonly prodDeploymentUrl: string | undefined;
}

export type Project = Resource<"Convex.Project", ProjectProps, ProjectAttributes, never, Providers>;
export const Project = Resource<Project>("Convex.Project");

/** Fields of GET /projects/{id} and GET /teams/{team}/projects that the provider uses. */
const ProjectDetails = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  slug: Schema.String,
  teamId: Schema.Number,
  prodDeploymentName: Schema.NullOr(Schema.String),
});
const ProjectList = Schema.Struct({ items: Schema.Array(ProjectDetails) });

const CreatedProject = Schema.Struct({
  projectId: Schema.Number,
  slug: Schema.String,
  deploymentName: Schema.NullOr(Schema.String),
  deploymentUrl: Schema.NullOr(Schema.String),
});

const DeploymentRow = Schema.Struct({
  name: Schema.String,
  deploymentType: Schema.String,
  isDefault: Schema.Boolean,
  deploymentUrl: Schema.String,
});
const DeploymentRows = Schema.Array(DeploymentRow);

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const api = yield* ManagementApi;

      const prodDeployment = (projectId: number) =>
        api
          .request("list deployments", (client) =>
            client.GET("/projects/{project_id}/list_deployments", {
              params: { path: { project_id: projectId } },
            }),
          )
          .pipe(
            Effect.map((rows) =>
              Schema.decodeUnknownSync(DeploymentRows)(rows).find(
                (row) => row.deploymentType === "prod" && row.isDefault,
              ),
            ),
          );

      const attributesOf = (details: typeof ProjectDetails.Type) =>
        prodDeployment(details.id).pipe(
          Effect.map((prod): ProjectAttributes => ({
            projectId: details.id,
            slug: details.slug,
            name: details.name,
            teamId: details.teamId,
            prodDeploymentName: prod?.name ?? details.prodDeploymentName ?? undefined,
            prodDeploymentUrl: prod?.deploymentUrl,
          })),
        );

      const getById = (projectId: number) =>
        absentAsUndefined(
          api.request("get project", (client) =>
            client.GET("/projects/{project_id}", { params: { path: { project_id: projectId } } }),
          ),
        ).pipe(
          Effect.map((body) =>
            body === undefined ? undefined : Schema.decodeUnknownSync(ProjectDetails)(body),
          ),
        );

      const findByName = (team: string | number, name: string) =>
        Effect.gen(function* () {
          const teamId = yield* api.resolveTeamId(team);
          const list = yield* api.request("list projects", (client) =>
            client.GET("/teams/{team_id}/projects", { params: { path: { team_id: teamId } } }),
          );
          return Schema.decodeUnknownSync(ProjectList)(list).items.find(
            (row) => row.name === name || row.slug === name,
          );
        });

      return {
        stables: ["projectId", "slug", "teamId"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          const changed =
            olds.team !== news.team ||
            olds.name !== news.name ||
            olds.deploymentRegion !== news.deploymentRegion ||
            olds.deploymentType !== news.deploymentType;
          return changed ? ({ action: "replace" } as const) : ({ action: "noop" } as const);
        }),

        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const details = yield* getById(output.projectId);
            return details === undefined ? undefined : yield* attributesOf(details);
          }
          // No state: an existing project with this name belongs to someone
          // else until the user passes --adopt. Convex has no ownership tags.
          const existing = yield* findByName(olds.team, olds.name);
          return existing === undefined ? undefined : Unowned(yield* attributesOf(existing));
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          if (output !== undefined) {
            // Properties are all create-time; diff maps changes to replace.
            const details = yield* getById(output.projectId);
            if (details !== undefined) return yield* attributesOf(details);
          }
          // A crash after create and before state write is recovered by read;
          // a project created by an earlier attempt is reused here too.
          const existing = yield* findByName(news.team, news.name);
          if (existing !== undefined) return yield* attributesOf(existing);
          const teamId = yield* api.resolveTeamId(news.team);
          const created = yield* api.request("create project", (client) =>
            client.POST("/teams/{team_id}/create_project", {
              params: { path: { team_id: teamId } },
              body: {
                projectName: news.name,
                deploymentType: news.deploymentType ?? "prod",
                ...(news.deploymentRegion === undefined
                  ? {}
                  : { deploymentRegion: news.deploymentRegion }),
              },
            }),
          );
          const parsed = Schema.decodeUnknownSync(CreatedProject)(created);
          const details = yield* getById(parsed.projectId);
          if (details === undefined) {
            return yield* Effect.die(
              new Error(`Convex created project ${parsed.projectId} but it cannot be read back`),
            );
          }
          return yield* attributesOf(details);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* absentAsUndefined(
            api.requestVoid("delete project", (client) =>
              client.POST("/projects/{project_id}/delete", {
                params: { path: { project_id: output.projectId } },
              }),
            ),
          );
        }),
      };
    }),
  );
