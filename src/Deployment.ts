// Convex.Deployment: one deployment of a Convex project, with the URLs that a
// frontend or a Worker needs.
//
// - `prod` is the project's default production deployment. Convex creates it
//   with the project, so this resource never creates one. It takes the
//   deployment over without --adopt: it never changes or deletes a production
//   deployment, so the takeover cannot lose data. It follows the default:
//   when another production deployment becomes the default, the next deploy
//   outputs that one. To delete a production deployment, delete its project
//   (Convex.Project with RemovalPolicy.destroy()). Delete reads the live type
//   first, so a dev or preview deployment that became a production
//   deployment is not deleted either.
// - `dev` and `preview` are created with POST
//   /projects/{project_id}/create_deployment and the `name` prop as the
//   reference. Convex keeps a dev reference as given. For a preview, Convex
//   records `name` as the preview identifier, the name that
//   `npx convex deploy --preview-name <name>` finds, and derives the reference
//   from it (`preview/<slug>`). A create for a preview name that already has
//   a preview deployment deletes that deployment and creates a new one, so
//   reconcile always looks the name up first and never creates over an
//   existing deployment. A dev or preview deployment that exists but is not
//   in state belongs to someone else: the resource takes it over only with
//   --adopt.
// - `projectId`, `type`, and `name` are the identity. A change fails with
//   DeploymentIdentityChange; the resource is never replaced.
// - The removal policy is `retain` for every type. A preview deployment
//   expires on Convex's schedule (14 days by default). To delete a dev or
//   preview deployment with the resource, add RemovalPolicy.destroy().
//
// Patterns from Confect `packages/alchemy/src/Deployment.ts`
// (https://github.com/rjdellecese/confect, ISC license).
import { Resource } from "alchemy";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { shouldAdopt } from "./Adoption.ts";
import { absentAsUndefined, ManagementApi, retryIdempotentWrite } from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

export type DeploymentProps =
  | {
      /** Numeric project id, such as `project.projectId`. Cannot change. */
      readonly projectId: number;
      /** The project's default production deployment. Cannot change. */
      readonly type: "prod";
    }
  | {
      /** Numeric project id, such as `project.projectId`. Cannot change. */
      readonly projectId: number;
      /** A dev deployment or a preview deployment that this resource creates. Cannot change. */
      readonly type: "dev" | "preview";
      /**
       * The dev reference, such as `staging`, or the preview name, such as a
       * pull request or stage name. Unique in the project. Cannot change.
       */
      readonly name: string;
    };

export interface DeploymentAttributes {
  readonly projectId: number;
  readonly type: DeploymentProps["type"];
  /** Deployment name, such as `happy-animal-123`. */
  readonly name: string;
  /** The reference that Convex lists, such as `production`, `staging`, or `preview/pr-42`. */
  readonly reference: string;
  /** The preview name of a preview deployment. Undefined for prod and dev. */
  readonly previewName: string | undefined;
  /** Client URL, such as `https://happy-animal-123.convex.cloud`. */
  readonly url: string;
  /** HTTP actions URL, such as `https://happy-animal-123.convex.site`. */
  readonly siteUrl: string;
}

export type Deployment = Resource<
  "Convex.Deployment",
  DeploymentProps,
  DeploymentAttributes,
  never,
  Providers
>;
export const Deployment = Resource<Deployment>("Convex.Deployment", {
  defaultRemovalPolicy: "retain",
});

/** The props name another deployment than the one in state. */
export class DeploymentIdentityChange extends Schema.TaggedError<DeploymentIdentityChange>()(
  "DeploymentIdentityChange",
  {
    /** Name of the deployment in state, such as `happy-animal-123`. */
    deployment: Schema.String,
    field: Schema.Literals(["projectId", "type", "name"]),
    current: Schema.String,
    requested: Schema.String,
  },
) {
  override get message() {
    return `Convex.Deployment cannot change the ${this.field} of deployment ${this.deployment} from ${this.current} to ${this.requested}. Set ${this.field} back to ${this.current}. For another deployment, create a new resource with a new logical id.`;
  }
}

/** The project has no default production deployment for a `prod` resource to take over. */
export class ProductionDeploymentNotFound extends Schema.TaggedError<ProductionDeploymentNotFound>()(
  "ProductionDeploymentNotFound",
  { projectId: Schema.Number },
) {
  override get message() {
    return `Project ${this.projectId} has no default production deployment, and Convex.Deployment does not create one. Create it in the Convex dashboard, or with \`npx convex deployment create --type prod --default\` in the project, then run the deploy again.`;
  }
}

/** More than one deployment of the project has the name, so the lookup cannot choose one. */
export class AmbiguousDeployment extends Schema.TaggedError<AmbiguousDeployment>()(
  "AmbiguousDeployment",
  {
    projectId: Schema.Number,
    type: Schema.Literals(["dev", "preview"]),
    name: Schema.String,
    deployments: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `Project ${this.projectId} has ${this.deployments.length} ${this.type} deployments named "${this.name}" (${this.deployments.join(", ")}). Convex.Deployment does not choose one. Delete the extra deployments in the Convex dashboard, or use another name.`;
  }
}

/**
 * The URL of a Convex cloud deployment: `https://<name>.convex.cloud`, or
 * `https://<name>.<region>.convex.cloud` outside US East.
 */
const CLOUD_URL =
  /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.convex\.cloud$/;

/**
 * The HTTP actions URL of a deployment: the client URL with `.convex.site`
 * for `.convex.cloud`, as Convex sets CONVEX_SITE_URL. Custom domains are
 * not covered.
 */
export const siteUrlOf = (url: string): string => url.replace(/\.convex\.cloud$/, ".convex.site");

/** One row of list_deployments, GET /deployments/{name}, and create_deployment. Only the fields the provider uses. */
export const DeploymentRow = Schema.Struct({
  name: Schema.String,
  projectId: Schema.Number,
  deploymentType: Schema.String,
  isDefault: Schema.Boolean,
  reference: Schema.String,
  /** Set in list_deployments and create_deployment rows only: GET /deployments/{name} answers null. */
  previewIdentifier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  deploymentUrl: Schema.String.check(Schema.isPattern(CLOUD_URL)),
});
type DeploymentRow = typeof DeploymentRow.Type;
const DeploymentRows = Schema.Array(DeploymentRow);

const attributesOf = (
  row: DeploymentRow,
  type: DeploymentProps["type"],
  previewName: string | undefined,
): DeploymentAttributes => ({
  projectId: row.projectId,
  type,
  name: row.name,
  reference: row.reference,
  previewName: type === "preview" ? previewName : undefined,
  url: row.deploymentUrl,
  siteUrl: siteUrlOf(row.deploymentUrl),
});

/** The `name` prop of the deployment in state: the dev reference or the preview name. */
const nameOf = (attributes: DeploymentAttributes) =>
  attributes.type === "dev"
    ? attributes.reference
    : attributes.type === "preview"
      ? attributes.previewName
      : undefined;

/**
 * Fails with {@link DeploymentIdentityChange} when the props name another
 * deployment than `current`: the attributes in state, or a live row.
 */
const checkIdentity = (current: DeploymentAttributes, news: DeploymentProps) => {
  const change = (field: "projectId" | "type" | "name", from: string, to: string) =>
    Effect.fail(
      new DeploymentIdentityChange({
        deployment: current.name,
        field,
        current: from,
        requested: to,
      }),
    );
  if (current.projectId !== news.projectId) {
    return change("projectId", String(current.projectId), String(news.projectId));
  }
  if (current.type !== news.type) return change("type", current.type, news.type);
  const currentName = nameOf(current);
  if (news.type !== "prod" && currentName !== news.name) {
    return change("name", currentName ?? "(none)", news.name);
  }
  return Effect.void;
};

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const api = yield* ManagementApi;

      /** The live deployment, or undefined after a 404. GET /deployments/{name} answers no preview identifier. */
      const getByName = (name: string) =>
        absentAsUndefined(
          api.request("get deployment", (client) =>
            client.GET("/deployments/{deployment_name}", {
              params: { path: { deployment_name: name } },
            }),
          ),
        ).pipe(
          Effect.map((body) =>
            body === undefined ? undefined : Schema.decodeUnknownSync(DeploymentRow)(body),
          ),
        );

      const listDeployments = (
        projectId: number,
        type: DeploymentProps["type"],
        isDefault?: boolean,
      ) =>
        api
          .request("list deployments", (client) =>
            client.GET("/projects/{project_id}/list_deployments", {
              params: {
                path: { project_id: projectId },
                query: { deploymentType: type, ...(isDefault === undefined ? {} : { isDefault }) },
              },
            }),
          )
          .pipe(Effect.map((body) => Schema.decodeUnknownSync(DeploymentRows)(body)));

      /** The project's default production deployment, or undefined. */
      const production = (projectId: number) =>
        listDeployments(projectId, "prod", true).pipe(
          Effect.map((rows) => {
            const row = rows.find(
              (candidate) => candidate.deploymentType === "prod" && candidate.isDefault,
            );
            return row === undefined ? undefined : attributesOf(row, "prod", undefined);
          }),
        );

      /**
       * The one dev deployment with this reference, or the one preview
       * deployment with this preview name, or undefined.
       */
      const findByName = (projectId: number, type: "dev" | "preview", name: string) =>
        Effect.gen(function* () {
          const matches = (yield* listDeployments(projectId, type)).filter(
            (row) =>
              row.deploymentType === type &&
              (type === "dev" ? row.reference === name : row.previewIdentifier === name),
          );
          if (matches.length > 1) {
            return yield* new AmbiguousDeployment({
              projectId,
              type,
              name,
              deployments: matches.map((row) => row.name),
            });
          }
          return matches[0];
        });

      /** The deployment that the props name, for a resource without state. */
      const lookup = (news: DeploymentProps) =>
        news.type === "prod"
          ? production(news.projectId)
          : findByName(news.projectId, news.type, news.name).pipe(
              Effect.map((row) =>
                row === undefined ? undefined : attributesOf(row, news.type, news.name),
              ),
            );

      return {
        // `name`, `reference`, and the URLs change when an expired preview is
        // created again, or when another production deployment becomes the
        // default.
        stables: ["projectId", "type", "previewName"],

        // Compares with the attributes: after a refused change, `olds` are
        // the refused props.
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          yield* checkIdentity(output, news);
          // `prod` follows the project's default production deployment,
          // which can change in Convex. Reconcile then returns the new one.
          if (news.type === "prod") {
            // A 404 for a deleted project plans an update; reconcile then reports it.
            const current = yield* absentAsUndefined(production(news.projectId));
            return current?.name === output.name ? undefined : ({ action: "update" } as const);
          }
          // A preview expires, and anyone can delete a deployment. Reconcile
          // then finds or creates it again, so the stack never hands out the
          // URL of a deployment that is gone.
          const live = yield* getByName(output.name);
          return live === undefined ? ({ action: "update" } as const) : undefined;
        }),

        read: Effect.fn(function* ({ olds, output }) {
          if (output?.type === "prod") {
            // 404: the project is gone, and so is its production deployment.
            return yield* absentAsUndefined(production(output.projectId));
          }
          if (output !== undefined) {
            const live = yield* getByName(output.name);
            return live === undefined
              ? undefined
              : attributesOf(live, output.type, output.previewName);
          }
          const found = yield* lookup(olds);
          if (found === undefined) return undefined;
          // The production deployment comes with the project, and this
          // resource never changes or deletes it, so it is ours to read.
          // A dev or preview deployment that is not in state is someone
          // else's until the user passes --adopt.
          return olds.type === "prod" ? found : Unowned(found);
        }),

        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          // Also here: with an unresolved prop in plan, diff could not check.
          if (output !== undefined) yield* checkIdentity(output, news);
          if (news.type === "prod") {
            // Always the current default, also when another production
            // deployment became the default after the last deploy.
            const current = yield* production(news.projectId);
            if (current === undefined) {
              return yield* new ProductionDeploymentNotFound({ projectId: news.projectId });
            }
            return current;
          }
          if (output !== undefined) {
            const live = yield* getByName(output.name);
            if (live !== undefined) {
              if (live.deploymentType !== output.type) {
                return yield* new DeploymentIdentityChange({
                  deployment: live.name,
                  field: "type",
                  current: live.deploymentType,
                  requested: news.type,
                });
              }
              const current = attributesOf(live, output.type, output.previewName);
              // The live deployment can have moved to another project.
              yield* checkIdentity(current, news);
              return current;
            }
            // The deployment in state is gone, such as an expired preview.
            // Find or create it below like a resource without state.
          }
          // Never create over an existing deployment: a preview create
          // replaces the preview deployment with the same name. Another
          // writer can still create one between this lookup and the create.
          const existing = yield* lookup(news);
          if (existing !== undefined) {
            if (!(yield* shouldAdopt(fqn))) {
              return yield* new OwnedBySomeoneElse({
                message: `Project ${news.projectId} already has ${news.type} deployment ${existing.name} named "${news.name}". Re-run with --adopt to take it over, or use another name.`,
                resourceType: Deployment.Type,
                physicalName: existing.name,
              });
            }
            return existing;
          }
          const created = yield* api.request("create deployment", (client) =>
            client.POST("/projects/{project_id}/create_deployment", {
              params: { path: { project_id: news.projectId } },
              body: { type: news.type, reference: news.name },
            }),
          );
          return attributesOf(
            Schema.decodeUnknownSync(DeploymentRow)(created),
            news.type,
            news.name,
          );
        }),

        // Runs only with RemovalPolicy.destroy(): the default policy is `retain`.
        delete: Effect.fn(function* ({ output }) {
          const keep = Effect.logWarning(
            `Convex.Deployment does not delete production deployment ${output.name}: it belongs to project ${output.projectId}. To delete it, delete the project with RemovalPolicy.destroy() on Convex.Project.`,
          );
          if (output.type === "prod") return yield* keep;
          // The type in state can be old: a dev or preview deployment can
          // become a production deployment in Convex. The live type decides.
          const live = yield* getByName(output.name);
          // 404: an earlier attempt, the expiry, or someone else deleted it.
          if (live === undefined) return;
          if (live.deploymentType === "prod") return yield* keep;
          yield* absentAsUndefined(
            retryIdempotentWrite(
              api.requestVoid("delete deployment", (client) =>
                client.POST("/deployments/{deployment_name}/delete", {
                  params: { path: { deployment_name: output.name } },
                }),
              ),
            ),
          );
        }),
      };
    }),
  );
