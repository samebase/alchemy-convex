// The provider collection users merge into a stack:
//   providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers())
import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { type Credentials, fromConfig } from "./Credentials.ts";
import { DeployKey, DeployKeyProvider } from "./DeployKey.ts";
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
    Provider.collection([Project, DeployKey, PreviewDeployKey, EnvironmentVariable]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        DeployKeyProvider(),
        PreviewDeployKeyProvider(),
        EnvironmentVariableProvider(),
      ),
    ),
    Layer.provide(ManagementApiLive()),
    Layer.provide(credentials),
    Layer.orDie,
  );
