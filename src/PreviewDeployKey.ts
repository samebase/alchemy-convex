// Convex.PreviewDeployKey: a project key that creates and deploys preview
// deployments, such as the key CI passes to `npx convex deploy` for a branch.
//
// Convex returns the secret only once, from create_preview_deploy_key. The
// identity rules are the same as for Convex.DeployKey: a requested name that
// is unique for each resource instance, exactly one listed key after the
// create with its numeric id in state, and delete by the secret only. A key
// cannot change after creation, so every property change is a replacement.
import { Resource } from "alchemy";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { createTrackedKey, isKeyListed, ListedKey, requestedKeyName } from "./DeployKey.ts";
import { absentAsUndefined, ManagementApi, retryIdempotentWrite } from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/** GET /projects/{project_id}/list_preview_deploy_keys */
export const PreviewDeployKeyList = Schema.Struct({ items: Schema.Array(ListedKey) });

/** POST /projects/{project_id}/create_preview_deploy_key */
export const CreatedPreviewDeployKey = Schema.Struct({ previewDeployKey: Schema.String });

export interface PreviewDeployKeyProps {
  /** Numeric project id, such as `project.projectId`. */
  readonly projectId: number;
  /**
   * Key name. The provider requests this name, a dash, and a hash of the
   * resource identity, so two resources with one `name` get different keys.
   */
  readonly name: string;
}

export interface PreviewDeployKeyAttributes {
  /** The name Convex lists the key under, such as "ci-3f2a1b0c9d8e". */
  readonly uniqueName: string;
  /** Numeric id of the key in the listing. Undefined in state written by 0.1.x. */
  readonly keyId: number | undefined;
  readonly projectId: number;
  /** The secret, such as `preview:<team>:<project>|<token>`. Convex returns it only at creation. */
  readonly previewDeployKey: Redacted.Redacted<string>;
}

export type PreviewDeployKey = Resource<
  "Convex.PreviewDeployKey",
  PreviewDeployKeyProps,
  PreviewDeployKeyAttributes,
  never,
  Providers
>;
export const PreviewDeployKey = Resource<PreviewDeployKey>("Convex.PreviewDeployKey");

export const PreviewDeployKeyProvider = () =>
  Provider.effect(
    PreviewDeployKey,
    Effect.gen(function* () {
      const api = yield* ManagementApi;

      const listKeys = (projectId: number) =>
        api
          .request("list preview deploy keys", (client) =>
            client.GET("/projects/{project_id}/list_preview_deploy_keys", {
              params: { path: { project_id: projectId } },
            }),
          )
          .pipe(Effect.map((body) => Schema.decodeUnknownSync(PreviewDeployKeyList)(body).items));

      /**
       * `id` is the secret: Convex accepts it, and it matches only the key
       * that this resource created. A second delete answers 404.
       */
      const deleteKey = (projectId: number, secret: string) =>
        retryIdempotentWrite(
          api.requestVoid("delete preview deploy key", (client) =>
            client.POST("/projects/{project_id}/delete_preview_deploy_key", {
              params: { path: { project_id: projectId } },
              body: { id: secret },
            }),
          ),
        );

      return {
        stables: ["uniqueName", "projectId"],

        diff: ({ olds, news, output }) => {
          if (!isResolved(news)) return Effect.succeed(undefined);
          // State written without the secret cannot hand a key to dependents,
          // and Convex cannot return it again, so only a new key helps.
          return Effect.succeed(
            (output !== undefined && output.previewDeployKey === undefined) ||
              havePropsChanged(olds, news)
              ? ({ action: "replace" } as const)
              : ({ action: "noop" } as const),
          );
        },

        read: Effect.fn(function* ({ output }) {
          // A key that is not in state has no known secret, so it is never adopted.
          if (output === undefined) return undefined;
          const entries = yield* absentAsUndefined(listKeys(output.projectId));
          return entries !== undefined && isKeyListed(entries, output) ? output : undefined;
        }),

        reconcile: Effect.fn(function* ({ fqn, instanceId, news, output }) {
          if (output !== undefined) {
            // The secret cannot be read back. A key that still exists keeps the one in state.
            if (isKeyListed(yield* listKeys(news.projectId), output)) return output;
          }
          const name = requestedKeyName(news.name, fqn, instanceId);
          const { keyId, uniqueName, secret } = yield* createTrackedKey({
            target: `project ${news.projectId}`,
            name,
            list: listKeys(news.projectId),
            create: api
              .request("create preview deploy key", (client) =>
                client.POST("/projects/{project_id}/create_preview_deploy_key", {
                  params: { path: { project_id: news.projectId } },
                  body: { name },
                }),
              )
              .pipe(
                Effect.map(
                  (body) =>
                    Schema.decodeUnknownSync(CreatedPreviewDeployKey)(body).previewDeployKey,
                ),
              ),
            revoke: (secret) => deleteKey(news.projectId, secret),
          });
          return { uniqueName, keyId, projectId: news.projectId, previewDeployKey: secret };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Without the secret, no call can name this key alone: 0.1.x state
          // can hold the listed name of another resource's key.
          if (!Redacted.isRedacted(output.previewDeployKey)) {
            yield* Effect.logWarning(
              `Convex.PreviewDeployKey "${output.uniqueName}" in project ${output.projectId} has no secret in state, so Alchemy does not delete it. Delete it in the Convex dashboard.`,
            );
            return;
          }
          // 404 PreviewDeployKeyNotFound: an earlier attempt or someone else deleted it.
          yield* absentAsUndefined(
            deleteKey(output.projectId, Redacted.value(output.previewDeployKey)),
          );
        }),
      };
    }),
  );
