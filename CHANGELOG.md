# Changelog

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
  the key list does not show exactly one key with the requested name. Keys created by 0.1 keep
  working. A key that is the OAuth credential itself fails with `DeployKeyIsCredential` and is
  never kept or deleted.
- `Convex.EnvironmentVariable` and `Convex.DefaultEnvironmentVariable` overwrite an existing value
  that is not in state only with `--adopt`. Their writes run again after a write conflict or a
  5xx answer.
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
