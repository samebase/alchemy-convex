# Design: the Convex plane

Sources: Confect [#408](https://github.com/rjdellecese/confect/issues/408) ("Convex Plain"),
[rjdellecese/confect#735](https://github.com/rjdellecese/confect/pull/735) (head `9a3eab2`), and
`alchemy@2.0.0-beta.80` (Worker, Neon, `Command.Build`).

Problem: 0.3 is shaped for Workers Builds: keys go to a build outside Alchemy, `Code` takes one.

## Decision: adopt the 408 model, keep our implementation, do not vendor or depend

- Resources: `Convex.Project` and `Convex.Deployment({ project, type, name?, source?, env? })`. The
  push of `source` happens inside the deployment update, and `url` and `siteUrl` flow to other
  resources. Reason: this is the 408 model, and it puts no key between resources.
- Not vendored: 735 keeps a separate `Code` that pushes on every apply (`Code.ts:34`), passes keys
  between resources, creates a new production deployment by reference and can delete it, writes
  Alchemy state through internal APIs (`internal/Lifecycle.ts`), and pins beta.82 and TypeScript 7.
  Our code already has the safety rules that 735 lacks: a production deployment is never created or
  deleted, previews are looked up before a create, and retries handle OCC answers.
- Not a dependency: `@confect/alchemy` is an open PR in the Confect monorepo; its only addition
  over ours is `Confect.Backend` (codegen before the push).
- Kept from 735, with credit in NOTICE: the adoption check order and the CLI runner (an env file
  with mode 0600 in a temporary home directory, the installed `convex` bin, no download).

## Decisions inside the model

- Content identity: the deployment hashes the app's files that git does not ignore and the nearest
  lockfile (Alchemy `hashDirectory`), the deployment name, and `env`. The same hash is a `noop`, as
  for the Worker bundle and Neon `codeHash`. The hash is taken again after the push, so generated
  files (`convex/_generated`, a convex-hosting version file) do not cause a second push. A failed
  push sets the changed variables back and deletes a deployment that the same run created.
- Push credential: no key resource. With the Management API token, each push creates a deploy key
  with three actions and `expiresAt` two hours ahead, and deletes it after the push, also after a
  failure. Reason: no long-lived key in state or outputs. An OAuth token comes back as the key, so
  its delete is skipped.
- Credentials by scope, as a layer and never as props: `CONVEX_ACCESS_TOKEN` (or the CLI login) and
  `CONVEX_DEPLOY_KEY`. Measured on a temporary project: a production deploy key has no Management
  API access, but `deployment_info`, `get_canonical_urls`, and variables work with it; a preview
  deploy key can create, list, get, and delete preview deployments of its project, but cannot create
  a deploy key or change variables. So a deploy key pushes to its own deployment with no token, and
  a preview deploy key runs preview stages with no token and no `env`. The token is needed only to
  create a project or a deployment that a key cannot reach.
- `Project` takes `{ team, slug }` (official `GET /teams/{team}/projects/{slug}`) next to
  `{ team, name }`. Both need `--adopt` for an object not in state.
- A production deployment with code, not in state, needs `--adopt` (an empty one does not).
- Kept invariants: never replace or delete a deployment on an input change (identity errors), retain
  by default, never delete production, ids from state and not URLs, all pages of a listing, OCC
  retries, never revoke a credential that an app runs on (the only key deleted is the push key).
- `env` stays on the deployment and is not a resource: the push needs it first, and destroy does not
  remove variables, so required variables (Convex Auth keys) never block a destroy.
- `source: { path, command, include }` runs a push command such as `convex-hosting deploy --build`
  with the key in `CONVEX_DEPLOY_KEY`; `include` narrows the hash to the inputs. Proven on a copy of
  the convex-hosting tanstack-spa example: deploy and serve, no-op, a changed route redeploys.
- Removed: `Code`, `Deploy`, `DeployKey`, `PreviewDeployKey`, `EnvironmentVariable`,
  `DefaultEnvironmentVariable`.

## Decision: `rootDir` (0.8.0)

Decision (Nicu, 2026-10-22): every deployable resource in a stack has `rootDir`, the app directory
relative to the directory of the stack file, `"."` by default. Everything about the resource is
relative to it. `Convex.Deployment` gets it: the push runs in `rootDir`, `source.path` and
`source.include` are relative to it, and the content hash covers the files under it. Reason: the
Samebase dashboard places each resource under its app folder from the state rows, with one rule for
Workers and Convex deployments, and in a monorepo the stack file moves to the repository root.

- Removed: the rule of 0.3 to 0.7 that the push runs in the nearest directory above `source` with a
  package.json. With it, the app directory came from the file system, not from the props, so a
  reader of the state could not know it. A stack that relied on it sets `rootDir`, such as
  `{ rootDir: "apps/web", source: "./convex" }` for `{ source: "apps/web/convex" }`. Without it,
  the plan stops with `SourceMismatch` before Alchemy writes anything: the source checks run in
  `diff` too, not only in `reconcile`.
- `rootDir` must have a package.json (`ConvexAppNotFound`) and must be relative
  (`AbsoluteRootDir`): the state is shared between a laptop and CI, so an absolute path names a
  directory of one machine. A relative path can start with `..`.
- State always holds `rootDir`, in POSIX form, `"."` included. Reason: a 0.7 row has no `rootDir`,
  and its app directory was inferred, so a reader must tell `"."` from "not known". Alchemy has no
  hook that changes props before they go to state (`alchemy@2.0.0-beta.83`: Apply stores the props
  as the program gives them), so `Convex.Deployment` is a function over the resource class that
  writes the default. It keeps `Type`, `Provider`, and `ref`. It takes `rootDir` as a plain
  string and the props as an object, not as an Effect.
- The relative path resolves against the working directory of the deploy, as Alchemy resolves the
  relative paths of a Cloudflare Worker (`vite.rootDir`). Alchemy gives a provider no path of the
  stack file, so run `alchemy deploy` in the directory of the stack file. The run record
  (`samebase.run.stackFile`) names that directory for a reader.
- Upgrade from 0.7: `diff` compares `rootDir` with the stored props, so the first run plans one
  `update` for each deployment, and that update writes `rootDir` to the row. When the app directory
  is the same as before, the hash is the same, and the update changes nothing in Convex: no push, no
  deploy key, only reads. The next run is a no-op. Measured on team nicu with a stack file at the
  root of a scratch repository and the app in `apps/web`: 0.7.0 deployed with
  `source: "apps/web/convex"`, then 0.8.0 with `rootDir: "apps/web", source: "./convex"` planned
  "1 to update", took 190 ms, kept the hash, and did not change the push time of the deployment;
  the run after it planned "no changes". The lockfile is part of the hash, so the install of 0.8.0
  itself changes the hash in a repository: there, the first run pushes the same functions once, as
  it does after every dependency change.

## Caller concerns, not provider concerns

A collision-safe stage key (two branches that differ only by `/`), the preview name as the raw
branch, the head check (an old commit must not deploy over a newer one), the GitHub environment URL,
a git-ignored `.alchemy/`, and an encrypted state store, because `env` values are props.
