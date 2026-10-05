# @samebase/alchemy-convex

Convex resources for [Alchemy v2](https://alchemy.run): projects, deploy keys, environment
variables, project default environment variables, and a deploy step that hands the deployment URL
to your frontend build. The Convex CLI keeps doing typecheck, codegen, bundling, and the code push.
This package manages the control plane around it.

Alchemy has no built-in Convex provider ([alchemy-run/alchemy-async#1306](https://github.com/alchemy-run/alchemy-async/issues/1306)).
This is a community provider, maintained by [Samebase](https://samebase.com).

Status: 0.1, pinned to `alchemy@2.0.0-beta.80` and Effect 4. Alchemy ships breaking changes
between betas; upgrade this package and Alchemy together. Verified end to end on a Vite app with a
Cloudflare Worker: production on `main`, a Convex preview deployment plus a Worker Preview per pull
request, destroy on close.

## Install

```sh
pnpm add -D @samebase/alchemy-convex alchemy@2.0.0-beta.80 effect@^4.0.0 @effect/platform-node@^4.0.0 convex
```

## Credentials

The provider calls the [Convex Management API](https://docs.convex.dev/management-api) with a
bearer token. By default it reads `CONVEX_ACCESS_TOKEN` through the stack's config provider
(process env, `.env`, stack secrets) and then falls back to the token the Convex CLI saved after
`npx convex login` (`~/.convex/config.json`). A developer who is logged in needs no setup. CI sets
the variable to a team access token.

To pass a token explicitly:

```ts
Convex.providers(Convex.fromToken(Redacted.make(token)));
```

A team access token is team wide. The deploy keys this provider creates are scoped to one
deployment or one project, and those are what CI deploys with.

## Example

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Convex from "@samebase/alchemy-convex";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const project = yield* Convex.Project("Backend", {
      team: "my-team",
      name: "my-app",
    });

    const deployKey = yield* Convex.DeployKey("DeployKey", {
      deployment: project.prodDeploymentName.as<string>(),
      name: "alchemy",
    });

    const backend = yield* Convex.Deploy("Backend", {
      cwd: ".",
      deployKey: deployKey.deployKey,
    });

    const site = yield* Cloudflare.Website.StaticSite("Website", {
      command: "npm run build",
      outdir: "dist/client",
      env: { VITE_CONVEX_URL: backend.url },
      assets: { notFoundHandling: "single-page-application" },
    });

    yield* Convex.EnvironmentVariable("SiteUrl", {
      deployment: backend.deploymentName,
      deployKey: deployKey.deployKey,
      name: "SITE_URL",
      value: site.url,
    });

    return { url: site.url, backendUrl: backend.url };
  }),
);
```

Order follows the outputs: the project exists before its key, the key before the deploy, the
deploy before the frontend build that embeds the URL.

Preview stages: give `Convex.Deploy` a `PreviewDeployKey` and `previewName: <branch>` on pull
request stages, and the production key on `prod`. Variables that every preview deployment needs,
such as auth keys, go on the project as `DefaultEnvironmentVariable` for `preview`.

## Resources

- `Convex.Project`: `{ team: slug | id, name, deploymentRegion?, deploymentType? }`. Creates a
  project with its default deployment. Outputs `projectId`, `slug`, `teamId`,
  `prodDeploymentName`, `prodDeploymentUrl`. There is no project update API, so a changed property
  replaces the project. An existing project with the same name is adopted only with `--adopt`.
  Deleting the resource deletes the project with all of its deployments and data.
- `Convex.DeployKey`: `{ deployment, name, allowedActions? }`. Outputs `uniqueName` and the
  `deployKey` secret. Any change replaces the key. Keys are never adopted: a key without its secret
  is useless.
- `Convex.PreviewDeployKey`: `{ projectId, name }`. Project-level key for preview deployments.
  Outputs `uniqueName` and `previewDeployKey`.
- `Convex.EnvironmentVariable`: `{ deployment, deployKey, name, value }`. One variable on one
  deployment, set through the deployment API with that deployment's key. An existing variable with
  the same name is adopted and overwritten.
- `Convex.DefaultEnvironmentVariable`: `{ projectId, name, value, deploymentType }`. A project
  default that new deployments of that type inherit. Use it for preview and dev deployments.
- `Convex.Deploy`: `{ cwd?, env?, deployKey, previewName?, previewCreate?, previewRun?, extraArgs?,
memo?, timeout? }`. Runs `npx convex deploy` with `CONVEX_DEPLOY_KEY` set and parses the
  deployment URL from the CLI output. Outputs `url`, `deploymentName`, `hash`. Memoized by content
  hash like Alchemy's own build steps. Deleting the resource does nothing; the deployment belongs to
  the project, and preview deployments expire on Convex's schedule.

## Limits

- Team slugs resolve through an unofficial dashboard endpoint. Pass the numeric team id to avoid
  it.
- Deploy keys and other secret outputs are part of Alchemy state. Alchemy's Cloudflare state store
  encrypts state at rest; the local file store does not.
- A deleted deploy key keeps working on the deployment API for roughly 30 seconds.
- Not covered: dev deployments, custom domains, log streams, teams and members, components,
  snapshots.

## Development

```sh
pnpm install
pnpm run check            # format, lint, typecheck, unit tests
pnpm run build            # lib/ with declarations
pnpm run test:live        # real API calls, see below
```

Unit tests run against recorded Management API payloads in `test/fixtures/management/`. Live tests
need `ALCHEMY_CONVEX_LIVE=1`, a Convex login or `CONVEX_ACCESS_TOKEN`, and a throwaway project.
Point them at yours with `ALCHEMY_CONVEX_LIVE_TEAM`, `ALCHEMY_CONVEX_LIVE_PROJECT_ID`,
`ALCHEMY_CONVEX_LIVE_DEPLOYMENT`, and `ALCHEMY_CONVEX_LIVE_PROJECT_DIR` (a Convex app directory for
the deploy test). They create resources named `tmp-alchemy-convex-*` and remove them again.

Releases: push a `v*` tag; `.github/workflows/release.yml` publishes with npm trusted publishing.

License: Apache 2.0.
