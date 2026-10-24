// Convex.Deployment: one deployment of a Convex project, its environment
// variables, and its functions, with the URLs that a frontend or a Worker
// needs. This is the Convex plane of a stack: no deploy key leaves it.
//
// - `rootDir` is the app directory, relative to the directory where the
//   deploy runs (the directory of the stack file), such as `apps/web`, and
//   "." by default. The push runs in it, and `source` is relative to it.
//   The constructor writes it into the props, "." included, so that a reader
//   of the state row finds the app directory of every deployment.
// - `source` is the Convex functions directory relative to `rootDir`, such
//   as `./convex`. The update pushes it with the Convex CLI that the app
//   installed (Push.ts).
//   The content identity of the push is a hash of the source files, the
//   app's package.json, convex.json, and lockfile, the deployment name, and
//   `env`. The same hash is a no-op. The hash is taken again after the push,
//   so files that `convex deploy` generates are part of it.
//   `source.command` replaces `convex deploy`, such as `convex-hosting
//   deploy`, and `source.include` adds the files that it reads to the hash.
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
import { posix, win32 } from "node:path";
import { Resource } from "alchemy";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { diffBindings, isResolved } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { shouldAdopt } from "./Adoption.ts";
import { Credentials } from "./Credentials.ts";
import type { ComponentBinding } from "./Component.ts";
import {
  absentAsUndefined,
  type ConvexApiError,
  ManagementApi,
  type ManagementApiService,
  retryIdempotentWrite,
} from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";
import {
  checkSource,
  EnvironmentNeedsDeployKey,
  type EnvValue,
  keyTargetOf,
  push,
  PUSH_KEY_ACTIONS,
  pushHash,
  type Source,
  withPushKey,
} from "./Push.ts";

interface DeploymentInputs {
  /** The project: a Convex.Project resource, or `{ projectId }`. Cannot change. */
  readonly project: { readonly projectId: number };
  /**
   * The app directory, relative to the directory where the deploy runs (the
   * directory of the stack file), such as `apps/web`. Default ".". It must
   * have a package.json. The push runs in it, and `source` is relative to
   * it. State from 0.7 has no `rootDir`.
   */
  readonly rootDir?: string;
  /**
   * The Convex functions directory relative to `rootDir`, such as
   * `./convex`, or that directory with a push command and more hashed
   * files. Without `source`, the resource pushes nothing.
   */
  readonly source?: Source;
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
  ComponentBinding,
  Providers
>;
/** The resource class. Stacks call {@link Deployment}, which writes `rootDir` into the props. */
export const DeploymentResource = Resource<Deployment>("Convex.Deployment", {
  defaultRemovalPolicy: "retain",
});

/** The props of a `Convex.Deployment` call: Alchemy inputs, with `rootDir` a plain string. */
export type DeploymentInput = DeploymentProps extends infer P
  ? P extends DeploymentProps
    ? InputProps<P, "rootDir">
    : never
  : never;

/** `rootDir` in POSIX form, without "./" and a trailing slash, such as `apps/web` or ".". */
const normalizeRootDir = (rootDir: string) => {
  const normalized = posix.normalize(rootDir.replaceAll("\\", "/"));
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
};

/** `rootDir` is an absolute path. The declaration stops with it as a defect, before the plan. */
export class AbsoluteRootDir extends Schema.TaggedError<AbsoluteRootDir>()("AbsoluteRootDir", {
  rootDir: Schema.String,
}) {
  override get message() {
    return `Convex.Deployment rootDir ${this.rootDir} is an absolute path. State keeps rootDir for every machine that runs the stack, so set it relative to the directory where the deploy runs, such as "apps/web".`;
  }
}

/**
 * `Convex.Deployment("id", props)`. The props go to state with `rootDir` in
 * POSIX form, and with "." when it is not set, so that every row names the
 * app directory of its deployment. An absolute `rootDir` stops the
 * declaration, so it never reaches the plan or state. The check dies,
 * because the program of `Alchemy.Stack` can fail only with a ConfigError.
 * `win32.isAbsolute` also answers true for a POSIX absolute path. The other
 * fields keep it usable where Alchemy takes a resource class, such as
 * `Provider.collection`.
 */
export const Deployment = Object.assign(
  (id: string, props: DeploymentInput) => {
    const rootDir = props.rootDir ?? ".";
    return win32.isAbsolute(rootDir)
      ? Effect.die(new AbsoluteRootDir({ rootDir }))
      : DeploymentResource(id, { ...props, rootDir: normalizeRootDir(rootDir) });
  },
  {
    Type: DeploymentResource.Type,
    Props: DeploymentResource.Props,
    Self: DeploymentResource.Self,
    Provider: DeploymentResource.Provider,
    Aliases: DeploymentResource.Aliases,
    ref: (id: string, options?: { stage?: string; stack?: string }) =>
      DeploymentResource.ref(id, options),
  },
);

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
  /** Absent or null until the first push: list_deployments leaves it out for a new deployment. */
  lastDeployTime: Schema.optionalKey(Schema.NullOr(Schema.Number)),
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

/** True when the deployment has received a push. */
const isDeployed = (row: DeploymentRow) =>
  row.lastDeployTime !== undefined && row.lastDeployTime !== null;

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

/** True when an update writes or removes variables: `env` has names, or state has names to remove. */
const changesEnv = (news: DeploymentProps, output: DeploymentAttributes | undefined) =>
  Object.keys(news.env ?? {}).length > 0 || envNamesOf(output).length > 0;

/** The `env` names in state. State from 0.3 has none. */
const envNamesOf = (output: DeploymentAttributes | undefined): readonly string[] =>
  output?.envNames ?? [];

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
    DeploymentResource,
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

      /** The row of the project's default production deployment, or undefined. */
      const productionRow = (management: ManagementApiService, projectId: number) =>
        listDeployments(management, projectId, "prod", true).pipe(
          Effect.map((rows) =>
            rows.find((candidate) => candidate.deploymentType === "prod" && candidate.isDefault),
          ),
        );

      /** The project's default production deployment, or undefined. */
      const production = (management: ManagementApiService, projectId: number) =>
        productionRow(management, projectId).pipe(
          Effect.map((row) => (row === undefined ? undefined : targetOf(row, "prod", undefined))),
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

      /**
       * The narrowest credential that reaches the deployment. See {@link Access}.
       * When `changesEnv`, a preview deploy key gives way to the access token,
       * because it cannot change variables.
       */
      const accessFor = (address: Address, changesEnv: boolean) =>
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
              if (
                !(changesEnv && (yield* credentials.hasAccessToken)) &&
                (yield* previewKeyFits(scoped, target, address.projectId))
              ) {
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
      const wantedHash = (news: DeploymentProps, rootDir: string, deployment: string) =>
        news.source === undefined && Object.keys(news.env ?? {}).length === 0
          ? Effect.succeed(undefined)
          : pushHash({ rootDir, source: news.source, deployment, env: news.env ?? {} });

      return {
        // `name`, `reference`, and the URLs change when an expired preview is
        // created again, or when another production deployment becomes the
        // default.
        stables: ["projectId", "type", "previewName"],

        // Compares with the attributes: after a refused change, `olds` are
        // the refused props. Only `rootDir` compares with `olds`, because it
        // is in the props only. A refused update leaves the row `updating`,
        // and the next plan updates it again anyway.
        diff: Effect.fn(function* ({ news, olds, output, oldBindings, newBindings }) {
          if (!isResolved(news) || output === undefined) return undefined;
          yield* checkIdentity(output, news);
          if (!isResolved(newBindings)) return undefined;
          // State from 0.7 has no rootDir; the constructor always writes it.
          const rootDir = news.rootDir ?? ".";
          // Also here, so that a wrong rootDir stops the plan before Apply
          // writes the new props to the row.
          if (news.source !== undefined) yield* checkSource(rootDir, news.source);
          // State from 0.7 has no rootDir, and another rootDir is another
          // app directory. The update writes the props to state; it pushes
          // only when the hash changed.
          if (olds.rootDir !== rootDir) return { action: "update" } as const;
          const access = yield* accessFor(addressOf(news), changesEnv(news, output));
          // A preview expires, anyone can delete a deployment, and another
          // production deployment can become the default. Reconcile then
          // finds or creates the right one, so the stack never hands out the
          // URL of a deployment that is gone.
          const current = yield* live(access, output);
          if (current?.name !== output.name) return { action: "update" } as const;
          const hash = yield* wantedHash(news, rootDir, output.name);
          if (hash !== output.hash) return { action: "update" } as const;
          if (diffBindings(oldBindings, newBindings).every((binding) => binding.action === "noop"))
            return { action: "noop" } as const;
          // Binding metadata does not change deployment outputs. Keep unchanged
          // values available to consumers so the plan does not update them too.
          return {
            action: "update" as const,
            stables: [
              "hash",
              "envNames",
              ...(
                ["projectId", "type", "previewName", "name", "reference", "url", "siteUrl"] as const
              ).filter((key) => current[key] === output[key]),
            ],
          };
        }),

        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const access = yield* accessFor(addressInState(output), false);
            const current = yield* live(access, output);
            return current === undefined ? undefined : { ...output, ...current };
          }
          const address = addressOf(olds);
          const access = yield* accessFor(address, false);
          if (access.kind === "deployKey") {
            // The deployment API does not say whether the deployment has code.
            return Unowned({ ...access.target, hash: undefined, envNames: [] });
          }
          if (olds.type === "prod") {
            const row = yield* productionRow(access.api, address.projectId);
            if (row === undefined) return undefined;
            const attributes = {
              ...targetOf(row, "prod", undefined),
              hash: undefined,
              envNames: [],
            };
            // A production deployment that never received a push, such as
            // the one of a project that this stack created, loses nothing to
            // a push. One with code is someone else's until --adopt.
            return isDeployed(row) ? Unowned(attributes) : attributes;
          }
          const found = yield* lookup(access.api, address);
          if (found === undefined) return undefined;
          // A dev or preview deployment that is not in state is someone
          // else's until the user passes --adopt.
          return Unowned({ ...found, hash: undefined, envNames: [] });
        }),

        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          // Also here: with an unresolved prop in plan, diff could not check.
          if (output !== undefined) yield* checkIdentity(output, news);
          // The app directory, the functions directory, and the program,
          // before any change.
          const rootDir = news.rootDir ?? ".";
          if (news.source !== undefined) yield* checkSource(rootDir, news.source);
          const address = addressOf(news);
          const access = yield* accessFor(address, changesEnv(news, output));
          const env = news.env ?? {};
          // Before any create: a preview deploy key cannot change variables,
          // and accessFor chose it because there is no access token.
          if (access.kind === "previewKey" && changesEnv(news, output)) {
            return yield* new EnvironmentNeedsDeployKey({
              deployment: output?.name ?? address.name ?? "(new)",
            });
          }
          const adopt = yield* shouldAdopt(fqn);
          const refuse = (name: string) =>
            new OwnedBySomeoneElse({
              message: `Project ${address.projectId} already has ${news.type} deployment ${name}${news.type === "prod" ? " with code" : ` named "${news.name}"`}. Re-run with --adopt to take it over${news.type === "prod" ? "" : ", or use another name"}.`,
              resourceType: DeploymentResource.Type,
              physicalName: name,
            });

          // 1. The deployment. `created` is true when this reconcile created it.
          const { target, created } = yield* Effect.gen(function* () {
            if (access.kind === "deployKey") {
              // read() refused it without --adopt; this covers an apply without a plan.
              if (output === undefined && !adopt) return yield* refuse(access.target.name);
              return { target: access.target, created: false };
            }
            if (news.type === "prod") {
              // Always the current default, also when another production
              // deployment became the default after the last deploy.
              const row = yield* productionRow(access.api, address.projectId);
              if (row === undefined) {
                return yield* new ProductionDeploymentNotFound({ projectId: address.projectId });
              }
              // Code that appeared after the plan is someone else's.
              if (output === undefined && isDeployed(row) && !adopt) return yield* refuse(row.name);
              return { target: targetOf(row, "prod", undefined), created: false };
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
                return { target: current, created: false };
              }
              // The deployment in state is gone, such as an expired preview.
              // Find or create it below like a resource without state.
            }
            // Never create over an existing deployment: a preview create
            // replaces the preview deployment with the same name. Another
            // writer can still create one between this lookup and the create.
            const existing = yield* lookup(access.api, address);
            if (existing !== undefined) {
              if (!adopt) return yield* refuse(existing.name);
              return { target: existing, created: false };
            }
            const row = yield* access.api.request("create deployment", (client) =>
              client.POST("/projects/{project_id}/create_deployment", {
                params: { path: { project_id: address.projectId } },
                body: { type: news.type, reference: news.name },
              }),
            );
            return {
              target: targetOf(Schema.decodeUnknownSync(DeploymentRow)(row), news.type, news.name),
              created: true,
            };
          });

          // 2. The variables and the push, only when their content changed.
          // Variables set on another deployment stay there: they are not ours
          // on this one.
          const previousEnvNames = output?.name === target.name ? envNamesOf(output) : [];
          const before = yield* wantedHash(news, rootDir, target.name);
          if (before === undefined && previousEnvNames.length === 0) {
            return { ...target, hash: undefined, envNames: [] };
          }
          if (output?.name === target.name && before === output.hash) {
            return { ...target, hash: output.hash, envNames: previousEnvNames };
          }
          const options = {
            deployment: target.name,
            url: target.url,
            rootDir,
            source: news.source,
            env,
            previousEnvNames,
            adopt,
          };
          const pushed =
            access.kind === "deployKey"
              ? push(spawner, access.key, { ...options, previewName: undefined })
              : access.kind === "previewKey"
                ? push(spawner, access.key, { ...options, previewName: target.previewName })
                : withPushKey(
                    access.api,
                    target.name,
                    // A push command gets every action; `convex deploy` only its own.
                    typeof news.source === "object" && news.source.command !== undefined
                      ? undefined
                      : PUSH_KEY_ACTIONS,
                    (key) => push(spawner, key, { ...options, previewName: undefined }),
                  );
          yield* pushed.pipe(
            // A deployment that this reconcile created and could not push to
            // would be someone else's on the next run, and a dev deployment
            // never expires. It is new and empty, so it goes.
            Effect.onError(() =>
              created && access.kind !== "deployKey"
                ? absentAsUndefined(
                    retryIdempotentWrite(
                      access.api.requestVoid("delete deployment", (client) =>
                        client.POST("/deployments/{deployment_name}/delete", {
                          params: { path: { deployment_name: target.name } },
                        }),
                      ),
                    ),
                  ).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning(
                        `Convex.Deployment could not delete ${target.name} after the failed push (${error.message}). The next run takes it over only with --adopt.`,
                      ),
                    ),
                  )
                : Effect.void,
            ),
          );
          // Taken again after the push, so that files the push generates,
          // such as convex/_generated, are part of the identity.
          return {
            ...target,
            hash: yield* wantedHash(news, rootDir, target.name),
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
          const access = yield* accessFor(addressInState(output), false);
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
