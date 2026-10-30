// Convex.HubClient: one deployment of an app as a client of the identity hub
// of its team.
//
// The hub is the production deployment of the project `identity-hub` of the team.
// It has the internal functions of `@samebase/identity-broker` in its module
// `identityBroker`. This resource finds the project by name and runs those
// functions with a short-lived key, so a stack that has the Convex credential
// of the team needs no other credential and no hub address. The hub answers
// with its issuer and the client.
//
// The hub keeps only the hash of the secret, so the state is the only record
// of it. A client belongs to one redirect URI: another URI is a new client. A
// change of `app` updates the stored props and does not move the client: the
// app is the identity of the users of the app, and it does not change. The
// team does not change either: the state of a stack is in its team.
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ManagementApi, type ManagementApiService } from "./ManagementApi.ts";
import { findProjectByName, prodDeploymentOf } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import { withPushKey } from "./Push.ts";
import { type FunctionApi, makeFunctionApi, RUN_KEY_ACTIONS } from "./State.ts";

/** The name of the project of the hub in each team. */
export const HUB_PROJECT_NAME = "identity-hub";

export type HubDeploymentType = "production" | "development" | "preview";

export interface HubClientProps {
  /** The Convex team, a slug or an id, whose project `identity-hub` holds the hub. */
  readonly team: string | number;
  /** The app on the hub, such as `scout`. The first client of an app creates it, as a first-party app. */
  readonly app: string;
  /** The deployment's callback URL, such as `<deployment site URL>/auth/hub/callback`. */
  readonly redirectUri: string;
  readonly deploymentType: HubDeploymentType;
  /** The name the hub records for the client. */
  readonly clientName: string;
  /** Recorded on the hub's client, such as the commit. The hub records "unknown" without it. */
  readonly softwareVersion?: string;
}

export interface HubClientAttributes {
  /** The issuer of the hub, which the deployment names to sign in. */
  readonly issuer: string;
  readonly redirectUri: string;
  readonly deploymentType: HubDeploymentType;
  /** The name the client was registered with. */
  readonly clientName: string;
  readonly clientId: string;
  /** Returned by the hub only at registration. */
  readonly clientSecret: Redacted.Redacted<string>;
}

export type HubClient = Resource<
  "IdentityHub.Client",
  HubClientProps,
  HubClientAttributes,
  never,
  Providers
>;
export const HubClient = Resource<HubClient>("IdentityHub.Client");

/** The hub of the team could not do the call. The reason is the Convex message: it holds no secret. */
export class HubClientFailed extends Schema.TaggedError<HubClientFailed>()("HubClientFailed", {
  team: Schema.Union([Schema.String, Schema.Number]),
  reason: Schema.String,
}) {
  override get message() {
    return `Convex.HubClient: the hub of team ${this.team}: ${this.reason}.`;
  }
}

/** The reply of `identityBroker:registerClient`. */
const Registered = Schema.Struct({
  issuer: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
});

/** Runs `use` with the function API of the hub of `team`, with a key of this call only. */
const withHub = <A, E, R>(
  api: ManagementApiService,
  team: string | number,
  use: (functions: FunctionApi) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const teamId = yield* api.resolveTeamId(team);
    const project = yield* findProjectByName(api, teamId, HUB_PROJECT_NAME);
    if (project === undefined) {
      return yield* new HubClientFailed({
        team,
        reason: `no project ${HUB_PROJECT_NAME}, which holds the hub`,
      });
    }
    const deployment = yield* prodDeploymentOf(api, project.id);
    if (deployment === undefined) {
      return yield* new HubClientFailed({
        team,
        reason: `project ${HUB_PROJECT_NAME} has no production deployment`,
      });
    }
    return yield* withPushKey(api, deployment.name, RUN_KEY_ACTIONS, (key) =>
      use(makeFunctionApi(deployment.deploymentUrl, key)),
    );
  });

/** One internal function of the hub: its value, or the Convex message as an error. */
const runHub = (
  functions: FunctionApi,
  team: string | number,
  name: string,
  args: Record<string, string>,
) =>
  functions.call(`identityBroker:${name}`, args).pipe(
    Effect.mapError((error) => new HubClientFailed({ team, reason: error.message })),
    Effect.flatMap((reply) =>
      reply.status === "success"
        ? Effect.succeed(reply.value)
        : Effect.fail(new HubClientFailed({ team, reason: reply.errorMessage.trim() })),
    ),
  );

/**
 * Registers one client. An attempt that a lost reply repeats leaves one spare
 * client on the hub, which signs nobody in.
 */
export const registerHubClient = (api: ManagementApiService, props: HubClientProps) =>
  withHub(api, props.team, (functions) =>
    runHub(functions, props.team, "registerClient", {
      appId: props.app,
      redirectUri: props.redirectUri,
      deploymentType: props.deploymentType,
      clientName: props.clientName,
      softwareVersion: props.softwareVersion ?? "unknown",
      // Convex Auth's generic OAuth method posts the client credentials in the body.
      tokenEndpointAuthMethod: "client_secret_post",
    }),
  ).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(Registered)(value).pipe(
        Effect.mapError(
          () => new HubClientFailed({ team: props.team, reason: "registerClient gave no client" }),
        ),
      ),
    ),
    Effect.map(({ issuer, clientId, clientSecret }) => ({
      issuer,
      clientId,
      clientSecret: Redacted.make(clientSecret),
    })),
  );

const unregister = (api: ManagementApiService, team: string | number, clientId: string) =>
  withHub(api, team, (functions) => runHub(functions, team, "deleteClient", { clientId }));

/** True when the client in state serves the redirect URI and deployment type of `props`. */
const registeredFor = (output: HubClientAttributes, props: HubClientProps) =>
  output.redirectUri === props.redirectUri && output.deploymentType === props.deploymentType;

export const HubClientProvider = () =>
  Provider.effect(
    HubClient,
    Effect.gen(function* () {
      const api = yield* ManagementApi;
      return {
        diff: ({ news, olds, output }) =>
          Effect.succeed(
            // Props that are unresolved at plan time, such as a redirectUri from a deployment that
            // this run creates, are compared in reconcile.
            !isResolved(news) || output === undefined
              ? undefined
              : !registeredFor(output, news)
                ? ({ action: "replace" } as const)
                : olds.team === news.team && olds.app === news.app
                  ? ({ action: "noop" } as const)
                  : ({ action: "update" } as const),
          ),

        read: ({ output }) => Effect.succeed(output),

        reconcile: Effect.fn(function* ({ news, output }) {
          if (output !== undefined && registeredFor(output, news)) return output;
          const client = yield* registerHubClient(api, news);
          // An update whose props were unresolved at plan time registers in place of a
          // replacement. The new client is returned whatever happens to the old one.
          if (output !== undefined) {
            yield* unregister(api, news.team, output.clientId).pipe(
              Effect.catchTag("HubClientFailed", (error) =>
                Effect.logWarning(
                  `Client ${output.clientId} stays on the hub: ${error.message} Delete it with \`npx convex run --prod identityBroker:deleteClient\`.`,
                ),
              ),
            );
          }
          return {
            ...client,
            redirectUri: news.redirectUri,
            deploymentType: news.deploymentType,
            clientName: news.clientName,
          };
        }),

        delete: ({ olds, output }) =>
          unregister(api, olds.team, output.clientId).pipe(Effect.asVoid),
      };
    }),
  );

export interface DevelopmentClientOptions {
  readonly team: string | number;
  readonly app: string;
  /** The path of the hub's callback after the site URL of the deployment. */
  readonly callbackPath: string;
  /** Runs the Convex CLI on the deployment of this directory, and answers its output. */
  readonly convex: (args: readonly string[], input?: string) => string;
}

/** The variables that a deployment reads to sign in through the hub. */
const HUB_VARIABLES = ["HUB_ISSUER", "HUB_CLIENT_ID", "HUB_CLIENT_SECRET"];

/**
 * `alchemy-convex hub-client`: a stack deploys production and previews, and this covers the
 * development deployment, which no stack deploys. A deployment with all three variables keeps
 * them. So a deployment that holds placeholder values for a checkout without a hub is left alone.
 * The secret reaches the Convex CLI on standard input, never in its arguments.
 */
export const registerDevelopmentClient = (options: DevelopmentClientOptions) =>
  Effect.gen(function* () {
    const { convex } = options;
    const names = convex(["env", "list", "--names-only"]).split("\n");
    if (HUB_VARIABLES.every((name) => names.includes(name))) return undefined;
    const siteUrl = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))(
      convex(["run", "--inline-query", "process.env.CONVEX_SITE_URL"]),
    ).pipe(
      Effect.mapError(
        () => new HubClientFailed({ team: options.team, reason: "no CONVEX_SITE_URL to register" }),
      ),
    );
    const callbackUrl = `${siteUrl.replace(/\/$/, "")}${options.callbackPath}`;
    const client = yield* registerHubClient(yield* ManagementApi, {
      team: options.team,
      app: options.app,
      redirectUri: callbackUrl,
      deploymentType: "development",
      clientName: "development",
      softwareVersion: new URL(siteUrl).host,
    });
    // One request, so that an interrupted run cannot leave half a client. `--force` replaces the
    // values of an earlier one.
    convex(
      ["env", "set", "--force"],
      `HUB_ISSUER='${client.issuer}'\nHUB_CLIENT_ID='${client.clientId}'\nHUB_CLIENT_SECRET='${Redacted.value(client.clientSecret)}'\n`,
    );
    return callbackUrl;
  });
