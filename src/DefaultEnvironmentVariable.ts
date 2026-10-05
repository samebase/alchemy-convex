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
// generation that names the same default as the live one.
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
): DefaultEnvironmentVariableAttributes | undefined =>
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

/** Attributes of the default, or undefined when the default or the project is absent. */
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

export interface DefaultEnvironmentVariableAttributes {
  readonly projectId: number;
  readonly name: string;
  readonly deploymentType: DeploymentType;
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

export const DefaultEnvironmentVariableProvider = () =>
  Provider.effect(
    DefaultEnvironmentVariable,
    Effect.gen(function* () {
      const api = yield* ManagementApi;

      // No diff: the engine updates when any prop changed and compares a
      // Redacted value by content.
      return {
        read: Effect.fn(function* ({ olds, output }) {
          const found = yield* readDefault(api, olds.projectId, olds.name, olds.deploymentType);
          // No state: the default belongs to someone else until the user passes --adopt.
          return found === undefined || output !== undefined ? found : Unowned(found);
        }),

        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          const write = writeDefault(
            api,
            news.projectId,
            news.name,
            news.deploymentType,
            news.value,
          );
          const inState =
            output?.projectId === news.projectId &&
            output.name === news.name &&
            output.deploymentType === news.deploymentType;
          if (inState || (yield* shouldAdopt(fqn))) {
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
          if (output !== undefined && !inState) {
            // A rename or a move: remove the default that state names, now
            // that the new one is written. 404: that project is gone.
            yield* absentAsUndefined(
              updateDefault(api, output.projectId, output.name, output.deploymentType, null),
            );
          }
          return {
            projectId: news.projectId,
            name: news.name,
            deploymentType: news.deploymentType,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Removing an absent default succeeds; 404 ProjectNotFound means the project is gone.
          yield* absentAsUndefined(
            updateDefault(api, output.projectId, output.name, output.deploymentType, null),
          );
        }),
      };
    }),
  );
