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
//
// A new `name` or `deployment` is an update, not a replacement: reconcile
// writes the new variable first and then removes the one that state names.
// A replacement would let the engine delete an old generation that has the
// same name as the live one, for example after a refused rename is reverted.
// When that removal fails, the attributes keep the old variable in
// `staleVariables`, and the next deploy and the delete remove it.
//
// The attributes keep the deploy key of the variable's deployment. After a
// refused move, the props name the other deployment and its key, so read and
// delete use the attributes, not the props.
import { createDeploymentClient } from "@convex-dev/platform";
import { Resource } from "alchemy";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
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
 * The variable's identity when the listing has `name`. Own keys only: a
 * valid variable name such as `toString` must not match the object prototype.
 */
export const findVariable = (
  list: typeof EnvironmentVariableList.Type,
  deployment: string,
  name: string,
): { readonly deployment: string; readonly name: string } | undefined =>
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

/** The variable's identity, or undefined when the variable or the deployment is absent. */
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

/** A variable of an earlier name or deployment that a rename or a move did not remove yet. */
export interface StaleVariable {
  readonly deployment: string;
  readonly name: string;
  /** Deploy key for `deployment`. */
  readonly deployKey: Redacted.Redacted<string>;
}

export interface EnvironmentVariableAttributes {
  readonly deployment: string;
  readonly name: string;
  /** Deploy key for `deployment`, for read and delete. Undefined in state from 0.1.x. */
  readonly deployKey: Redacted.Redacted<string> | undefined;
  /** Variables that a rename or a move did not remove yet. The next deploy and the delete remove them. */
  readonly staleVariables: ReadonlyArray<StaleVariable> | undefined;
}

export type EnvironmentVariable = Resource<
  "Convex.EnvironmentVariable",
  EnvironmentVariableProps,
  EnvironmentVariableAttributes,
  never,
  Providers
>;
export const EnvironmentVariable = Resource<EnvironmentVariable>("Convex.EnvironmentVariable");

/**
 * The deploy key for the variable in state: from the attributes, or, for
 * state from 0.1.x, from props that name the same deployment.
 */
const keyOf = (
  output: EnvironmentVariableAttributes,
  olds: EnvironmentVariableProps | undefined,
): Redacted.Redacted<string> | undefined =>
  output.deployKey ?? (olds?.deployment === output.deployment ? olds.deployKey : undefined);

/** Removes the variables and returns the ones that are still there, each with a warning. */
const removeStale = (stale: ReadonlyArray<StaleVariable>) =>
  Effect.forEach(stale, (old) =>
    absentAsUndefined(updateVariable(old.deployment, old.deployKey, old.name, null)).pipe(
      Effect.as<ReadonlyArray<StaleVariable>>([]),
      Effect.catchTag("ConvexApiError", (error) =>
        Effect.logWarning(
          `Environment variable ${old.name} on deployment ${old.deployment} is not removed yet: ${error.message}. The next deploy tries again.`,
        ).pipe(Effect.as([old])),
      ),
    ),
  ).pipe(Effect.map((left) => left.flat()));

export const EnvironmentVariableProvider = () =>
  Provider.effect(
    EnvironmentVariable,
    Effect.gen(function* () {
      const api = yield* ManagementApi;

      return {
        // A variable that a rename did not remove yet needs an update, which
        // removes it. Otherwise the engine updates when any prop changed and
        // compares Redacted values, such as the value and the deploy key, by
        // content.
        diff: ({ output }) =>
          Effect.succeed(
            output?.staleVariables !== undefined && output.staleVariables.length > 0
              ? ({ action: "update" } as const)
              : undefined,
          ),

        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const key = keyOf(output, olds);
            // Without a key for the deployment in state, keep the state as it is.
            if (key === undefined) return output;
            const found = yield* readVariable(api, output.deployment, key, output.name);
            return found === undefined ? undefined : output;
          }
          const found = yield* readVariable(api, olds.deployment, olds.deployKey, olds.name);
          // No state: the variable belongs to someone else until the user passes --adopt.
          return found === undefined
            ? undefined
            : Unowned({ ...found, deployKey: olds.deployKey, staleVariables: undefined });
        }),

        reconcile: Effect.fn(function* ({ fqn, olds, news, output }) {
          const sameAs = (variable: { readonly deployment: string; readonly name: string }) =>
            variable.deployment === news.deployment && variable.name === news.name;
          // A rename back to a name that a failed cleanup left is still ours.
          const stale = (output?.staleVariables ?? []).filter((old) => !sameAs(old));
          const owned =
            (output !== undefined && sameAs(output)) ||
            stale.length !== (output?.staleVariables?.length ?? 0);
          const write = writeVariable(news.deployment, news.deployKey, news.name, news.value);
          if (owned || (yield* shouldAdopt(fqn))) {
            // In state, or adopted: the variable is ours to set.
            yield* retryIdempotentWrite(write);
          } else {
            // Not in state: a new resource, or a new name or deployment.
            // Overwriting a variable that exists loses its value, so that
            // needs adoption. Each attempt checks first, so a retry after a
            // write conflict never overwrites a variable that another writer
            // created in the meantime.
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
          if (output !== undefined && !sameAs(output)) {
            // A rename or a move: the variable that state names is now stale.
            const key = keyOf(output, olds);
            if (key === undefined) {
              yield* Effect.logWarning(
                `Environment variable ${output.name} on deployment ${output.deployment} stays: Alchemy has no deploy key for that deployment. Remove it in the Convex dashboard.`,
              );
            } else {
              stale.push({ deployment: output.deployment, name: output.name, deployKey: key });
            }
          }
          const left = yield* removeStale(stale);
          return {
            deployment: news.deployment,
            name: news.name,
            deployKey: news.deployKey,
            staleVariables: left.length === 0 ? undefined : left,
          };
        }),

        delete: Effect.fn(function* ({ olds, output }) {
          const key = keyOf(output, olds);
          if (key === undefined) {
            yield* Effect.logWarning(
              `Environment variable ${output.name} on deployment ${output.deployment} stays: Alchemy has no deploy key for that deployment. Remove it in the Convex dashboard.`,
            );
          }
          const all = [
            ...(key === undefined
              ? []
              : [{ deployment: output.deployment, name: output.name, deployKey: key }]),
            ...(output.staleVariables ?? []),
          ];
          // Removing an absent variable succeeds; 404 means the deployment is gone.
          yield* Effect.forEach(all, (variable) =>
            absentAsUndefined(
              updateVariable(variable.deployment, variable.deployKey, variable.name, null),
            ),
          );
        }),
      };
    }),
  );
