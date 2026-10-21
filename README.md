# @samebase/alchemy-convex

The Convex plane for [Alchemy v2](https://alchemy.run): projects, deployments, their environment
variables, and the push of the functions. One Alchemy stack owns a Convex app end to end. The
deployment resource pushes your `convex/` folder when its content changes and gives the deployment
URLs to a Cloudflare Worker or a Vite site as ordinary outputs. No deploy key goes from one resource
to another. The Convex CLI that your app installs keeps doing typecheck, codegen, bundling, and the
push.

Alchemy has no built-in Convex provider ([alchemy-run/alchemy-async#1306](https://github.com/alchemy-run/alchemy-async/issues/1306)).
This is a community provider, maintained by [Samebase](https://samebase.com). The resource model
follows the "Convex Plain" mode of [rjdellecese/confect#408](https://github.com/rjdellecese/confect/issues/408).
[docs/design/convex-plane.md](docs/design/convex-plane.md) records the decisions.

Status: pinned to `alchemy@2.0.0-beta.83` and Effect 4. Alchemy ships breaking changes between
betas; upgrade this package and Alchemy together. A live test runs the full sequence with the real
Convex CLI: create, push, no-op, change, preview, deploy keys alone, and destroy.

## Install

```sh
pnpm add -D @samebase/alchemy-convex alchemy@2.0.0-beta.83 effect@^4.0.0 @effect/platform-node@^4.0.0 convex
```

Use one version for `effect` and for each `@effect/*` package. A mix fails at load time, such as
`@effect/platform-node-shared` 4.0.5 next to `effect` 4.0.3.

## Example

```ts
export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const backend =
      stage === "prod"
        ? yield* Convex.Deployment("Backend", {
            // An existing project. A new one: { team: "my-team", name: "my-app" }.
            project: yield* Convex.Project("Project", { team: "my-team", slug: "my-app" }),
            type: "prod",
            source: "./convex",
            env: { AUTH_SECRET: Config.Redacted("AUTH_SECRET") },
          })
        : yield* Convex.Deployment("Backend", {
            // The project that the stage "prod" owns, read from its state.
            project: yield* Convex.Project.ref("Project", { stage: "prod" }),
            type: "preview",
            name: stage, // such as "pr-42"
            source: "./convex",
          }).pipe(RemovalPolicy.destroy());
    const site = yield* Cloudflare.Website.Vite("Site", {
      env: { VITE_CONVEX_URL: backend.url, VITE_CONVEX_SITE_URL: backend.siteUrl },
    });
    return { url: site.url, convexUrl: backend.url };
  }),
);
```

The imports are `alchemy`, `alchemy/Cloudflare`, `alchemy/RemovalPolicy`, `effect/Config`,
`effect/Effect`, `effect/Layer`, and `@samebase/alchemy-convex` as `Convex`. Order follows the
outputs: the project exists before its deployment, and the push finishes before the site build. The
first `alchemy deploy --stage prod` takes over the existing project, and its production
deployment if it has code, only with `--adopt`.
`alchemy destroy --stage pr-42` deletes the preview deployment. Without `RemovalPolicy.destroy()`,
it stays until Convex deletes it at expiry (14 days by default).
[`examples/app/alchemy.run.ts`](examples/app/alchemy.run.ts) is the same stack.

## Credentials

Credentials are a layer, never props, so they do not go into Alchemy state. `Convex.providers()`
reads them through the stack's config provider (process env, `.env`, stack secrets):

- `CONVEX_ACCESS_TOKEN`, a team access token, for the Management API. Without it, the provider uses
  the token that `npx convex login` saved (`~/.convex/config.json`). `Convex.Project` needs it, and
  so does a deployment that the deploy key does not reach.
- `CONVEX_DEPLOY_KEY`, optional, the same variable that the Convex CLI reads:
  - A deploy key of one deployment (`prod:<name>|...`) sets variables and pushes to that deployment.
    That stage then needs no access token if it passes `project: { projectId }` or a
    `Convex.Project.ref`. The key must have `deployment:data:view` (dashboard keys have all
    actions), because the provider reads the project and type of its deployment first.
  - A preview deploy key of a project (`preview:<team>:<project>|...`) creates, pushes to, and
    deletes preview deployments of that project. It cannot change variables: with `env`, the
    provider uses the access token, and without one it stops with `EnvironmentNeedsDeployKey`
    before it creates anything. Use project default variables in the Convex dashboard for previews.

A key that does not fit the deployment is not used: the provider uses the access token. To pass
values explicitly: `Convex.providers(Convex.fromValues({ accessToken, deployKey }))`.

## State in Convex

`state: Convex.state({ team })` keeps the Alchemy state of every stack and stage of a Convex team in
one project of that team, `alchemy-state`, so a repository holds one secret and a stack can create
and destroy its own project. [docs/design/convex-state.md](docs/design/convex-state.md) records the
decisions and the measurements.

```ts
export default Alchemy.Stack(
  process.env["GITHUB_REPOSITORY"] ?? "my-org/my-app", // the stack name: the repository
  { providers: Convex.providers(), state: Convex.state({ team: "my-team" }) },
  Effect.gen(function* () {
    /* ... */
  }),
);
```

Every run needs the team token in `CONVEX_ACCESS_TOKEN`, or the Convex CLI login on a laptop. A
team access token names its team, so `Convex.state()` needs no `team` with one, and a `team` that
is set is a label; the Convex CLI login needs the slug or the id. The first run of a team creates
the project `alchemy-state` and pushes the store functions to its
production deployment with the Convex CLI of the app; a later version of this package pushes a
newer store when it finds an older one, and never an older one over a newer one. Each run makes a
deploy key of that deployment that can only run the store's internal functions, and deletes it at
the end. Rows are in the tables `resources` and `outputs` in the dashboard, under the stack name.
The store has no lock: run one deploy of a stage at a time, such as with a CI concurrency group.
The names of the store functions are a wire contract: never renamed or removed.

## Resources

- `Convex.Project`: `{ team, name, deploymentRegion?, deploymentType? }` creates a project with its
  default deployment, or takes over one with that exact name with `--adopt`. A changed `name`
  renames the project in place. `{ team, slug }` is an existing project, found by its slug and
  taken over with `--adopt`; it never creates or renames a project. Outputs `projectId`, `slug`,
  `name`, `teamId`, `prodDeploymentName`, `prodDeploymentUrl`.
- `Convex.Deployment`: `{ project, type: "prod" }` or `{ project, type: "dev" | "preview", name }`,
  each with optional `source` and `env`. Outputs `name` (such as `happy-animal-123`), `url`,
  `siteUrl`, `type`, `projectId`, `reference`, `previewName`, `hash`, and `envNames`.
  - `prod` is the project's default production deployment (with a deploy key: the key's
    production deployment). The resource never creates or deletes one. A production deployment
    with code that is not in state is taken over only with `--adopt`.
  - `dev` creates a dev deployment with `name` as its reference; `preview` creates a preview
    deployment with `name` as its preview name. An expired preview is created again on the next
    deploy.
  - `source` is the Convex functions directory: `convex/`, or the `functions` field of
    convex.json (`SourceMismatch`). The CLI runs in the nearest directory above it with a
    package.json, with the Node.js that runs Alchemy, and is never downloaded (`ConvexCliNotFound`).
  - The content identity is a hash of every file of that app directory that git does not ignore,
    the nearest lockfile, the deployment name, and `env`. The same hash is a no-op. Otherwise the
    update sets `env`, then pushes. A failed push sets the changed variables back, and deletes a
    dev or preview deployment that the same run created.
  - `env` values are strings or secrets such as `Config.Redacted("AUTH_SECRET")`. A name that
    leaves `env` is removed from the deployment.
  - `source: { path, command?, include? }` replaces `convex deploy` with `command`, run in the app
    directory with the push key in `CONVEX_DEPLOY_KEY`, such as
    `["node_modules/.bin/convex-hosting", "deploy", "--build", "node_modules/.bin/vp build", "--dist", "dist/client"]`.
    The command must push with `convex deploy` (convex-hosting does, through `--cmd`). `include`
    narrows the hash to `path`, package.json, convex.json, the lockfile, and the listed globs, such
    as the build inputs `["src/**", "public/**", "vite.config.ts"]`. A minted key for a command
    has every action, because the command can do more than a push.

## Data safety

- `Convex.Project` and `Convex.Deployment` have the removal policy `retain`. `alchemy destroy`
  forgets them and Convex keeps them. Add `RemovalPolicy.destroy()` to delete with the resource.
- A project is never replaced. A change of `team`, `slug`, `deploymentType`, or `deploymentRegion`
  stops the deploy with a typed error that names the fix.
- A deployment keeps its `project`, `type`, and `name`; a change stops the deploy with
  `DeploymentIdentityChange`. A production deployment is never deleted, also not with
  `RemovalPolicy.destroy()`, and also not a dev deployment that became one.
- A dev or preview deployment that exists but is not in state belongs to someone else, such as a
  preview that CI made. The resource takes it over only with `--adopt`, and never creates over it:
  a Convex create for an existing preview name deletes that preview.
- With the access token, each push uses a new deploy key with only `deployment:deploy`,
  `deployment:env:view`, and `deployment:env:write`, which expires after two hours and is deleted
  after the push, also after a failure. With an OAuth token, Convex returns the token itself as the
  key, so the delete is skipped. No other key is created or revoked.
- The key reaches the CLI only in an env file with mode 0600, in a temporary home directory that is
  removed after the run. Variables named `CONVEX_*` are not passed on. The CLI output stays out of
  the logs; a failure (`CodePushFailed`) shows the last 20 lines with the key removed. A push to
  another deployment stops the deploy with `PushTargetMismatch`.
- A variable in `env` that exists with another value and that the resource did not set stops the
  deploy with `VariablesOwnedBySomeoneElse`. `--adopt` overwrites it. Destroy leaves variables in
  place: they go with the deployment.
- A variable write runs again after a Convex write conflict or a 5xx answer, at most four more
  times.

## Limits

- `env` values are props, so Alchemy state holds them. Keep `.alchemy/` git-ignored, and use an
  encrypted state store, such as `Cloudflare.state()`, in CI.
- The hash does not see a change in a workspace package outside the app directory, or a push from
  outside Alchemy. Change a file of the app to push again.
- With a deploy key, the provider reaches the deployment at `https://<name>.convex.cloud`, so the
  deployment must answer there.
- A run that stops between a deployment create and the state write leaves a deployment that state
  does not know. The next run stops with `OwnedBySomeoneElse`; run it with `--adopt`.
- Team slugs for `{ team, name }` resolve through an unofficial dashboard endpoint. Pass the numeric
  team id to avoid it. `{ team, slug }` uses the official endpoint.
- Not covered: deployment regions and classes, custom domains, log streams, teams and members,
  components, snapshots.

## Development

```sh
pnpm install
pnpm run check            # format, lint, typecheck, unit tests
pnpm run build            # lib/ with declarations, then publint and attw
pnpm run test:live        # real API calls, see below
```

Use Node 24 (`.node-version`) and pnpm 11. Unit tests run against recorded Management API payloads
in `test/fixtures/management/` and a fake Convex CLI. Live tests run only with
`ALCHEMY_CONVEX_LIVE=1`, which `pnpm run test:live` sets. They need a Convex login or
`CONVEX_ACCESS_TOKEN` that can create projects in `ALCHEMY_CONVEX_LIVE_TEAM`. Each test creates a
project whose name starts with `ALCHEMY_CONVEX_LIVE_PREFIX` (default `tmp-alchemy-convex-`),
deletes it at the end, also after a failure, and refuses to delete a project, or a deployment of a
project, without that prefix. A file argument runs one live file only, for example
`pnpm run test:live test/live/plane.live.test.ts`.

Releases: change `version` in `package.json` in a pull request. After the merge,
`.github/workflows/release.yml` publishes that version from `main` with npm trusted publishing.

License: Apache 2.0. Parts follow Confect; see [NOTICE](NOTICE).
