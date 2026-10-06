// The provider collection users merge into a stack:
//   providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers())
import { CommandExecutorLive } from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { type Credentials, fromConfig } from "./Credentials.ts";
import {
  DefaultEnvironmentVariable,
  DefaultEnvironmentVariableProvider,
} from "./DefaultEnvironmentVariable.ts";
import { Deploy, DeployProvider } from "./Deploy.ts";
import { DeployKey, DeployKeyProvider } from "./DeployKey.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import { EnvironmentVariable, EnvironmentVariableProvider } from "./EnvironmentVariable.ts";
import { ManagementApiLive } from "./ManagementApi.ts";
import { PreviewDeployKey, PreviewDeployKeyProvider } from "./PreviewDeployKey.ts";
import { Project, ProjectProvider } from "./Project.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Convex") {}

/**
 * All Convex resource providers. Pass a credentials layer to override the
 * default lookup (`CONVEX_ACCESS_TOKEN`, then the Convex CLI login).
 */
export const providers = (credentials: Layer.Layer<Credentials> = fromConfig()) =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Deployment,
      DeployKey,
      PreviewDeployKey,
      EnvironmentVariable,
      DefaultEnvironmentVariable,
      Deploy,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        DeploymentProvider(),
        DeployKeyProvider(),
        PreviewDeployKeyProvider(),
        EnvironmentVariableProvider(),
        DefaultEnvironmentVariableProvider(),
        DeployProvider(),
      ),
    ),
    Layer.provide(ManagementApiLive()),
    Layer.provide(credentials),
    // Convex.Deploy runs the Convex CLI through Alchemy's command executor.
    Layer.provide(CommandExecutorLive()),
    Layer.orDie,
  );
