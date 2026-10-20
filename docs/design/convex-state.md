# Design: Alchemy state in Convex

Sources: `alchemy@2.0.0-beta.83` (`src/State/*`, `src/Cloudflare/StateStore/*`, `Apply.ts`),
`@convex-dev/platform` 0.1.11, `convex` 1.46. Measured on 2026-10-20 on the temporary project
`tmp-ea1d03a3-convex-state` (team `nicu`, deleted after the proof). Problem: `Cloudflare.state()`
puts a Cloudflare token in every repository. Goal: state in Convex, with Convex deploy keys only.

## The Alchemy interface

- `Alchemy.Stack(name, { providers, state })` takes any `Layer<State>`, which gets the stack
  ConfigProvider. `StateService`: `get`, `set`, `delete`, `list` by `(stack, stage, fqn)`, and
  `listStacks`, `listStages`, `getReplacedResources`, `deleteStack`, `getOutput`, `setOutput`. The
  scope is the stack name and the stage. Only the Postgres store locks (an advisory lock).
- `encodeState` writes a `Redacted` value as clear text. The local, HTTP, and Postgres stores keep
  it so. The Cloudflare store encrypts at rest, but each holder of its token reads clear text.
- The engine writes `creating` before each create, so a store must take writes before the first
  push. `Cloudflare.state()` uses local state that it copies into its Worker after the deploy.

## Decision: an `alchemyState` component in the production deployment

- The app mounts `@samebase/alchemy-convex/convex.config`. `Convex.state()` calls it with
  `POST <deployment>/api/function` and `componentPath`, as `convex run --component` does. Reason:
  Convex checks the deploy key itself. An HTTP action cannot check a deploy key, so HTTP routes
  need a new secret, a public URL, and code in `http.ts`.
- Host: the production deployment. It exists before the first run, the stack never deletes it,
  and the state goes with the project. Preview deployments expire.
- Not a tiny deployment for each team: its key reads the state of every app of the team, and no
  app push maintains its code. Not the Management API: it has no endpoint that writes data.
- Rows: `resources (stack, stage, fqn, value)` and `outputs (stack, stage, value)`, where `value`
  is the JSON text of `encodeState` (a Convex object refuses some keys).

## Measured facts

- A component query needs the key action `deployment:data:view`, a mutation
  `deployment:data:write`; `runInternalQueries` and `runInternalMutations` are not sufficient. No
  key: HTTP 403. `/api/query` and `/api/mutation` ignore `componentPath`.
- `/api/function` for a component that is not mounted gives HTTP 500, which cannot mean "empty".
  `_system/frontend/components:list` gives `[]`, `active`, or `unmounted` (after a push without the
  mount). An unmounted component keeps its rows; a new mount gives them back.
- `POST https://api.convex.dev/api/deployment/url_for_key` gives the URL of a deploy key in any
  region, the same call that the Convex CLI makes.

## First run

1. The template flow makes the project, its production deployment, and the keys.
2. `alchemy deploy --stage main --adopt` with `CONVEX_DEPLOY_KEY` and `CONVEX_STATE_DEPLOY_KEY`.
3. No `alchemyState` in the component list: the state is empty, and writes stay in memory. The
   engine writes `creating`, and `Convex.Deployment` pushes the app with its mount.
4. On the next write the mount is `active`. If those stages have no rows, the store writes the rows
   from memory, then writes to the component directly.
5. A stack output with the state still in memory fails the run (no state saved). `unmounted` fails.

## Credentials and limits

- `CONVEX_STATE_DEPLOY_KEY` in every run: a production deploy key with only `deployment:data:view`
  and `deployment:data:write` (`create_deploy_key` with `allowedActions`). No team token.
- Cost: a preview run can read and write production tables with it (no push, no variables). Today
  a preview run holds a Cloudflare token for the account.
- No lock: keep the CI concurrency group for each stage. No encryption beyond Convex at rest.
  The function names are a wire contract: never rename or remove one.
