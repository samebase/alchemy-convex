# Changelog

## 0.1.0

First release, pinned to `alchemy@2.0.0-beta.80` and Effect 4.

- `Convex.Project`: create, adopt by name with `--adopt`, replace on property change, delete.
- `Convex.DeployKey` and `Convex.PreviewDeployKey`: create, find by unique listed name, replace
  on change, delete by name.
- `Convex.EnvironmentVariable`: set and remove one variable on one deployment through the
  deployment API.
- `Convex.Deploy`: run `npx convex deploy` with a deploy key and expose the deployment URL,
  memoized by content hash.
- Credentials from `CONVEX_ACCESS_TOKEN`, then the Convex CLI login.
