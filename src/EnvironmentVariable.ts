// Convex.EnvironmentVariable: one environment variable on one deployment.
//
// Environment variables live on the deployment API
// (https://<deployment>.convex.cloud/api/v1), which authenticates with a
// deploy key, not with the Management API token. Setting a variable and
// removing it are the same call: update_environment_variables with
// `value: null` removes the variable.
//
// A variable that exists but is not in state belongs to someone else: its
// old value is lost when this resource writes it. Alchemy takes it over only
// with --adopt.
import { createDeploymentClient } from "@convex-dev/platform";
import { Resource } from "alchemy";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { shouldAdopt } from "./Adoption.ts";
import {
  absentAsUndefined,
  ManagementApi,
  type ManagementApiService,
  retryIdempotentWrite,
  settleVoid,
} from "./ManagementApi.ts";
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
 * One attempt to set one variable, or to remove it when `value` is null. The
 * deployment answers 200 with an empty body, so this reads no response data.
 */
const writeVariable = (
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

/**
 * Sets one variable, or removes it when `value` is null. The call sets a
 * value, so it runs again after a write conflict or a 5xx answer, for example
 * when another resource writes a variable of the same deployment at the same
 * time. Use it only where the variable is already ours to set.
 */
export const updateVariable = (
  deployment: string,
  deployKey: Redacted.Redacted<string>,
  name: string,
  value: string | Redacted.Redacted<string> | null,
) => retryIdempotentWrite(writeVariable(deployment, deployKey, name, value));

/** GET https://<deployment>.convex.cloud/api/v1/list_environment_variables */
export const EnvironmentVariableList = Schema.Struct({
  environmentVariables: Schema.Record(Schema.String, Schema.String),
});

/** Attributes of the variable on the deployment, or undefined when the variable or the deployment is absent. */
const readVariable = (
  api: ManagementApiService,
  deployment: string,
  deployKey: Redacted.Redacted<string>,
  name: string,
) =>
  // 404: the deployment no longer exists, so neither does the variable.
  absentAsUndefined(
    api.deploymentRequest("list environment variables", deployment, deployKey, (client) =>
      client.GET("/list_environment_variables"),
    ),
  ).pipe(
    Effect.map((body) =>
      body === undefined
        ? undefined
        : findVariable(Schema.decodeUnknownSync(EnvironmentVariableList)(body), deployment, name),
    ),
  );

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

        read: Effect.fn(function* ({ olds, output }) {
          const found = yield* readVariable(api, olds.deployment, olds.deployKey, olds.name);
          // No state: the variable belongs to someone else until the user passes --adopt.
          return found === undefined || output !== undefined ? found : Unowned(found);
        }),

        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          const write = writeVariable(news.deployment, news.deployKey, news.name, news.value);
          if (output !== undefined || (yield* shouldAdopt(fqn))) {
            // In state, or adopted: the variable is ours to set.
            yield* retryIdempotentWrite(write);
          } else {
            // No state, for example after a replacement: the engine did not
            // read this name in plan. Overwriting a variable that exists loses
            // its value, so that needs adoption. Each attempt checks first, so
            // a retry after a write conflict never overwrites a variable that
            // another writer created in the meantime.
            yield* retryIdempotentWrite(
              Effect.gen(function* () {
                const existing = yield* readVariable(
                  api,
                  news.deployment,
                  news.deployKey,
                  news.name,
                );
                if (existing !== undefined) {
                  return yield* new OwnedBySomeoneElse({
                    message: `Environment variable ${news.name} already exists on deployment ${news.deployment}. Re-run with --adopt to take it over and overwrite its value, or use a different name.`,
                    resourceType: EnvironmentVariable.Type,
                    physicalName: news.name,
                  });
                }
                yield* write;
              }),
            );
          }
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
