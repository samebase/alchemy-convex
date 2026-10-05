// Convex.DefaultEnvironmentVariable: a project default environment variable
// for one deployment type. Convex sets it on each new deployment of that type,
// such as auth keys that every pull request preview deployment needs.
//
// Defaults live on the Management API and authenticate with the team
// credential, not with a deploy key. Setting a default and removing it are the
// same call: update_default_environment_variables with `value: null` removes
// the default, and removing an absent default also answers 200.
//
// A default that exists but is not in state belongs to someone else: its old
// value is lost when this resource writes it. Alchemy takes it over only with
// --adopt.
//
// A new `projectId`, `name`, or `deploymentType` is an update, not a
// replacement: reconcile writes the new default first and then removes the
// one that state names. A replacement would let the engine delete an old
// generation that names the same default as the live one. When that removal
// fails, the attributes keep the old default in `staleDefaults`, and the next
// deploy and the delete remove it. Read and delete use the identity in the
// attributes: after a refused change, the props name the refused one.
import { Resource } from "alchemy";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { components } from "@convex-dev/platform/managementApi";
import { shouldAdopt } from "./Adoption.ts";
import {
  absentAsUndefined,
  ManagementApi,
  type ManagementApiService,
  retryIdempotentWrite,
} from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/** Deployment types a default can target, from the generated schema. */
export type DeploymentType = components["schemas"]["DeploymentType"];

/**
 * Attributes when the listing has `name` for `deploymentType`. An unfiltered
 * listing merges the deployment types that share one value into one row, so
 * the match checks membership in `deploymentTypes`.
 */
export const findDefault = (
  list: typeof DefaultEnvironmentVariableList.Type,
  projectId: number,
  name: string,
  deploymentType: DeploymentType,
): DefaultIdentity | undefined =>
  list.items.some((item) => item.name === name && item.deploymentTypes.includes(deploymentType))
    ? { projectId, name, deploymentType }
    : undefined;

/**
 * Lists the defaults named `name` for `deploymentType`. Convex filters on
 * both, so the listing has at most one row and needs no pagination.
 */
export const listDefaults = (
  api: ManagementApiService,
  projectId: number,
  name: string,
  deploymentType: DeploymentType,
) =>
  api
    .request("list default environment variables", (client) =>
      client.GET("/projects/{project_id}/list_default_environment_variables", {
        params: { path: { project_id: projectId }, query: { name, deploymentType } },
      }),
    )
    .pipe(Effect.map((body) => Schema.decodeUnknownSync(DefaultEnvironmentVariableList)(body)));

/** One attempt to set one default, or to remove it when `value` is null. */
const writeDefault = (
  api: ManagementApiService,
  projectId: number,
  name: string,
  deploymentType: DeploymentType,
  value: string | Redacted.Redacted<string> | null,
) =>
  api.requestVoid("update default environment variables", (client) =>
    client.POST("/projects/{project_id}/update_default_environment_variables", {
      params: { path: { project_id: projectId } },
      body: {
        changes: [
          {
            name,
            deploymentType,
            value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
          },
        ],
      },
    }),
  );

/**
 * Sets one default, or removes it when `value` is null. Convex answers 200
 * with an empty body, so this reads no response data. The call sets a value,
 * so it runs again after a write conflict or a 5xx answer, for example when
 * another resource writes a default of the same project at the same time.
 */
export const updateDefault = (
  api: ManagementApiService,
  projectId: number,
  name: string,
  deploymentType: DeploymentType,
  value: string | Redacted.Redacted<string> | null,
) => retryIdempotentWrite(writeDefault(api, projectId, name, deploymentType, value));

/** The default's identity, or undefined when the default or the project is absent. */
const readDefault = (
  api: ManagementApiService,
  projectId: number,
  name: string,
  deploymentType: DeploymentType,
) =>
  // 404 ProjectNotFound: the project no longer exists, so neither does the default.
  absentAsUndefined(listDefaults(api, projectId, name, deploymentType)).pipe(
    Effect.map((list) =>
      list === undefined ? undefined : findDefault(list, projectId, name, deploymentType),
    ),
  );

/**
 * GET /projects/{project_id}/list_default_environment_variables. Only the
 * fields the provider uses: the row's `value` is the secret in plain text.
 */
export const DefaultEnvironmentVariableList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ name: Schema.String, deploymentTypes: Schema.Array(Schema.String) }),
  ),
});

export interface DefaultEnvironmentVariableProps {
  /** Numeric project id, such as `project.projectId`. */
  readonly projectId: number;
  readonly name: string;
  readonly value: string | Redacted.Redacted<string>;
  /** Deployments of this type that Convex creates from now on get the variable. */
  readonly deploymentType: DeploymentType;
}

/** The default that a project, a name, and a deployment type name. */
export interface DefaultIdentity {
  readonly projectId: number;
  readonly name: string;
  readonly deploymentType: DeploymentType;
}

export interface DefaultEnvironmentVariableAttributes extends DefaultIdentity {
  /** Defaults that a rename or a move did not remove yet. The next deploy and the delete remove them. */
  readonly staleDefaults: ReadonlyArray<DefaultIdentity> | undefined;
}

export type DefaultEnvironmentVariable = Resource<
  "Convex.DefaultEnvironmentVariable",
  DefaultEnvironmentVariableProps,
  DefaultEnvironmentVariableAttributes,
  never,
  Providers
>;
export const DefaultEnvironmentVariable = Resource<DefaultEnvironmentVariable>(
  "Convex.DefaultEnvironmentVariable",
);

const sameDefault = (a: DefaultIdentity, b: DefaultIdentity) =>
  a.projectId === b.projectId && a.name === b.name && a.deploymentType === b.deploymentType;

export const DefaultEnvironmentVariableProvider = () =>
  Provider.effect(
    DefaultEnvironmentVariable,
    Effect.gen(function* () {
      const api = yield* ManagementApi;

      /** Removes the defaults and returns the ones that are still there, each with a warning. */
      const removeStale = (stale: ReadonlyArray<DefaultIdentity>) =>
        Effect.forEach(stale, (old) =>
          // 404 ProjectNotFound: that project is gone, so is the default.
          absentAsUndefined(
            updateDefault(api, old.projectId, old.name, old.deploymentType, null),
          ).pipe(
            Effect.as<ReadonlyArray<DefaultIdentity>>([]),
            Effect.catchTag("ConvexApiError", (error) =>
              Effect.logWarning(
                `The ${old.deploymentType} default environment variable ${old.name} of project ${old.projectId} is not removed yet: ${error.message}. The next deploy tries again.`,
              ).pipe(Effect.as([old])),
            ),
          ),
        ).pipe(Effect.map((left) => left.flat()));

      return {
        // A default that a rename did not remove yet needs an update, which
        // removes it. Otherwise the engine updates when any prop changed and
        // compares a Redacted value by content.
        diff: ({ output }) =>
          Effect.succeed(
            output?.staleDefaults !== undefined && output.staleDefaults.length > 0
              ? ({ action: "update" } as const)
              : undefined,
          ),

        read: Effect.fn(function* ({ olds, output }) {
          const at = output ?? olds;
          const found = yield* readDefault(api, at.projectId, at.name, at.deploymentType);
          if (found === undefined) return undefined;
          // No state: the default belongs to someone else until the user passes --adopt.
          return output ?? Unowned({ ...found, staleDefaults: undefined });
        }),

        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          // A rename back to a default that a failed cleanup left is still ours.
          const stale = (output?.staleDefaults ?? []).filter((old) => !sameDefault(old, news));
          const owned =
            (output !== undefined && sameDefault(output, news)) ||
            stale.length !== (output?.staleDefaults?.length ?? 0);
          const write = writeDefault(
            api,
            news.projectId,
            news.name,
            news.deploymentType,
            news.value,
          );
          if (owned || (yield* shouldAdopt(fqn))) {
            // In state, or adopted: the default is ours to set.
            yield* retryIdempotentWrite(write);
          } else {
            // Not in state: a new resource, or a new project, name, or type.
            // Overwriting a default that exists loses its value, so that
            // needs adoption. Each attempt checks first, so a retry after a
            // write conflict never overwrites a default that another writer
            // created in the meantime.
            yield* retryIdempotentWrite(
              Effect.gen(function* () {
                const existing = yield* readDefault(
                  api,
                  news.projectId,
                  news.name,
                  news.deploymentType,
                );
                if (existing !== undefined) {
                  return yield* new OwnedBySomeoneElse({
                    message: `Project ${news.projectId} already has a ${news.deploymentType} default environment variable ${news.name}. Re-run with --adopt to take it over and overwrite its value, or use a different name.`,
                    resourceType: DefaultEnvironmentVariable.Type,
                    physicalName: news.name,
                  });
                }
                yield* write;
              }),
            );
          }
          if (output !== undefined && !sameDefault(output, news)) {
            // A rename or a move: the default that state names is now stale.
            stale.push({
              projectId: output.projectId,
              name: output.name,
              deploymentType: output.deploymentType,
            });
          }
          const left = yield* removeStale(stale);
          return {
            projectId: news.projectId,
            name: news.name,
            deploymentType: news.deploymentType,
            staleDefaults: left.length === 0 ? undefined : left,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Removing an absent default succeeds; 404 ProjectNotFound means the project is gone.
          yield* Effect.forEach([output, ...(output.staleDefaults ?? [])], (variable) =>
            absentAsUndefined(
              updateDefault(api, variable.projectId, variable.name, variable.deploymentType, null),
            ),
          );
        }),
      };
    }),
  );
