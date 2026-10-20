# Changelog

## 0.5.0 (2026-10-20)

Alchemy state in Convex. `state: Convex.state()` keeps the stack's state in an `alchemyState`
component that the app mounts from `@samebase/alchemy-convex/convex.config`, in the production
deployment of the project, so a stack needs no Cloudflare or S3 store.

- The store calls the component the way `convex run --component` does, so Convex checks the key:
  `CONVEX_STATE_DEPLOY_KEY`, a production deploy key with `deployment:data:view` and
  `deployment:data:write`, on every run including preview runs. A preview run can therefore read
  and write production tables; it cannot push code or change variables.
- First run: with no component on the deployment, writes stay in memory until the deployment push
  installs it, then they are written. A run that ends with unsaved state fails.
- No lock: keep one CI concurrency group per stage.
- The rows hold the JSON text Alchemy writes to local state files; nothing is re-encoded.

## 0.4.1 (2026-10-20)

Current dependencies. The code and the resources do not change.

- Peer dependency `alchemy`: `2.0.0-beta.80` to `2.0.0-beta.83`. Upgrade Alchemy together with
  this version. The `effect` and `@effect/platform-node` peer ranges stay `^4.0.0`.
- Use one version for `effect` and for each `@effect/*` package. `@effect/platform-node-shared`
  4.0.5 imports `make` from `effect/Path`, and `effect` 4.0.3 does not have it. Alchemy then
  cannot load `@effect/platform-node` and stops.

Development dependencies, the versions that this release is tested with:

| Package                  | From              | To            |
| ------------------------ | ----------------- | ------------- |
| `effect`                 | 4.0.0             | 4.0.4         |
| `@effect/platform-node`  | 4.0.0             | 4.0.4         |
| `@effect/vitest`         | 4.0.0             | 4.0.4         |
| `alchemy`                | 2.0.0-beta.80     | 2.0.0-beta.83 |
| `vite-plus`              | 0.3.0             | 1.1.0         |
| `vitest`                 | ^4.0.0 (4.1.11)   | 5.0.3         |
| `typescript`             | ^5.9.0 (5.9.3)    | 6.0.3         |
| `@types/node`            | ^24.0.0 (24.19.1) | 24.19.2       |
| `convex`                 | ^1.45.0 (1.46.0)  | 1.46.0        |
| `@arethetypeswrong/core` | ^0.18.5           | 0.18.5        |
| `publint`                | ^0.3.25           | 0.3.25        |
| `packageManager`         | pnpm 11.18.0      | pnpm 11.28.5  |

- Every development dependency now has an exact version. The lockfile has one version of each
  `effect` and `@effect/*` package (4.0.4).
- `pnpm-workspace.yaml` sets `minimumReleaseAge` to 7 days, the rule of `renovate.json`. pnpm
  checks each lockfile entry against it.
- `pnpm-workspace.yaml` overrides `vite` and `vitest` with the versions that `vite-plus` bundles.
  Then `vp test`, `@effect/vitest`, and `alchemy/Test/Vitest` use one Vitest copy. With two
  copies, the tests stop with "Vitest failed to find the current suite".

Not updated:

- `effect` and `@effect/*` 4.0.5, `convex` 1.47.0, `vite-plus` 1.2.0 and 1.3.0, and pnpm 11.28.6:
  released less than 7 days ago.
- `vitest` 5.0.4: `vite-plus` 1.1.0 bundles 5.0.3, and the tests need one Vitest copy.
- `typescript` 7.0.2: `vp pack` emits declarations with TypeScript 7 only through an experimental
  API and fails the build.
- `@types/node` 26: this package runs on Node 24 (`.node-version`) and Node 22 (`engines`).
- pnpm 12: a major version. It gets its own pull request.

## 0.4.0 (2026-10-20)

The Convex plane. `Convex.Deployment` now owns the push, so no deploy key goes from one resource to
another and nothing is shaped for Workers Builds. Breaking: see the removed resources.

- `Convex.Deployment` takes `project` (a `Convex.Project` or `{ projectId }`) in place of
  `projectId`, and optional `source` and `env`. `source` is the Convex functions directory. The
  update sets `env`, then runs the installed `convex deploy`. A hash of the source files,
  package.json, convex.json, the lockfile, the deployment name, and `env` is the content identity:
  the same hash is a no-op. New outputs: `hash` and `envNames`.
- The hash covers every file of the app that git does not ignore. `source: { path, command,
  include }` runs a push command, such as `convex-hosting deploy --build ...`, with the key in
  `CONVEX_DEPLOY_KEY`, and `include` narrows the hash. `source` must be the functions directory
  of convex.json (`SourceMismatch`).
- A failed push sets the changed variables back and deletes a dev or preview deployment that the
  same run created. A production deployment with code that is not in state needs `--adopt`.
- With the access token, each push uses a deploy key that expires after two hours and is deleted
  after the push. With `CONVEX_DEPLOY_KEY`, a deploy key of the deployment or a preview deploy key
  of the project pushes with no access token.
- `Convex.Project` takes `{ team, slug }` for an existing project, found with the official
  `GET /teams/{team}/projects/{slug}`. It never creates or renames that project.
- Credentials: `fromValues({ accessToken?, deployKey? })` replaces `fromToken`. `fromConfig` also
  reads `CONVEX_DEPLOY_KEY`.
- Removed: `Convex.Code`, `Convex.Deploy`, `Convex.DeployKey`, `Convex.PreviewDeployKey`,
  `Convex.EnvironmentVariable`, and `Convex.DefaultEnvironmentVariable`. This version has no
  provider for them. Before you upgrade, remove them from the stack and deploy once with 0.3. That
  deploy revokes the keys of removed key resources, so do it only after nothing uses those keys. To
  keep a key or a variable, delete its state record with `alchemy state rm` instead. Then put
  `source` and `env` on the `Convex.Deployment`.

## 0.3.0

One Alchemy stack can now own a Convex app end to end: it creates the deployment, pushes the
functions, and gives the URLs to a Cloudflare Worker or a Vite site.

- `Convex.Deployment`: `{ projectId, type: "prod" }` takes over the project's default production
  deployment, and follows it when another production deployment becomes the default. `{ projectId, type: "dev" | "preview", name }` creates a dev deployment with `name` as
  its reference, or a preview deployment with `name` as its preview name, through
  `POST /projects/{project_id}/create_deployment`. Outputs `name`, `url`, `siteUrl`, `type`,
  `projectId`, `reference`, and `previewName`.
- `Convex.Deployment` keeps every deployment by default (removal policy `retain`) and never deletes
  a production deployment: delete reads the live type first. A dev or preview deployment that is not in state is taken over only
  with `--adopt`, and the resource never creates over it. A change of `projectId`, `type`, or
  `name` stops the deploy with `DeploymentIdentityChange`. An expired preview deployment is
  created again on the next deploy.
- `Convex.Code`: pushes the functions with the `convex` package that `cwd` resolves, on every
  deploy. The deploy key goes only into an env file with mode 0600 that is removed after the run.
  The CLI output stays out of the logs, and a failure shows its last lines without the key. The
  key must fit the deployment before the push, and the CLI must name the same deployment after
  it. A preview deploy key pushes with `--preview-name`. `env` sets deployment variables before
  the push. Outputs `url`, `siteUrl`, `deploymentName`, `deployedAt`, and `envNames`.
- `Convex.Deploy` is deprecated. It keeps working, so that stacks and state from 0.1 and 0.2 do not
  break. Use `Convex.Code` with a `Convex.Deployment`.
- `parseDeployOutput` moves to `Convex.Code`. The export from the package stays the same.

## 0.2.0

Data safety release. An accident can no longer delete a Convex project or its data, revoke the
wrong deploy key, or overwrite an environment variable.

- `Convex.Project` keeps the project by default (removal policy `retain`). To delete the project
  with the resource, add `RemovalPolicy.destroy()`. State from 0.1 records `destroy`: run one
  deploy with 0.2 before you remove a project or run `alchemy destroy`.
- `Convex.Project` never replaces a project. A `name` change renames it in place with
  `PATCH /projects/{project_id}`. A `team`, `deploymentType`, or `deploymentRegion` change stops
  the deploy with `ProjectTeamChange` or `ProjectDeploymentChange`.
- `Convex.Project` with state uses only the project id in state. The name lookup reads all pages,
  matches the exact name, fails with `AmbiguousProject` for two matches, and takes a project over
  only with `--adopt`.
- `Convex.DeployKey` and `Convex.PreviewDeployKey` request a name that is unique to each resource:
  the `name` prop, a dash, and 12 hex characters of a hash of the resource identity. They store
  the numeric key id, delete only by the secret, and fail with `DeployKeyRecoveryRequired` when
  the key list does not show exactly one key with the requested name. A key that is the OAuth
  credential itself fails with `DeployKeyIsCredential` and is never kept or deleted. Keys created
  by 0.1 keep working, but 0.2 does not delete them: delete them in the Convex dashboard when you
  remove or replace them.
- `Convex.EnvironmentVariable` and `Convex.DefaultEnvironmentVariable` overwrite an existing value
  that is not in state only with `--adopt`. Their writes run again after a write conflict or a
  5xx answer, and a create checks again before each attempt. `EnvironmentVariable` keeps the
  deploy key of its deployment in the outputs, and read and delete use it.
- A change of a variable's `name` or `deployment` (a default's `projectId`, `name`, or
  `deploymentType`) stops the deploy with `VariableIdentityChange`. In 0.1 it replaced the
  resource. To rename or move a variable, create a new resource with a new logical id and remove
  the old one. A replacement or a rename in place needs a cleanup step that can fail and leave a
  variable or a revoked deploy key behind, so 0.2 has neither.
- `Convex.Deploy` always pushes a preview deploy (`previewName` or `previewCreate`), because a
  preview deployment can expire.
- Expected failures are typed errors that name the fix, not defects.

## 0.1.0

First release, pinned to `alchemy@2.0.0-beta.80` and Effect 4.

- `Convex.Project`: create, adopt by name with `--adopt`, replace on property change, delete.
- `Convex.DeployKey` and `Convex.PreviewDeployKey`: create, find by unique listed name, replace
  on change, delete by name.
- `Convex.EnvironmentVariable`: set and remove one variable on one deployment through the
  deployment API.
- `Convex.DefaultEnvironmentVariable`: project defaults that new deployments of a type inherit,
  such as auth keys for every preview deployment.
- `Convex.Deploy`: run `npx convex deploy` with a deploy key and expose the deployment URL,
  memoized by content hash.
- Credentials from `CONVEX_ACCESS_TOKEN`, then the Convex CLI login.
