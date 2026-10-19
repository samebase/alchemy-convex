// Convex.Deployment: one deployment of a Convex project, its environment
// variables, and its functions, with the URLs that a frontend or a Worker
// needs. This is the Convex plane of a stack: no deploy key leaves it.
//
// - `source` is the Convex functions directory, such as `./convex`. The
//   update pushes it with the Convex CLI that the app installed (Push.ts).
//   The content identity of the push is a hash of the source files, the
//   app's package.json, convex.json, and lockfile, the deployment name, and
//   `env`. The same hash is a no-op. The hash is taken again after the push,
//   so files that `convex deploy` generates are part of it.
// - `env` is set on the deployment before the push. A name that leaves `env`
//   is removed. A variable that exists with another value and that this
//   resource did not set is someone else's: it is overwritten only with
//   --adopt. Delete leaves the variables: they go with the deployment.
// - Credentials by scope (see Access below): a deploy key of the deployment,
//   a preview deploy key of the project, or the Management API token.
// - `prod` is the project's default production deployment. Convex creates it
//   with the project, so this resource never creates one. It takes the
//   deployment over without --adopt: it never changes or deletes a production
//   deployment, so the takeover cannot lose data. It follows the default:
//   when another production deployment becomes the default, the next deploy
//   outputs that one. With a deploy key, `prod` is the production deployment
//   of that key. To delete a production deployment, delete its project
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
// (https://github.com/rjdellecese/confect, ISC license, see NOTICE).
import { Resource } from "alchemy";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { shouldAdopt } from "./Adoption.ts";
import { Credentials } from "./Credentials.ts";
import {
  absentAsUndefined,
  type ConvexApiError,
  ManagementApi,
  type ManagementApiService,
  retryIdempotentWrite,
} from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";
import {
  EnvironmentNeedsDeployKey,
  type EnvValue,
  keyTargetOf,
  push,
  pushHash,
  withPushKey,
} from "./Push.ts";

interface DeploymentInputs {
  /** The project: a Convex.Project resource, or `{ projectId }`. Cannot change. */
  readonly project: { readonly projectId: number };
  /**
   * The Convex functions directory, such as `./convex`. The CLI runs in the
   * nearest directory above it with a package.json. Without `source`, the
   * resource pushes nothing.
   */
  readonly source?: string;
  /** Environment variables to set on the deployment before the push. */
  readonly env?: Readonly<Record<string, EnvValue>>;
}

export type DeploymentProps =
  | (DeploymentInputs & {
      /** The project's default production deployment. Cannot change. */
      readonly type: "prod";
    })
  | (DeploymentInputs & {
      /** A dev deployment or a preview deployment that this resource creates. Cannot change. */
      readonly type: "dev" | "preview";
      /**
       * The dev reference, such as `staging`, or the preview name, such as
       * the stage name. Unique in the project. Cannot change.
       */
      readonly name: string;
    });

/** The deployment itself, without the state of the push. */
interface DeploymentTarget {
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

export interface DeploymentAttributes extends DeploymentTarget {
  /** Content identity of the last push and `env`. Undefined when the resource pushed nothing. */
  readonly hash: string | undefined;
  /** The names of the `env` variables that this resource set on the deployment, sorted. */
  readonly envNames: readonly string[];
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

/** GET https://<deployment>/api/v1/deployment_info, for a cloud deployment. Only the fields the provider uses. */
const DeploymentInfo = Schema.Struct({
  kind: Schema.Literal("cloud"),
  projectId: Schema.Number,
  deploymentType: Schema.String,
  reference: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** GET https://<deployment>/api/v1/get_canonical_urls */
const CanonicalUrls = Schema.Struct({
  convexCloudUrl: Schema.String,
  convexSiteUrl: Schema.String,
});

const targetOf = (
  row: DeploymentRow,
  type: DeploymentProps["type"],
  previewName: string | undefined,
): DeploymentTarget => ({
  projectId: row.projectId,
  type,
  name: row.name,
  reference: row.reference,
  previewName: type === "preview" ? previewName : undefined,
  url: row.deploymentUrl,
  siteUrl: siteUrlOf(row.deploymentUrl),
});

/** The `name` prop of a deployment: the dev reference or the preview name. */
const nameOf = (target: DeploymentTarget) =>
  target.type === "dev"
    ? target.reference
    : target.type === "preview"
      ? target.previewName
      : undefined;

/**
 * Fails with {@link DeploymentIdentityChange} when the props name another
 * deployment than `current`: the attributes in state, or a live deployment.
 */
const checkIdentity = (current: DeploymentTarget, news: DeploymentProps) => {
  const change = (field: "projectId" | "type" | "name", from: string, to: string) =>
    Effect.fail(
      new DeploymentIdentityChange({
        deployment: current.name,
        field,
        current: from,
        requested: to,
      }),
    );
  if (current.projectId !== news.project.projectId) {
    return change("projectId", String(current.projectId), String(news.project.projectId));
  }
  if (current.type !== news.type) return change("type", current.type, news.type);
  const currentName = nameOf(current);
  if (news.type !== "prod" && currentName !== news.name) {
    return change("name", currentName ?? "(none)", news.name);
  }
  return Effect.void;
};

/** The deployment that a resource addresses: its project, type, and dev or preview name. */
interface Address {
  readonly projectId: number;
  readonly type: DeploymentProps["type"];
  readonly name: string | undefined;
}

const addressOf = (props: DeploymentProps): Address => ({
  projectId: props.project.projectId,
  type: props.type,
  name: props.type === "prod" ? undefined : props.name,
});

/** The address of the deployment in state. */
const addressInState = (output: DeploymentAttributes): Address => ({
  projectId: output.projectId,
  type: output.type,
  name: nameOf(output),
});

/**
 * How the provider reaches one deployment, by the narrowest credential that
 * fits:
 *
 * - `deployKey`: the configured deploy key belongs to this deployment. The
 *   deployment API answers its identity and URLs, the key sets variables and
 *   pushes, and no Management API call is made.
 * - `previewKey`: the configured preview deploy key belongs to this project.
 *   The Management API takes it for the preview deployments of the project,
 *   and the CLI pushes with it and `--preview-name`.
 * - `token`: the Management API access token. Each push gets a short-lived
 *   deploy key (Push.ts).
 */
type Access =
  | {
      readonly kind: "deployKey";
      readonly key: Redacted.Redacted<string>;
      readonly target: DeploymentTarget;
    }
  | {
      readonly kind: "previewKey";
      readonly key: Redacted.Redacted<string>;
      readonly api: ManagementApiService;
    }
  | { readonly kind: "token"; readonly api: ManagementApiService };

const ProjectSlugs = Schema.Struct({ slug: Schema.String, teamSlug: Schema.String });

/** True for an answer that says this credential cannot read the object. */
const isRefused = (error: ConvexApiError) =>
  error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404;

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const api = yield* ManagementApi;
      const credentials = yield* Credentials;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** The live deployment, or undefined after a 404. GET /deployments/{name} answers no preview identifier. */
      const getByName = (management: ManagementApiService, name: string) =>
        absentAsUndefined(
          management.request("get deployment", (client) =>
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
        management: ManagementApiService,
        projectId: number,
        type: DeploymentProps["type"],
        isDefault?: boolean,
      ) =>
        management
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
      const production = (management: ManagementApiService, projectId: number) =>
        listDeployments(management, projectId, "prod", true).pipe(
          Effect.map((rows) => {
            const row = rows.find(
              (candidate) => candidate.deploymentType === "prod" && candidate.isDefault,
            );
            return row === undefined ? undefined : targetOf(row, "prod", undefined);
          }),
        );

      /**
       * The one dev deployment with this reference, or the one preview
       * deployment with this preview name, or undefined.
       */
      const findByName = (
        management: ManagementApiService,
        projectId: number,
        type: "dev" | "preview",
        name: string,
      ) =>
        Effect.gen(function* () {
          const matches = (yield* listDeployments(management, projectId, type)).filter(
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

      /** The deployment that the address names, through the Management API, or undefined. */
      const lookup = (management: ManagementApiService, address: Address) =>
        address.type === "prod" || address.name === undefined
          ? production(management, address.projectId)
          : findByName(management, address.projectId, address.type, address.name).pipe(
              Effect.map((row) =>
                row === undefined ? undefined : targetOf(row, address.type, address.name),
              ),
            );

      /** The deployment of a deploy key, when it is the deployment that the address names. */
      const deployKeyTarget = (
        key: Redacted.Redacted<string>,
        deployment: string,
        address: Address,
      ) =>
        Effect.gen(function* () {
          const info = Schema.decodeUnknownSync(DeploymentInfo)(
            yield* api.deploymentRequest("get deployment info", deployment, key, (client) =>
              client.GET("/deployment_info"),
            ),
          );
          const reference = info.reference ?? "";
          if (
            info.projectId !== address.projectId ||
            info.deploymentType !== address.type ||
            (address.type === "dev" && reference !== address.name)
          ) {
            return undefined;
          }
          const urls = Schema.decodeUnknownSync(CanonicalUrls)(
            yield* api.deploymentRequest("get canonical urls", deployment, key, (client) =>
              client.GET("/get_canonical_urls"),
            ),
          );
          return {
            projectId: info.projectId,
            type: address.type,
            name: deployment,
            reference,
            previewName: undefined,
            url: urls.convexCloudUrl,
            siteUrl: urls.convexSiteUrl,
          } satisfies DeploymentTarget;
        }).pipe(Effect.catchIf(isRefused, () => Effect.succeed(undefined)));

      /** True when the preview deploy key belongs to the project. */
      const previewKeyFits = (
        management: ManagementApiService,
        slugs: { readonly team: string; readonly project: string },
        projectId: number,
      ) =>
        management
          .request("get project", (client) =>
            client.GET("/projects/{project_id}", { params: { path: { project_id: projectId } } }),
          )
          .pipe(
            Effect.map((body) => {
              const project = Schema.decodeUnknownSync(ProjectSlugs)(body);
              return project.slug === slugs.project && project.teamSlug === slugs.team;
            }),
            Effect.catchIf(isRefused, () => Effect.succeed(false)),
          );

      /** The narrowest credential that reaches the deployment. See {@link Access}. */
      const accessFor = (address: Address) =>
        Effect.gen(function* (): Effect.fn.Return<Access, ConvexApiError> {
          const key = yield* credentials.deployKey;
          if (key !== undefined) {
            const target = keyTargetOf(Redacted.value(key));
            if (target.kind === "deployment" && address.type !== "preview") {
              const found = yield* deployKeyTarget(key, target.deployment, address);
              if (found !== undefined) return { kind: "deployKey", key, target: found };
            }
            if (target.kind === "preview" && address.type === "preview") {
              const scoped = api.withToken(key);
              if (yield* previewKeyFits(scoped, target, address.projectId)) {
                return { kind: "previewKey", key, api: scoped };
              }
            }
          }
          return { kind: "token", api };
        });

      /** The live deployment of a resource in state, or undefined when it is gone. */
      const live = (access: Access, output: DeploymentAttributes) =>
        Effect.gen(function* () {
          if (access.kind === "deployKey") return access.target;
          // 404 for a deleted project: its production deployment is gone too.
          if (output.type === "prod")
            return yield* absentAsUndefined(production(access.api, output.projectId));
          const row = yield* getByName(access.api, output.name);
          return row === undefined ? undefined : targetOf(row, output.type, output.previewName);
        });

      /** The content identity of `source` and `env` on a deployment, or undefined when there is nothing to push. */
      const wantedHash = (news: DeploymentProps, deployment: string) =>
        news.source === undefined && Object.keys(news.env ?? {}).length === 0
          ? Effect.succeed(undefined)
          : pushHash({ source: news.source, deployment, env: news.env ?? {} });

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
          const access = yield* accessFor(addressOf(news));
          // A preview expires, anyone can delete a deployment, and another
          // production deployment can become the default. Reconcile then
          // finds or creates the right one, so the stack never hands out the
          // URL of a deployment that is gone.
          const current = yield* live(access, output);
          if (current?.name !== output.name) return { action: "update" } as const;
          const hash = yield* wantedHash(news, output.name);
          return hash === output.hash
            ? ({ action: "noop" } as const)
            : ({ action: "update" } as const);
        }),

        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const access = yield* accessFor(addressInState(output));
            const current = yield* live(access, output);
            return current === undefined ? undefined : { ...output, ...current };
          }
          const address = addressOf(olds);
          const access = yield* accessFor(address);
          const found =
            access.kind === "deployKey" ? access.target : yield* lookup(access.api, address);
          if (found === undefined) return undefined;
          const attributes: DeploymentAttributes = { ...found, hash: undefined, envNames: [] };
          // The production deployment comes with the project, and this
          // resource never changes or deletes it, so it is ours to read.
          // A dev or preview deployment that is not in state is someone
          // else's until the user passes --adopt.
          return olds.type === "prod" ? attributes : Unowned(attributes);
        }),

        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          // Also here: with an unresolved prop in plan, diff could not check.
          if (output !== undefined) yield* checkIdentity(output, news);
          const address = addressOf(news);
          const access = yield* accessFor(address);
          const env = news.env ?? {};

          // 1. The deployment.
          const target: DeploymentTarget = yield* Effect.gen(function* () {
            if (access.kind === "deployKey") return access.target;
            if (news.type === "prod") {
              // Always the current default, also when another production
              // deployment became the default after the last deploy.
              const current = yield* production(access.api, address.projectId);
              if (current === undefined) {
                return yield* new ProductionDeploymentNotFound({ projectId: address.projectId });
              }
              return current;
            }
            if (output !== undefined) {
              const row = yield* getByName(access.api, output.name);
              if (row !== undefined) {
                if (row.deploymentType !== output.type) {
                  return yield* new DeploymentIdentityChange({
                    deployment: row.name,
                    field: "type",
                    current: row.deploymentType,
                    requested: news.type,
                  });
                }
                const current = targetOf(row, output.type, output.previewName);
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
            const existing = yield* lookup(access.api, address);
            if (existing !== undefined) {
              if (!(yield* shouldAdopt(fqn))) {
                return yield* new OwnedBySomeoneElse({
                  message: `Project ${address.projectId} already has ${news.type} deployment ${existing.name} named "${news.name}". Re-run with --adopt to take it over, or use another name.`,
                  resourceType: Deployment.Type,
                  physicalName: existing.name,
                });
              }
              return existing;
            }
            const created = yield* access.api.request("create deployment", (client) =>
              client.POST("/projects/{project_id}/create_deployment", {
                params: { path: { project_id: address.projectId } },
                body: { type: news.type, reference: news.name },
              }),
            );
            return targetOf(Schema.decodeUnknownSync(DeploymentRow)(created), news.type, news.name);
          });

          // 2. The variables and the push, only when their content changed.
          // Variables set on another deployment stay there: they are not ours
          // on this one.
          const previousEnvNames = output?.name === target.name ? output.envNames : [];
          const before = yield* wantedHash(news, target.name);
          if (before === undefined && previousEnvNames.length === 0) {
            return { ...target, hash: undefined, envNames: [] };
          }
          if (output?.name === target.name && before === output.hash) {
            return { ...target, hash: output.hash, envNames: output.envNames };
          }
          const options = {
            deployment: target.name,
            url: target.url,
            source: news.source,
            env,
            previousEnvNames,
            adopt: yield* shouldAdopt(fqn),
          };
          switch (access.kind) {
            case "deployKey":
              yield* push(spawner, access.key, { ...options, previewName: undefined });
              break;
            case "previewKey":
              if (Object.keys(env).length > 0 || previousEnvNames.length > 0) {
                return yield* new EnvironmentNeedsDeployKey({ deployment: target.name });
              }
              yield* push(spawner, access.key, { ...options, previewName: target.previewName });
              break;
            case "token":
              yield* withPushKey(access.api, target.name, (key) =>
                push(spawner, key, { ...options, previewName: undefined }),
              );
              break;
            default:
              return access satisfies never;
          }
          // Taken again after the push, so that files the CLI generates,
          // such as convex/_generated, are part of the identity.
          return {
            ...target,
            hash: yield* wantedHash(news, target.name),
            envNames: Object.keys(env).sort(),
          };
        }),

        // Runs only with RemovalPolicy.destroy(): the default policy is
        // `retain`. The variables go with the deployment.
        delete: Effect.fn(function* ({ output }) {
          const keep = Effect.logWarning(
            `Convex.Deployment does not delete production deployment ${output.name}: it belongs to project ${output.projectId}. To delete it, delete the project with RemovalPolicy.destroy() on Convex.Project.`,
          );
          if (output.type === "prod") return yield* keep;
          const access = yield* accessFor(addressInState(output));
          // A deploy key cannot delete its deployment.
          const management = access.kind === "deployKey" ? api : access.api;
          // The type in state can be old: a dev or preview deployment can
          // become a production deployment in Convex. The live type decides.
          const row = yield* getByName(management, output.name);
          // 404: an earlier attempt, the expiry, or someone else deleted it.
          if (row === undefined) return;
          if (row.deploymentType === "prod") return yield* keep;
          yield* absentAsUndefined(
            retryIdempotentWrite(
              management.requestVoid("delete deployment", (client) =>
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
