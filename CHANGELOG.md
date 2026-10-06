# Changelog

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
