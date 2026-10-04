// Convex.DeployKey: a deploy key for one deployment, such as the key
// `npx convex deploy` reads from CONVEX_DEPLOY_KEY.
//
// Convex returns the secret only once, from create_deploy_key. The listing
// shows each key under a unique name, the requested name plus a short id
// suffix such as "my-key (0e71106d)", and delete_deploy_key accepts that
// unique name. A key cannot be changed after creation, so every property
// change is a replacement.
import { Resource } from "alchemy";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { components } from "@convex-dev/platform/managementApi";
import { absentAsUndefined, ManagementApi } from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/** Actions a deploy key can be limited to, from the generated schema. */
export type DeployKeyAction = NonNullable<
  components["schemas"]["PlatformCreateDeployKeyArgs"]["allowedActions"]
>[number];

/**
 * True when `listedName` is how Convex lists a key created as `name`: the
 * requested name, a space, and one parenthesized id without spaces. The id
 * check keeps `my-key` from matching a key created as `my-key (old)`.
 */
const isListedAs = (listedName: string, name: string) => {
  const prefix = `${name} (`;
  return listedName.startsWith(prefix) && /^[^\s()]+\)$/.test(listedName.slice(prefix.length));
};

/**
 * The listed key that a create call for `name` just made. The newest match
 * wins: an earlier attempt that failed before Alchemy saved state can leave
 * another key with the same requested name, and its secret is lost.
 */
export const selectCreatedKey = (
  entries: ReadonlyArray<typeof ListedKey.Type>,
  name: string,
): typeof ListedKey.Type | undefined =>
  entries
    .filter((entry) => isListedAs(entry.name, name))
    .reduce<typeof ListedKey.Type | undefined>(
      (newest, entry) =>
        newest === undefined || entry.creationTime > newest.creationTime ? entry : newest,
      undefined,
    );

/** One row of list_deploy_keys and list_preview_deploy_keys. Only the fields the providers use. */
export const ListedKey = Schema.Struct({
  name: Schema.String,
  creationTime: Schema.Number,
});

/** GET /deployments/{deployment_name}/list_deploy_keys */
export const DeployKeyList = Schema.Array(ListedKey);

/** POST /deployments/{deployment_name}/create_deploy_key */
export const CreatedDeployKey = Schema.Struct({ deployKey: Schema.String });

export interface DeployKeyProps {
  /** Deployment name, such as `project.prodDeploymentName`. */
  readonly deployment: string;
  /** Requested key name. Convex appends a short id to make it unique. */
  readonly name: string;
  /** Limits the key to these actions. Convex grants every deployment action when omitted. */
  readonly allowedActions?: readonly DeployKeyAction[];
}

export interface DeployKeyAttributes {
  /** The name Convex lists the key under, such as "my-key (0e71106d)". */
  readonly uniqueName: string;
  readonly deployment: string;
  /** The secret, such as `prod:<deployment>|<token>`. Convex returns it only at creation. */
  readonly deployKey: Redacted.Redacted<string>;
}

export type DeployKey = Resource<
  "Convex.DeployKey",
  DeployKeyProps,
  DeployKeyAttributes,
  never,
  Providers
>;
export const DeployKey = Resource<DeployKey>("Convex.DeployKey");

export const DeployKeyProvider = () =>
  Provider.effect(
    DeployKey,
    Effect.gen(function* () {
      const api = yield* ManagementApi;

      const listKeys = (deployment: string) =>
        api
          .request("list deploy keys", (client) =>
            client.GET("/deployments/{deployment_name}/list_deploy_keys", {
              params: { path: { deployment_name: deployment } },
            }),
          )
          .pipe(Effect.map((body) => Schema.decodeUnknownSync(DeployKeyList)(body)));

      return {
        stables: ["uniqueName", "deployment"],

        diff: ({ olds, news, output }) => {
          if (!isResolved(news)) return Effect.succeed(undefined);
          // State written without the secret cannot hand a key to dependents,
          // and Convex cannot return it again, so only a new key helps.
          return Effect.succeed(
            (output !== undefined && output.deployKey === undefined) || havePropsChanged(olds, news)
              ? ({ action: "replace" } as const)
              : ({ action: "noop" } as const),
          );
        },

        read: Effect.fn(function* ({ output }) {
          // A key that is not in state has no known secret, so it is never adopted.
          if (output === undefined) return undefined;
          const entries = yield* absentAsUndefined(listKeys(output.deployment));
          return entries?.some((entry) => entry.name === output.uniqueName) ? output : undefined;
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          if (output !== undefined) {
            // The secret cannot be read back. A key that still exists keeps the one in state.
            const entries = yield* listKeys(news.deployment);
            if (entries.some((entry) => entry.name === output.uniqueName)) return output;
          }
          const created = yield* api.request("create deploy key", (client) =>
            client.POST("/deployments/{deployment_name}/create_deploy_key", {
              params: { path: { deployment_name: news.deployment } },
              body: {
                name: news.name,
                ...(news.allowedActions === undefined
                  ? {}
                  : { allowedActions: [...news.allowedActions] }),
              },
            }),
          );
          const { deployKey } = Schema.decodeUnknownSync(CreatedDeployKey)(created);
          const listed = selectCreatedKey(yield* listKeys(news.deployment), news.name);
          if (listed === undefined) {
            return yield* Effect.die(
              new Error(
                `Convex created deploy key "${news.name}" on ${news.deployment} but does not list it`,
              ),
            );
          }
          return {
            uniqueName: listed.name,
            deployment: news.deployment,
            deployKey: Redacted.make(deployKey),
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // 404 DeployKeyNotFound: an earlier attempt or someone else deleted it.
          yield* absentAsUndefined(
            api.requestVoid("delete deploy key", (client) =>
              client.POST("/deployments/{deployment_name}/delete_deploy_key", {
                params: { path: { deployment_name: output.deployment } },
                body: { id: output.uniqueName },
              }),
            ),
          );
        }),
      };
    }),
  );
