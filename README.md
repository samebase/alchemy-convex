# @samebase/alchemy-convex

Convex resources for [Alchemy v2](https://alchemy.run): projects, deployments, deploy keys,
environment variables, project default environment variables, and the code push. One Alchemy stack
can own a Convex app end to end: it creates the deployment, pushes the functions, and gives the
deployment URLs to a Cloudflare Worker or a Vite site as ordinary outputs. The Convex CLI that
your app installs keeps doing typecheck, codegen, bundling, and the push.

Alchemy has no built-in Convex provider ([alchemy-run/alchemy-async#1306](https://github.com/alchemy-run/alchemy-async/issues/1306)).
This is a community provider, maintained by [Samebase](https://samebase.com).

Status: 0.3, pinned to `alchemy@2.0.0-beta.80` and Effect 4. Alchemy ships breaking changes
between betas; upgrade this package and Alchemy together. The 0.2 deploy step was verified end to
end on a Vite app with a Cloudflare Worker: production on `main`, a Convex preview deployment plus
a Worker Preview per pull request, destroy on close. `Convex.Deployment` and `Convex.Code` are
verified by a live test with the real Convex CLI: a push to a production deployment and to a
preview deployment, then a delete of the preview.

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
    const project = yield* Convex.Project("Project", { team: 38516, name: "score-four" });
    const prod = yield* Convex.Deployment("Prod", { projectId: project.projectId, type: "prod" });
    const key = yield* Convex.DeployKey("DeployKey", {
      deployment: prod.name,
      name: "alchemy",
      allowedActions: ["deployment:deploy", "deployment:env:view", "deployment:env:write"],
    });
    const backend = yield* Convex.Code("Backend", {
      deployment: prod,
      deployKey: key.deployKey,
      cwd: ".",
    });

    // backend.url and backend.siteUrl feed a Cloudflare Worker or a Vite site.
    const site = yield* Cloudflare.Website.Vite("Site", {
      env: { VITE_CONVEX_URL: backend.url, VITE_CONVEX_SITE_URL: backend.siteUrl },
    });

    return { url: site.url, convexUrl: backend.url };
  }),
);
```

Order follows the outputs: the project exists before its deployment, the deployment before its key,
the key before the push, and the push before the site build. On a Vite Worker, a `VITE_` key in
`env` goes into the client bundle as `import.meta.env.VITE_*` and is also a Worker variable.
`Cloudflare.Worker` takes the same `env`.

### Preview stages

On a pull request stage, push to a preview deployment of the same project. Name the preview after
the stage, and use a preview deploy key of the project:

```ts
const stack = yield * Alchemy.Stack; // stack.stage, such as "pr-42"
// The project that the stage "prod" owns. A preview stage reads it and does not own it.
const project = yield * Convex.Project.ref("Project", { stage: "prod" });
const preview =
  yield *
  Convex.Deployment("Preview", {
    projectId: project.projectId,
    type: "preview",
    name: stack.stage,
  }).pipe(Alchemy.RemovalPolicy.destroy());
const previewKey =
  yield *
  Convex.PreviewDeployKey("PreviewDeployKey", {
    projectId: project.projectId,
    name: "alchemy",
  });
const backend =
  yield *
  Convex.Code("Backend", {
    deployment: preview,
    deployKey: previewKey.previewDeployKey,
    cwd: ".",
  });
```

`alchemy destroy --stage pr-42` then deletes the preview deployment. Without
`RemovalPolicy.destroy()`, the preview deployment stays until Convex deletes it at expiry (14 days
by default). [`examples/app/alchemy.run.ts`](examples/app/alchemy.run.ts) has both stages in one
stack. Variables that every preview deployment needs, such as auth keys, go on the project as
`DefaultEnvironmentVariable` for `preview`.

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
  which lists the key ids. The provider never revokes a key on a failed create.
- With an OAuth token as the credential, Convex creates no new key: it returns the OAuth token
  with a new prefix. The key resources then stop with `DeployKeyIsCredential` and do not keep that
  value, because a delete would revoke the OAuth token. Use a team access token or the Convex CLI
  login.
- `Convex.Deployment` has the removal policy `retain` for every type. It never deletes a
  production deployment, also not with `RemovalPolicy.destroy()`: delete the project for that. A
  dev or preview deployment is deleted only with `RemovalPolicy.destroy()`.
- `Convex.Deployment` takes over the project's production deployment without `--adopt`: Convex
  creates it with the project, and the resource never changes or deletes it. A dev or preview
  deployment that exists but is not in state belongs to someone else, such as a preview that CI
  made with `npx convex deploy --preview-name`. The resource takes it over only with `--adopt`.
  It never creates over it: a Convex create for an existing preview name deletes that preview.
- A deployment keeps its `projectId`, `type`, and `name`. A change stops the deploy with
  `DeploymentIdentityChange`. The resource is never replaced.
- `Convex.Code` checks before the push that the deploy key fits the deployment, and after the push
  that the CLI pushed to that deployment. A production deploy key on a preview stage stops the deploy
  before the push.
- An `EnvironmentVariable` or a `DefaultEnvironmentVariable` that exists but is not in state
  belongs to someone else. The provider overwrites it only with `--adopt`. The same is true for a
  `Convex.Code` `env` variable that exists with another value.
- A variable keeps its name and deployment (a default keeps its project, name, and deployment
  type). A change stops the deploy with `VariableIdentityChange`. To rename or move a variable,
  create a new resource with a new logical id and remove the old one. A rename in place would
  need a cleanup step that can fail and leave a variable or a revoked deploy key behind.
- A variable write runs again after a Convex write conflict or a 5xx answer, at most four more
  times. The write sets a value, so a second write has the same result.

Upgrade from 0.2: `Convex.Deploy` keeps working. To move to `Convex.Code`, add a
`Convex.Deployment` and a `Convex.Code` with a new logical id and remove the `Convex.Deploy`.
Removing `Convex.Deploy` changes nothing in Convex. For a preview stage, use `previewName`, not
`previewCreate`, while you still use `Convex.Deploy`.

Upgrade from 0.1: state from 0.1 records the policy `destroy` for each project. Run
`alchemy deploy` one time with 0.2 while the stack still declares the project. That deploy records
`retain`. Do this before you remove a project from the stack or run `alchemy destroy`.
Deploy keys from 0.1 state keep working, but 0.2 does not delete them: their state cannot show that
the secret is a new key and not an OAuth token. When you remove or replace such a key, delete it in
the Convex dashboard.

## Resources

- `Convex.Project`: `{ team: slug | id, name, deploymentRegion?, deploymentType? }`. Creates a
  project with its default deployment. Outputs `projectId`, `slug`, `teamId`,
  `prodDeploymentName`, `prodDeploymentUrl`. A changed `name` renames the project in place. A
  changed `team`, `deploymentRegion`, or `deploymentType` stops the deploy. An existing project
  with the same name is adopted only with `--adopt`. The removal policy is `retain`: only a
  resource with `RemovalPolicy.destroy()` deletes the project with its deployments and data.
- `Convex.Deployment`: `{ projectId, type: "prod" }` or
  `{ projectId, type: "dev" | "preview", name }`. Outputs `name` (such as `happy-animal-123`),
  `url` (`https://<name>.convex.cloud`, with the region outside US East), `siteUrl` (the same
  host on `.convex.site`), `type`, `projectId`, `reference`, and `previewName`.
  - `prod` takes over the project's default production deployment. It never creates one: a
    project without one stops the deploy with `ProductionDeploymentNotFound`.
  - `dev` creates a dev deployment with `name` as its reference, through
    `POST /projects/{project_id}/create_deployment`. Convex records the member of the access token
    as its creator. It is not that member's default dev deployment, so `npx convex dev` does not
    select it.
  - `preview` creates a preview deployment with `name` as its preview name, through the same
    call. `npx convex deploy --preview-name <name>` with a preview deploy key finds it.
  - When the deployment in state is gone, such as an expired preview, the next deploy creates it
    again. Two deployments with the name stop the deploy with `AmbiguousDeployment`.
- `Convex.Code`: `{ deployment, deployKey, cwd, command?, env?, typecheck?, codegen? }`. Pushes
  the functions of the Convex app in `cwd` with `convex deploy`. Outputs `deploymentName`,
  `url`, `siteUrl`, `deployedAt` (milliseconds since the Unix epoch), and `envNames`.
  - `deployment` is a `Convex.Deployment` resource or a deployment name. `deployKey` is a
    deploy key of that deployment, or, for a preview deployment, a preview deploy key of the
    project: Code then runs `convex deploy --preview-name <name>`. Any other key stops the deploy
    with `DeployKeyMismatch` before the push.
  - Code pushes on every deploy. It does not hash the sources: a preview can expire, a push from
    outside Alchemy can change the deployment, and a hash misses workspace packages. The CLI
    uploads only the modules that changed.
  - Code runs the `convex` package that `cwd` resolves, with the Node.js that runs Alchemy, and
    never downloads one (`ConvexCliNotFound`). `command`, such as `["pnpm", "exec", "convex"]`,
    replaces it.
  - The key goes to the CLI only in an env file with mode 0600 (`--env-file`), in a temporary
    directory that is removed after the run, also after a failure or an interruption. That
    directory is the home directory of the CLI, so the CLI cannot use the Convex login of the
    machine. Variables named `CONVEX_*` are not passed on.
  - The CLI output stays out of the logs. A failure (`CodePushFailed`) shows the last 20 lines
    with the key removed. A push to another deployment stops the deploy with
    `PushTargetMismatch`.
  - `env` sets variables on the deployment before the push, with the deploy key. A name that
    leaves `env` is removed from the deployment. A preview deploy key cannot set variables
    (`EnvironmentNeedsDeployKey`).
  - `typecheck` (`enable`, `try`, `disable`) and `codegen` (`enable`, `disable`) go to
    `convex deploy` as flags.
  - Deleting the resource does nothing. The functions and the `env` variables stay: the deployment
    runs them.
- `Convex.DeployKey`: `{ deployment, name, allowedActions? }`. Outputs `uniqueName`, `keyId`, and
  the `deployKey` secret. Any change replaces the key. Delete revokes the key by its secret; a key
  from 0.1 state stays. Keys are never adopted: a key without its secret is useless. A key for
  `Convex.Code` needs at least `deployment:deploy`, and `deployment:env:view` and
  `deployment:env:write` for `env`.
- `Convex.PreviewDeployKey`: `{ projectId, name }`. Project-level key for preview deployments.
  Outputs `uniqueName`, `keyId`, and `previewDeployKey`.
- `Convex.EnvironmentVariable`: `{ deployment, deployKey, name, value }`. One variable on one
  deployment, set through the deployment API with that deployment's key. An existing variable with
  the same name is adopted and overwritten only with `--adopt`. A new `value` or `deployKey` is an
  update in place. A new `name` or `deployment` stops the deploy with `VariableIdentityChange`:
  use a new logical id. Outputs `deployment`, `name`, and `deployKey`. Read and delete use the
  deploy key in the outputs, not the props.
- `Convex.DefaultEnvironmentVariable`: `{ projectId, name, value, deploymentType }`. A project
  default that new deployments of that type inherit. Use it for preview and dev deployments. An
  existing default with the same name and type is adopted and overwritten only with `--adopt`. A
  new `value` is an update in place. A new `projectId`, `name`, or `deploymentType` stops the
  deploy with `VariableIdentityChange`: use a new logical id.
- `Convex.Deploy` (deprecated since 0.3, use `Convex.Code`): `{ cwd?, env?, deployKey,
previewName?, previewCreate?, previewRun?, extraArgs?, memo?, timeout? }`. Runs
  `npx convex deploy` with `CONVEX_DEPLOY_KEY` set and parses the deployment URL from the CLI
  output. Outputs `url`, `deploymentName`, `hash`. It stays so that stacks and state from 0.1
  and 0.2 keep working. Deleting the resource does nothing.

### Which Convex call each operation uses

| Operation                                | Path                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Find the production deployment           | `GET /projects/{project_id}/list_deployments?deploymentType=prod&isDefault=true`    |
| Find a dev or preview deployment by name | `GET /projects/{project_id}/list_deployments?deploymentType=<type>`                 |
| Create a dev or preview deployment       | `POST /projects/{project_id}/create_deployment` with `type` and `reference`         |
| Check that a deployment exists           | `GET /deployments/{deployment_name}`                                                |
| Delete a dev or preview deployment       | `POST /deployments/{deployment_name}/delete`                                        |
| Push to a deployment                     | `convex deploy --env-file <file>` with a deploy key of the deployment               |
| Push to a preview deployment             | `convex deploy --preview-name <name> --env-file <file>` with a preview deploy key   |
| Set `env` variables                      | `POST https://<deployment>/api/v1/update_environment_variables` with the deploy key |

Code uses `--preview-name`, not `--preview-create`: `--preview-create` deletes and creates the
preview deployment again on every push, so every deploy would lose the preview data and change its
URL.

## Limits

- Team slugs resolve through an unofficial dashboard endpoint. Pass the numeric team id to avoid
  it.
- Deploy keys and other secret outputs are part of Alchemy state. Alchemy's Cloudflare state store
  encrypts state at rest; the local file store does not.
- A deleted deploy key keeps working on the deployment API for roughly 30 seconds.
- A run that stops between a key create and the state write leaves a key that state does not
  know. The next run stops with `DeployKeyRecoveryRequired`. Delete the listed key in the Convex
  dashboard, then run the deploy again.
- A run that stops between a deployment create and the state write leaves a dev or preview
  deployment that state does not know. The next run stops with `OwnedBySomeoneElse`. Run it with
  `--adopt` to take that deployment over.
- Between the lookup and the create of a preview deployment, another writer can create a preview
  with the same name. The Convex create then replaces it. The Management API has no create that
  fails for an existing preview name.
- `siteUrl` is the `.convex.site` URL. A custom domain is not used.
- Variables that `Convex.Code` set on a deployment stay there when `deployment` changes to
  another deployment, and when the resource is removed.
- Not covered: deployment regions and classes, custom domains, log streams, teams and members,
  components, snapshots.

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
`test/live/deployment-code.live.test.ts` does the same for `Convex.Deployment` and
`Convex.Code`: it pushes the app in `test/fixtures/convex-app` with the real Convex CLI to the
production deployment and to a preview deployment, and it also refuses to delete a deployment of
another project.

Releases: change `version` in `package.json` in a pull request. After the merge,
`.github/workflows/release.yml` publishes that version from `main` with npm trusted publishing.

License: Apache 2.0.
