// Convex.DefaultEnvironmentVariable: a project default environment variable
// for one deployment type. Convex sets it on each new deployment of that type,
// such as auth keys that every pull request preview deployment needs.
//
// Defaults live on the Management API and authenticate with the team
// credential, not with a deploy key. Setting a default and removing it are the
// same call: update_default_environment_variables with `value: null` removes
// the default, and removing an absent default also answers 200.
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { components } from "@convex-dev/platform/managementApi";
import { absentAsUndefined, ManagementApi, type ManagementApiService } from "./ManagementApi.ts";
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

/**
 * Sets one default, or removes it when `value` is null. Convex answers 200
 * with an empty body, so this reads no response data.
 */
export const updateDefault = (
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

      return {
        stables: ["projectId", "name", "deploymentType"],

        diff: ({ olds, news }) => {
          if (!isResolved(news)) return Effect.succeed(undefined);
          // Otherwise undefined: the engine updates when any prop changed and
          // compares a Redacted value by content.
          return Effect.succeed(
            olds.projectId !== news.projectId ||
              olds.name !== news.name ||
              olds.deploymentType !== news.deploymentType
              ? ({ action: "replace" } as const)
              : undefined,
          );
        },

        read: Effect.fn(function* ({ olds }) {
          // 404 ProjectNotFound: the project no longer exists, so neither does the default.
          const list = yield* absentAsUndefined(
            listDefaults(api, olds.projectId, olds.name, olds.deploymentType),
          );
          if (list === undefined) return undefined;
          return findDefault(list, olds.projectId, olds.name, olds.deploymentType);
        }),

        reconcile: Effect.fn(function* ({ news }) {
          yield* updateDefault(api, news.projectId, news.name, news.deploymentType, news.value);
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
