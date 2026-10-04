// Convex.PreviewDeployKey: a project key that creates and deploys preview
// deployments, such as the key CI passes to `npx convex deploy` for a branch.
//
// Convex returns the secret only once, from create_preview_deploy_key. The
// listing shows each key under a unique name, the requested name plus a short
// id suffix, and delete_preview_deploy_key accepts that unique name. A key
// cannot be changed after creation, so every property change is a replacement.
import { Resource } from "alchemy";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ListedKey, selectCreatedKey } from "./DeployKey.ts";
import { absentAsUndefined, ManagementApi } from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/** GET /projects/{project_id}/list_preview_deploy_keys */
export const PreviewDeployKeyList = Schema.Struct({ items: Schema.Array(ListedKey) });

/** POST /projects/{project_id}/create_preview_deploy_key */
export const CreatedPreviewDeployKey = Schema.Struct({ previewDeployKey: Schema.String });

export interface PreviewDeployKeyProps {
  /** Numeric project id, such as `project.projectId`. */
  readonly projectId: number;
  /** Requested key name. Convex appends a short id to make it unique. */
  readonly name: string;
}

export interface PreviewDeployKeyAttributes {
  /** The name Convex lists the key under, such as "ci (6308e666)". */
  readonly uniqueName: string;
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
          return entries?.some((entry) => entry.name === output.uniqueName) ? output : undefined;
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          if (output !== undefined) {
            // The secret cannot be read back. A key that still exists keeps the one in state.
            const entries = yield* listKeys(news.projectId);
            if (entries.some((entry) => entry.name === output.uniqueName)) return output;
          }
          const created = yield* api.request("create preview deploy key", (client) =>
            client.POST("/projects/{project_id}/create_preview_deploy_key", {
              params: { path: { project_id: news.projectId } },
              body: { name: news.name },
            }),
          );
          const { previewDeployKey } = Schema.decodeUnknownSync(CreatedPreviewDeployKey)(created);
          const listed = selectCreatedKey(yield* listKeys(news.projectId), news.name);
          if (listed === undefined) {
            return yield* Effect.die(
              new Error(
                `Convex created preview deploy key "${news.name}" in project ${news.projectId} but does not list it`,
              ),
            );
          }
          return {
            uniqueName: listed.name,
            projectId: news.projectId,
            previewDeployKey: Redacted.make(previewDeployKey),
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // 404 PreviewDeployKeyNotFound: an earlier attempt or someone else deleted it.
          yield* absentAsUndefined(
            api.requestVoid("delete preview deploy key", (client) =>
              client.POST("/projects/{project_id}/delete_preview_deploy_key", {
                params: { path: { project_id: output.projectId } },
                body: { id: output.uniqueName },
              }),
            ),
          );
        }),
      };
    }),
  );
