// Convex.DeployKey: a deploy key for one deployment, such as the key
// `npx convex deploy` reads from CONVEX_DEPLOY_KEY.
//
// Convex returns the secret only once, from create_deploy_key, and the
// response has no id. The listing shows each key with a numeric id and a
// name: the requested name, or, when a listed key already has that name, the
// requested name plus a suffix such as " (870993b4-ffe6-4911-adbd-e29f7fd712f2)".
//
// One resource must never revoke the key of another resource:
// - The requested name is the `name` prop plus a hash of the resource's fqn
//   and instance id, so two resources with the same `name` request
//   different names.
// - After the create, exactly one listed key must have the requested name.
//   Otherwise the create fails with a typed error that lists the keys. State
//   keeps that key's numeric id.
// - Delete sends the secret as `id`, so it can revoke only the key that this
//   resource created. It never deletes by a listed name.
// - With an OAuth token as the Management API credential, Convex returns
//   that token as the "new" key. The provider never stores, revokes, or
//   deletes such a key: the create fails with DeployKeyIsCredential.
// - Delete runs only for a key with a `keyId` in state. A 0.1.x key, which
//   has none, stays in Convex with a warning.
// A key cannot change after creation, so every property change is a replacement.
import { createHash } from "node:crypto";
import { Resource } from "alchemy";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { components } from "@convex-dev/platform/managementApi";
import {
  absentAsUndefined,
  type ConvexApiError,
  ManagementApi,
  retryIdempotentWrite,
} from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/** Actions a deploy key can be limited to, from the generated schema. */
export type DeployKeyAction = NonNullable<
  components["schemas"]["PlatformCreateDeployKeyArgs"]["allowedActions"]
>[number];

/**
 * True when `listedName` is how Convex lists a key created as `name`: the
 * requested name itself, or the requested name, a space, and one
 * parenthesized suffix without spaces. The suffix check keeps `my-key` from
 * matching a key created as `my-key (old)`.
 */
const isListedAs = (listedName: string, name: string) => {
  const prefix = `${name} (`;
  return (
    listedName === name ||
    (listedName.startsWith(prefix) && /^[^\s()]+\)$/.test(listedName.slice(prefix.length)))
  );
};

/**
 * True when the listing still has the key in state: by numeric id, or by
 * listed name for state written by 0.1.x, which has no id.
 */
export const isKeyListed = (
  entries: ReadonlyArray<typeof ListedKey.Type>,
  key: { readonly keyId: number | undefined; readonly uniqueName: string },
): boolean =>
  entries.some((entry) =>
    key.keyId === undefined ? entry.name === key.uniqueName : entry.id === key.keyId,
  );

/** The listed keys that Convex shows for a key created as `name`. */
export const keysListedAs = (
  entries: ReadonlyArray<typeof ListedKey.Type>,
  name: string,
): ReadonlyArray<typeof ListedKey.Type> => entries.filter((entry) => isListedAs(entry.name, name));

/**
 * The name that a resource instance requests: `name`, a dash, and the first
 * 12 hex characters of sha256("<fqn>:<instanceId>"). Two resources, or the
 * old and the new generation of one replaced resource, never request the
 * same name. Pattern from Confect `packages/alchemy/src/internal/ResourceIdentity.ts`
 * (https://github.com/rjdellecese/confect, ISC license).
 */
export const requestedKeyName = (name: string, fqn: string, instanceId: string): string =>
  `${name}-${createHash("sha256").update(`${fqn}:${instanceId}`).digest("hex").slice(0, 12)}`;

/** One row of list_deploy_keys and list_preview_deploy_keys. Only the fields the providers use. */
export const ListedKey = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

/** GET /deployments/{deployment_name}/list_deploy_keys */
export const DeployKeyList = Schema.Array(ListedKey);

/** POST /deployments/{deployment_name}/create_deploy_key */
export const CreatedDeployKey = Schema.Struct({ deployKey: Schema.String });

/**
 * A key cannot be tied to one resource: before the create, listed keys
 * already have the requested name, or after the create, not exactly one has it.
 */
export class DeployKeyRecoveryRequired extends Schema.TaggedError<DeployKeyRecoveryRequired>()(
  "DeployKeyRecoveryRequired",
  {
    /** Where the keys live, such as `deployment happy-otter-123` or `project 3145389`. */
    target: Schema.String,
    /** The requested name. */
    name: Schema.String,
    /** The listed keys with the requested name. */
    keys: Schema.Array(ListedKey),
    /** True when this run created a key before the listing check failed. */
    afterCreate: Schema.Boolean,
  },
) {
  override get message() {
    const listed =
      this.keys.length === 0
        ? "no key"
        : this.keys.map((key) => `"${key.name}" (id ${key.id})`).join(", ");
    return this.afterCreate
      ? `Convex created deploy key "${this.name}" on ${this.target}, but the listing shows ${listed} with that name, not exactly one, so this resource cannot track the new key. Alchemy does not revoke it. Delete the keys with that name in the Convex dashboard, then run the deploy again.`
      : `${this.target} already lists ${listed} with the name "${this.name}", but Alchemy state has no such key. An interrupted run probably created it, and its secret is lost. Delete these keys in the Convex dashboard, then run the deploy again.`;
  }
}

/**
 * Convex returned the Management API credential itself as the new key. This
 * happens with an OAuth token: Convex creates no key. A delete of the
 * returned secret would revoke the credential, so the resource does not keep it.
 */
export class DeployKeyIsCredential extends Schema.TaggedError<DeployKeyIsCredential>()(
  "DeployKeyIsCredential",
  { target: Schema.String, name: Schema.String },
) {
  override get message() {
    return `Convex returned the Management API credential itself as deploy key "${this.name}" on ${this.target}. With an OAuth token, Convex creates no new key, and deleting the returned key would revoke the OAuth token. Alchemy does not keep it. Use a team access token in CONVEX_ACCESS_TOKEN, or the Convex CLI login.`;
  }
}

/**
 * Creates a key named `name` and ties it to the caller. Fails before the
 * create when keys with that name already exist. After the create, fails
 * when the secret is the Management API credential itself, or when the
 * listing does not show exactly one key with that name. It never revokes a
 * key: the returned secret can be a shared credential.
 */
export const createTrackedKey = (options: {
  readonly target: string;
  readonly name: string;
  readonly list: Effect.Effect<ReadonlyArray<typeof ListedKey.Type>, ConvexApiError>;
  readonly create: Effect.Effect<string, ConvexApiError>;
  readonly isCredentialToken: (secret: string) => Effect.Effect<boolean>;
}) =>
  Effect.gen(function* () {
    const { target, name } = options;
    const existing = keysListedAs(yield* options.list, name);
    if (existing.length > 0) {
      return yield* new DeployKeyRecoveryRequired({
        target,
        name,
        keys: existing,
        afterCreate: false,
      });
    }
    const secret = yield* options.create;
    if (yield* options.isCredentialToken(secret)) {
      return yield* new DeployKeyIsCredential({ target, name });
    }
    const listed = keysListedAs(yield* options.list, name);
    const [only] = listed;
    if (only === undefined || listed.length !== 1) {
      return yield* new DeployKeyRecoveryRequired({
        target,
        name,
        keys: listed,
        afterCreate: true,
      });
    }
    return { keyId: only.id, uniqueName: only.name, secret: Redacted.make(secret) };
  });

/**
 * The secret to send to a delete call, or undefined when a delete is not
 * safe. Only a key with a `keyId` in state is known to be a new key that
 * this resource owns: createTrackedKey found exactly one new listed key, and
 * the secret was not the credential. State from 0.1.x has no `keyId`, and its
 * secret can be an OAuth token that Convex returned as a key, so a delete
 * could revoke that OAuth token. Such a key stays, and a warning names it.
 */
export const secretToDelete = (
  key: {
    readonly keyId: number | undefined;
    readonly secret: Redacted.Redacted<string> | undefined;
  },
  label: string,
) =>
  Effect.gen(function* () {
    if (key.keyId === undefined || !Redacted.isRedacted(key.secret)) {
      yield* Effect.logWarning(
        `${label} has no verified key id and secret in state (state from 0.1.x, for example), so Alchemy does not delete it. Delete it in the Convex dashboard.`,
      );
      return undefined;
    }
    return Redacted.value(key.secret);
  });

export interface DeployKeyProps {
  /** Deployment name, such as `project.prodDeploymentName`. */
  readonly deployment: string;
  /**
   * Key name. The provider requests this name, a dash, and a hash of the
   * resource identity, so two resources with one `name` get different keys.
   */
  readonly name: string;
  /** Limits the key to these actions. Convex grants every deployment action when omitted. */
  readonly allowedActions?: readonly DeployKeyAction[];
}

export interface DeployKeyAttributes {
  /** The name Convex lists the key under, such as "ci-3f2a1b0c9d8e". */
  readonly uniqueName: string;
  /** Numeric id of the key in the listing. Undefined in state written by 0.1.x. */
  readonly keyId: number | undefined;
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

      /**
       * `id` is the secret: Convex accepts it, and it matches only the key
       * that this resource created. A second delete answers 404.
       */
      const deleteKey = (deployment: string, secret: string) =>
        retryIdempotentWrite(
          api.requestVoid("delete deploy key", (client) =>
            client.POST("/deployments/{deployment_name}/delete_deploy_key", {
              params: { path: { deployment_name: deployment } },
              body: { id: secret },
            }),
          ),
        );

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
          return entries !== undefined && isKeyListed(entries, output) ? output : undefined;
        }),

        reconcile: Effect.fn(function* ({ fqn, instanceId, news, output }) {
          if (output !== undefined) {
            // The secret cannot be read back. A key that still exists keeps the one in state.
            if (isKeyListed(yield* listKeys(news.deployment), output)) return output;
          }
          const name = requestedKeyName(news.name, fqn, instanceId);
          const { keyId, uniqueName, secret } = yield* createTrackedKey({
            target: `deployment ${news.deployment}`,
            name,
            list: listKeys(news.deployment),
            create: api
              .request("create deploy key", (client) =>
                client.POST("/deployments/{deployment_name}/create_deploy_key", {
                  params: { path: { deployment_name: news.deployment } },
                  body: {
                    name,
                    ...(news.allowedActions === undefined
                      ? {}
                      : { allowedActions: [...news.allowedActions] }),
                  },
                }),
              )
              .pipe(
                Effect.map((body) => Schema.decodeUnknownSync(CreatedDeployKey)(body).deployKey),
              ),
            isCredentialToken: api.isCredentialToken,
          });
          return { uniqueName, keyId, deployment: news.deployment, deployKey: secret };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Only the secret names this key alone: 0.1.x state can hold the
          // listed name of another resource's key.
          const secret = yield* secretToDelete(
            { keyId: output.keyId, secret: output.deployKey },
            `Convex.DeployKey "${output.uniqueName}" on ${output.deployment}`,
          );
          if (secret === undefined) return;
          // 404 DeployKeyNotFound: an earlier attempt or someone else deleted it.
          yield* absentAsUndefined(deleteKey(output.deployment, secret));
        }),
      };
    }),
  );
