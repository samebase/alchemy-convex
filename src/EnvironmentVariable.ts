// Convex.EnvironmentVariable: one environment variable on one deployment.
//
// Environment variables live on the deployment API
// (https://<deployment>.convex.cloud/api/v1), which authenticates with a
// deploy key, not with the Management API token. Setting a variable and
// removing it are the same call: update_environment_variables with
// `value: null` removes the variable.
import { createDeploymentClient } from "@convex-dev/platform";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { absentAsUndefined, ManagementApi, settleVoid } from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/**
 * Attributes when the listing has `name`. Own keys only: a valid variable
 * name such as `toString` must not match the object prototype.
 */
export const findVariable = (
  list: typeof EnvironmentVariableList.Type,
  deployment: string,
  name: string,
): EnvironmentVariableAttributes | undefined =>
  Object.hasOwn(list.environmentVariables, name) ? { deployment, name } : undefined;

/**
 * Sets one variable, or removes it when `value` is null. The deployment
 * answers 200 with an empty body, so this reads no response data.
 */
export const updateVariable = (
  deployment: string,
  deployKey: Redacted.Redacted<string>,
  name: string,
  value: string | Redacted.Redacted<string> | null,
) =>
  settleVoid("update environment variables", () =>
    createDeploymentClient(deployment, Redacted.value(deployKey)).POST(
      "/update_environment_variables",
      {
        body: {
          changes: [{ name, value: Redacted.isRedacted(value) ? Redacted.value(value) : value }],
        },
      },
    ),
  );

/** GET https://<deployment>.convex.cloud/api/v1/list_environment_variables */
export const EnvironmentVariableList = Schema.Struct({
  environmentVariables: Schema.Record(Schema.String, Schema.String),
});

export interface EnvironmentVariableProps {
  /** Deployment name, or its URL for deployments outside US East. */
  readonly deployment: string;
  /** Deploy key for `deployment`, such as `deployKey.deployKey`. */
  readonly deployKey: Redacted.Redacted<string>;
  readonly name: string;
  readonly value: string | Redacted.Redacted<string>;
}

export interface EnvironmentVariableAttributes {
  readonly deployment: string;
  readonly name: string;
}

export type EnvironmentVariable = Resource<
  "Convex.EnvironmentVariable",
  EnvironmentVariableProps,
  EnvironmentVariableAttributes,
  never,
  Providers
>;
export const EnvironmentVariable = Resource<EnvironmentVariable>("Convex.EnvironmentVariable");

export const EnvironmentVariableProvider = () =>
  Provider.effect(
    EnvironmentVariable,
    Effect.gen(function* () {
      const api = yield* ManagementApi;

      return {
        stables: ["deployment", "name"],

        diff: ({ olds, news }) => {
          if (!isResolved(news)) return Effect.succeed(undefined);
          // Otherwise undefined: the engine updates when any prop changed and
          // compares Redacted values, such as the value and the deploy key, by content.
          return Effect.succeed(
            olds.deployment !== news.deployment || olds.name !== news.name
              ? ({ action: "replace" } as const)
              : undefined,
          );
        },

        read: Effect.fn(function* ({ olds }) {
          // 404: the deployment no longer exists, so neither does the variable.
          const body = yield* absentAsUndefined(
            api.deploymentRequest(
              "list environment variables",
              olds.deployment,
              olds.deployKey,
              (client) => client.GET("/list_environment_variables"),
            ),
          );
          if (body === undefined) return undefined;
          return findVariable(
            Schema.decodeUnknownSync(EnvironmentVariableList)(body),
            olds.deployment,
            olds.name,
          );
        }),

        reconcile: Effect.fn(function* ({ news }) {
          yield* updateVariable(news.deployment, news.deployKey, news.name, news.value);
          return { deployment: news.deployment, name: news.name };
        }),

        delete: Effect.fn(function* ({ olds, output }) {
          // Removing an absent variable succeeds; 404 means the deployment is gone.
          yield* absentAsUndefined(
            updateVariable(output.deployment, olds.deployKey, output.name, null),
          );
        }),
      };
    }),
  );
