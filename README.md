# @samebase/alchemy-convex

Convex resources for [Alchemy v2](https://alchemy.run): projects, deploy keys, environment
variables, project default environment variables, and a deploy step that hands the deployment URL
to your frontend build. The Convex CLI keeps doing typecheck, codegen, bundling, and the code push.
This package manages the control plane around it.

Alchemy has no built-in Convex provider ([alchemy-run/alchemy-async#1306](https://github.com/alchemy-run/alchemy-async/issues/1306)).
This is a community provider, maintained by [Samebase](https://samebase.com).

Status: 0.2, pinned to `alchemy@2.0.0-beta.80` and Effect 4. Alchemy ships breaking changes
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
    const project = yield* Convex.Project("Project", {
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

## Data safety

Deleting a Convex project deletes all of its deployments and data. This package does not delete,
replace, or overwrite your data by accident:

- `Convex.Project` has the removal policy `retain`. When you remove the resource or run
  `alchemy destroy`, Alchemy forgets the project and Convex keeps it. To delete the project with
  the resource, add `RemovalPolicy.destroy()`:

  ```ts
  yield * Convex.Project("Project", { team, name }).pipe(Alchemy.RemovalPolicy.destroy());
  ```

- A project is never replaced. A change to `name` renames the project in place
  (`PATCH /projects/{project_id}`). The id, the slug, the deployments, and the data stay.
- A change to `team`, `deploymentType`, or `deploymentRegion` stops the deploy with
  `ProjectTeamChange` or `ProjectDeploymentChange`. Convex cannot move a project or change its
  first deployment. Set the old value again, or create a new resource with a new logical id and
  move the data yourself.
- With state, the provider finds the project only by the id in state. Without state, it finds a
  project by its exact name, on all pages of the team's project list, and takes it over only with
  `--adopt`. When two projects have that name, the deploy stops with `AmbiguousProject`.
- Each `DeployKey` and `PreviewDeployKey` requests a name that is unique to the resource: the
  `name` prop, a dash, and a hash of the resource identity. The provider deletes a key only by its
  secret, so it cannot revoke the key of another resource. When the key list does not show
  exactly one key with the requested name, the deploy stops with `DeployKeyRecoveryRequired`,
  which lists the key ids.
- An `EnvironmentVariable` or a `DefaultEnvironmentVariable` that exists but is not in state
  belongs to someone else. The provider overwrites it only with `--adopt`.
- A variable write runs again after a Convex write conflict or a 5xx answer, at most four more
  times. The write sets a value, so a second write has the same result.

Upgrade from 0.1: state from 0.1 records the policy `destroy` for each project. Run
`alchemy deploy` one time with 0.2 while the stack still declares the project. That deploy records
`retain`. Do this before you remove a project from the stack or run `alchemy destroy`.

## Resources

- `Convex.Project`: `{ team: slug | id, name, deploymentRegion?, deploymentType? }`. Creates a
  project with its default deployment. Outputs `projectId`, `slug`, `teamId`,
  `prodDeploymentName`, `prodDeploymentUrl`. A changed `name` renames the project in place. A
  changed `team`, `deploymentRegion`, or `deploymentType` stops the deploy. An existing project
  with the same name is adopted only with `--adopt`. The removal policy is `retain`: only a
  resource with `RemovalPolicy.destroy()` deletes the project with its deployments and data.
- `Convex.DeployKey`: `{ deployment, name, allowedActions? }`. Outputs `uniqueName`, `keyId`, and
  the `deployKey` secret. Any change replaces the key. Delete revokes the key by its secret. Keys
  are never adopted: a key without its secret is useless.
- `Convex.PreviewDeployKey`: `{ projectId, name }`. Project-level key for preview deployments.
  Outputs `uniqueName`, `keyId`, and `previewDeployKey`.
- `Convex.EnvironmentVariable`: `{ deployment, deployKey, name, value }`. One variable on one
  deployment, set through the deployment API with that deployment's key. An existing variable with
  the same name is adopted and overwritten only with `--adopt`.
- `Convex.DefaultEnvironmentVariable`: `{ projectId, name, value, deploymentType }`. A project
  default that new deployments of that type inherit. Use it for preview and dev deployments. An
  existing default with the same name and type is adopted and overwritten only with `--adopt`.
- `Convex.Deploy`: `{ cwd?, env?, deployKey, previewName?, previewCreate?, previewRun?, extraArgs?,
memo?, timeout? }`. Runs `npx convex deploy` with `CONVEX_DEPLOY_KEY` set and parses the
  deployment URL from the CLI output. Outputs `url`, `deploymentName`, `hash`. Memoized by content
  hash like Alchemy's own build steps, except with `previewName` or `previewCreate`: a preview
  deployment can expire, so a preview deploy always pushes. Deleting the resource does nothing;
  the deployment belongs to the project, and preview deployments expire on Convex's schedule.

## Limits

- Team slugs resolve through an unofficial dashboard endpoint. Pass the numeric team id to avoid
  it.
- Deploy keys and other secret outputs are part of Alchemy state. Alchemy's Cloudflare state store
  encrypts state at rest; the local file store does not.
- A deleted deploy key keeps working on the deployment API for roughly 30 seconds.
- A run that stops between a key create and the state write leaves a key that state does not
  know. The next run stops with `DeployKeyRecoveryRequired`. Delete the listed key in the Convex
  dashboard, then run the deploy again.
- Not covered: dev deployments, custom domains, log streams, teams and members, components,
  snapshots.

## Development

```sh
pnpm install
pnpm run check            # format, lint, typecheck, unit tests
pnpm run build            # lib/ with declarations, then publint and attw
pnpm run test:live        # real API calls, see below
```

Use Node 24 (`.node-version`) and pnpm 11. `pnpm install` also installs a pre-commit hook that
runs `vp staged`.

Unit tests run against recorded Management API payloads in `test/fixtures/management/`. Live tests
run only with `ALCHEMY_CONVEX_LIVE=1`, which `pnpm run test:live` sets. They need a Convex login or
`CONVEX_ACCESS_TOKEN`, and a throwaway project.
Point them at yours with `ALCHEMY_CONVEX_LIVE_TEAM`, `ALCHEMY_CONVEX_LIVE_PROJECT_ID`,
`ALCHEMY_CONVEX_LIVE_DEPLOYMENT`, and `ALCHEMY_CONVEX_LIVE_PROJECT_DIR` (a Convex app directory for
the deploy test). They create resources named `tmp-alchemy-convex-*` and remove them again.
A file argument runs one live file only, for example
`pnpm run test:live test/live/safety.live.test.ts`. That test runs the data safety contract
through the Alchemy engine. It creates a project `tmp-alchemy-convex-<8 hex>` in
`ALCHEMY_CONVEX_LIVE_TEAM` and deletes it at the end, also after a failure. It refuses to delete a
project whose name does not start with `tmp-alchemy-convex-`.

Releases: change `version` in `package.json` in a pull request. After the merge,
`.github/workflows/release.yml` publishes that version from `main` with npm trusted publishing.

License: Apache 2.0.
