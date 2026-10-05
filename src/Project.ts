// Convex.Project: a project in a Convex team, with its default production deployment.
//
// Deleting a project deletes all of its deployments and data, so this
// resource never replaces a project and keeps it by default:
//
// - A name change is an update in place: PATCH /projects/{project_id} with
//   the new name. The slug stays the same.
// - `team`, `deploymentType`, and `deploymentRegion` cannot change on an
//   existing project. A change fails with a typed error that names the fix.
// - The removal policy is `retain`. Alchemy deletes the project only when the
//   resource has `RemovalPolicy.destroy()`.
// - With state, every call addresses the project by `output.projectId`. Only
//   a resource without state looks a project up by name, and it takes over a
//   project that it finds only when adoption is on.
import { Resource } from "alchemy";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { components } from "@convex-dev/platform/managementApi";
import { shouldAdopt } from "./Adoption.ts";
import { absentAsUndefined, ConvexApiError, ManagementApi } from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/** Region names the Management API accepts, from the generated schema. */
export type DeploymentRegion = components["schemas"]["RegionName"];

export interface ProjectProps {
  /** Team slug or numeric team id. A slug costs one extra lookup per run. Cannot change. */
  readonly team: string | number;
  /** Display name. Convex derives the slug from it at creation. A change renames the project. */
  readonly name: string;
  /** Region of the deployment created with the project. Defaults to the team default. Cannot change. */
  readonly deploymentRegion?: DeploymentRegion;
  /** Deployment created with the project. Defaults to `prod`. Cannot change. */
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
export const Project = Resource<Project>("Convex.Project", { defaultRemovalPolicy: "retain" });

/** The props change the team of an existing project. Convex cannot move a project. */
export class ProjectTeamChange extends Schema.TaggedError<ProjectTeamChange>()(
  "ProjectTeamChange",
  { projectId: Schema.Number, teamId: Schema.Number, requestedTeamId: Schema.Number },
) {
  override get message() {
    return `Convex.Project cannot move project ${this.projectId} from team ${this.teamId} to team ${this.requestedTeamId}. Set team back to ${this.teamId}. To use the other team, create a new resource with a new logical id and move the data yourself.`;
  }
}

/**
 * The props change `deploymentType` or `deploymentRegion` of an existing
 * project. Convex uses them only when it creates the project.
 */
export class ProjectDeploymentChange extends Schema.TaggedError<ProjectDeploymentChange>()(
  "ProjectDeploymentChange",
  {
    projectId: Schema.Number,
    field: Schema.Literals(["deploymentType", "deploymentRegion"]),
    current: Schema.UndefinedOr(Schema.String),
    requested: Schema.UndefinedOr(Schema.String),
  },
) {
  override get message() {
    const show = (value: string | undefined) => (value === undefined ? "(not set)" : value);
    return `Convex.Project cannot change ${this.field} of project ${this.projectId} from ${show(this.current)} to ${show(this.requested)}: Convex uses it only when it creates a project. Set ${this.field} back to ${show(this.current)}. For a new deployment, create a new resource with a new logical id and move the data yourself.`;
  }
}

/** More than one project in the team has the name, so the lookup cannot choose one. */
export class AmbiguousProject extends Schema.TaggedError<AmbiguousProject>()("AmbiguousProject", {
  teamId: Schema.Number,
  name: Schema.String,
  projectIds: Schema.Array(Schema.Number),
}) {
  override get message() {
    return `Team ${this.teamId} has ${this.projectIds.length} projects named "${this.name}" (ids ${this.projectIds.join(", ")}). Convex.Project does not choose one. Rename the projects in the Convex dashboard so that only one has this name, or use a different name.`;
  }
}

/** Convex answered a create call but then did not return the project. */
export class CreatedProjectNotFound extends Schema.TaggedError<CreatedProjectNotFound>()(
  "CreatedProjectNotFound",
  { projectId: Schema.Number },
) {
  override get message() {
    return `Convex created project ${this.projectId} but GET /projects/${this.projectId} did not return it. Run the deploy again with --adopt to take over project ${this.projectId}.`;
  }
}

/** Fields of GET /projects/{id}, PATCH /projects/{id}, and GET /teams/{team}/projects rows that the provider uses. */
const ProjectDetails = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  slug: Schema.String,
  teamId: Schema.Number,
  prodDeploymentName: Schema.NullOr(Schema.String),
});
type ProjectDetails = typeof ProjectDetails.Type;

/** GET /teams/{team_id}/projects: one page of projects. */
export const ProjectPage = Schema.Struct({
  items: Schema.Array(ProjectDetails),
  pagination: Schema.Struct({
    hasMore: Schema.Boolean,
    nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

/** POST /teams/{team_id}/create_project. Only the id: everything else comes from GET /projects/{id}. */
const CreatedProject = Schema.Struct({ projectId: Schema.Number });

const DeploymentRow = Schema.Struct({
  name: Schema.String,
  deploymentType: Schema.String,
  isDefault: Schema.Boolean,
  deploymentUrl: Schema.String,
});
const DeploymentRows = Schema.Array(DeploymentRow);

/**
 * Fails with {@link ProjectDeploymentChange} when a create-time prop
 * changed. An omitted `deploymentType` means `prod`.
 */
const checkCreateTimeProps = (projectId: number, olds: ProjectProps, news: ProjectProps) => {
  const oldType = olds.deploymentType ?? "prod";
  const newType = news.deploymentType ?? "prod";
  if (oldType !== newType) {
    return Effect.fail(
      new ProjectDeploymentChange({
        projectId,
        field: "deploymentType",
        current: oldType,
        requested: newType,
      }),
    );
  }
  if (olds.deploymentRegion !== news.deploymentRegion) {
    return Effect.fail(
      new ProjectDeploymentChange({
        projectId,
        field: "deploymentRegion",
        current: olds.deploymentRegion,
        requested: news.deploymentRegion,
      }),
    );
  }
  return Effect.void;
};

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

      const attributesOf = (details: ProjectDetails) =>
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

      /**
       * The one project in the team with exactly this name, or undefined.
       * Reads every page. `q` narrows the listing on the server, and the
       * exact match here decides. Pattern from Confect
       * `packages/alchemy/src/ConvexClient.ts` and `Project.ts`
       * (https://github.com/rjdellecese/confect, ISC license).
       */
      const findByName = (teamId: number, name: string) =>
        Effect.gen(function* () {
          const matches: ProjectDetails[] = [];
          const seenCursors = new Set<string>();
          let cursor: string | undefined;
          while (true) {
            const body = yield* api.request("list projects", (client) =>
              client.GET("/teams/{team_id}/projects", {
                params: {
                  path: { team_id: teamId },
                  query: { q: name, ...(cursor === undefined ? {} : { cursor }) },
                },
              }),
            );
            const page = Schema.decodeUnknownSync(ProjectPage)(body);
            matches.push(...page.items.filter((row) => row.name === name));
            if (!page.pagination.hasMore) break;
            const next = page.pagination.nextCursor;
            if (next === undefined || next === null || seenCursors.has(next)) {
              return yield* new ConvexApiError({
                operation: "list projects",
                status: 0,
                code: "InvalidPagination",
                message: `The project listing of team ${teamId} reports more pages but gives no new cursor. Convex.Project stops so that it does not miss a project named "${name}".`,
              });
            }
            seenCursors.add(next);
            cursor = next;
          }
          if (matches.length > 1) {
            return yield* new AmbiguousProject({
              teamId,
              name,
              projectIds: matches.map((row) => row.id),
            });
          }
          return matches[0];
        });

      /**
       * Brings an existing project to the desired name. The team cannot
       * change, so a project in another team fails.
       */
      const converge = (details: ProjectDetails, teamId: number, name: string) =>
        Effect.gen(function* () {
          if (details.teamId !== teamId) {
            return yield* new ProjectTeamChange({
              projectId: details.id,
              teamId: details.teamId,
              requestedTeamId: teamId,
            });
          }
          if (details.name === name) return yield* attributesOf(details);
          const updated = yield* api.request("update project", (client) =>
            client.PATCH("/projects/{project_id}", {
              params: { path: { project_id: details.id } },
              body: { name },
            }),
          );
          return yield* attributesOf(Schema.decodeUnknownSync(ProjectDetails)(updated));
        });

      return {
        stables: ["projectId", "slug", "teamId"],

        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          // Nothing exists yet, so nothing can be lost.
          if (output === undefined) return undefined;
          yield* checkCreateTimeProps(output.projectId, olds, news);
          if (olds.team !== news.team) {
            const requestedTeamId = yield* api.resolveTeamId(news.team);
            if (requestedTeamId !== output.teamId) {
              return yield* new ProjectTeamChange({
                projectId: output.projectId,
                teamId: output.teamId,
                requestedTeamId,
              });
            }
          }
          // Never "replace". A name change is an update; reconcile renames
          // the project with PATCH. Otherwise the engine compares the props.
          return olds.name === news.name ? undefined : ({ action: "update" } as const);
        }),

        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const details = yield* getById(output.projectId);
            return details === undefined ? undefined : yield* attributesOf(details);
          }
          // No state: an existing project with this name belongs to someone
          // else until the user passes --adopt. Convex has no ownership tags.
          const existing = yield* findByName(yield* api.resolveTeamId(olds.team), olds.name);
          return existing === undefined ? undefined : Unowned(yield* attributesOf(existing));
        }),

        reconcile: Effect.fn(function* ({ fqn, olds, news, output }) {
          const teamId = yield* api.resolveTeamId(news.team);
          if (output !== undefined) {
            // State names the project. Never look it up by name here.
            if (olds !== undefined) yield* checkCreateTimeProps(output.projectId, olds, news);
            if (output.teamId !== teamId) {
              return yield* new ProjectTeamChange({
                projectId: output.projectId,
                teamId: output.teamId,
                requestedTeamId: teamId,
              });
            }
            const details = yield* getById(output.projectId);
            if (details !== undefined) return yield* converge(details, teamId, news.name);
            // The project in state was deleted outside Alchemy. Creating a
            // new project below loses nothing.
          } else {
            // No state: a project with this name is someone else's unless
            // adoption is on. The engine checked this in plan; this check
            // covers a project that appeared after the plan.
            const existing = yield* findByName(teamId, news.name);
            if (existing !== undefined) {
              if (!(yield* shouldAdopt(fqn))) {
                return yield* new OwnedBySomeoneElse({
                  message: `Convex project ${existing.id} in team ${teamId} already has the name "${news.name}". Re-run with --adopt to take it over, or use a different name.`,
                  resourceType: Project.Type,
                  physicalName: news.name,
                });
              }
              return yield* converge(existing, teamId, news.name);
            }
          }
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
          // Identity comes from the create response, never from a name lookup.
          const { projectId } = Schema.decodeUnknownSync(CreatedProject)(created);
          const details = yield* getById(projectId);
          if (details === undefined) return yield* new CreatedProjectNotFound({ projectId });
          return yield* converge(details, teamId, news.name);
        }),

        // Runs only with `RemovalPolicy.destroy()`: the default policy is `retain`.
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
