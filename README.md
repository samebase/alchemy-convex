# @samebase/alchemy-convex

Convex resources for [Alchemy v2](https://alchemy.run): projects, deploy keys, environment
variables, and a deploy step that hands the deployment URL to your frontend build. The Convex CLI
keeps doing typecheck, codegen, bundling, and the code push. This package manages the control
plane around it.

Status: 0.1, pinned to `alchemy@2.0.0-beta.80` and Effect 4. Alchemy ships breaking changes
between betas; upgrade this package and Alchemy together.

## Install

```sh
pnpm add -D @samebase/alchemy-convex alchemy@2.0.0-beta.80 effect@^4.0.0 @effect/platform-node@^4.0.0 convex
```

## Credentials

The provider calls the [Convex Management API](https://docs.convex.dev/management-api) with a
bearer token. By default it looks for `CONVEX_ACCESS_TOKEN` through the stack's config provider
(process env, `.env`, stack secrets) and then falls back to the token the Convex CLI saved after
`npx convex login` (`~/.convex/config.json`). A developer who is logged in needs no setup. CI sets
the variable to a team access token.

To pass a token explicitly:

```ts
Convex.providers(Convex.fromToken(Redacted.make(process.env.MY_TOKEN ?? "")));
```

A team access token is team wide. Deploy keys created by this provider are scoped to one
deployment or one project.

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

    return { url: site.url, backendUrl: backend.url };
  }),
);
```

Order follows the outputs: the project exists before its key, the key before the deploy, the
deploy before the frontend build that embeds the URL.

## Resources

- `Convex.Project`: `{ team: slug | id, name, deploymentRegion?, deploymentType? }`. Creates a
  project with its default deployment. Outputs `projectId`, `slug`, `teamId`,
  `prodDeploymentName`, `prodDeploymentUrl`. There is no project update API, so a changed property
  replaces the project. An existing project with the same name is adopted only with `--adopt`.
  Deleting the resource deletes the project and all of its deployments and data.
- `Convex.DeployKey`: `{ deployment, name, allowedActions? }`. Outputs `uniqueName` and the
  `deployKey` secret. Any change replaces the key. The secret is stored in Alchemy state.
- `Convex.PreviewDeployKey`: `{ projectId, name }`. Project-level key for preview deployments.
- `Convex.EnvironmentVariable`: `{ deployment, deployKey, name, value }`. One variable on one
  deployment, set through the deployment API.
- `Convex.Deploy`: `{ cwd?, env?, deployKey, previewName?, previewCreate?, previewRun?, extraArgs?,
memo? }`. Runs `npx convex deploy` with `CONVEX_DEPLOY_KEY` and parses the deployment URL from the
  CLI output. Outputs `url`, `deploymentName`, `hash`. Memoized by content hash like Alchemy's own
  build steps. Deleting the resource does nothing; the deployment belongs to the project.

Preview stages: give `Convex.Deploy` a `PreviewDeployKey` and `previewName: branch` on pull request
stages, and the production key on `prod`.

## Limits

- Team slugs are resolved through an unofficial dashboard endpoint. Pass the numeric team id to
  avoid it.
- Redacted values (deploy keys, secret env values) are stored in Alchemy state in clear text.
  Use an encrypted or access-controlled state store.
- Not covered: dev deployments, custom domains, log streams, teams and members, components,
  snapshots.

## Development

```sh
pnpm install
pnpm run check            # format, lint, typecheck, unit tests
pnpm run test:live        # ALCHEMY_CONVEX_LIVE=1, uses the Convex CLI login
```

Live tests create resources named `tmp-alchemy-convex-*` in team `samebase-live-tests` and remove
them again.

License: Apache 2.0.
