# Design: Alchemy state in Convex

Sources: `alchemy@2.0.0-beta.83` (`src/State/*`, `src/Cloudflare/StateStore/*`, `Apply.ts`),
`@convex-dev/platform` 0.1.11, `convex` 1.46. Measured on 2026-10-21 in team `nicu` with the
temporary projects `tmp-44ce-state-probe` and `tmp-bf6f-*` (deleted after the proof) and the
project `alchemy-state`, which stays. Problem: `Cloudflare.state()` puts a Cloudflare token in every
repository, and 0.5.0 put the state inside the production deployment of the app, a resource of the
stack, with a second deploy key in every repository. Goal: state outside every resource that the
stack manages, one secret in the repository, and an index of the stacks of a team that Samebase
reads.

## The Alchemy interface

- `Alchemy.Stack(name, { providers, state })` takes any `Layer<State, never, StackServices>`, so the
  state layer can use the `ChildProcessSpawner` and the `Scope` of the stack. `StateService`: `get`,
  `set`, `delete`, `list` by `(stack, stage, fqn)`, and `listStacks`, `listStages`,
  `getReplacedResources`, `deleteStack`, `getOutput`, `setOutput`. The engine passes the stack name
  and the stage on every call, so one service serves every stack and stage. Only the Postgres store
  locks (an advisory lock).
- `encodeState` writes a `Redacted` value as clear text. The local, HTTP, and Postgres stores keep
  it so. The Cloudflare store encrypts at rest, but each holder of its token reads clear text.
- `Cloudflare.state()` is the model: one `alchemy-state-store` Worker for each account, one Durable
  Object for each stack name, all stages of a stack in that object, a root object with the stack
  index, `GET /version` compared with the version that the package knows, and a push of the Worker
  from the package's own module when the version differs. It writes the state of its own bootstrap
  to local files first, because the Worker does not exist before the deploy.

## Decision: one project `alchemy-state` for each Convex team

- `Convex.state({ team })`, with the team like `Convex.Project`. The first call of a run finds the
  project by name with the team token (`CONVEX_ACCESS_TOKEN`, or the Convex CLI login), or creates
  it with its production deployment. The tables are `resources (stack, stage, fqn, value)` and
  `outputs (stack, stage, value)`, where `value` is the JSON text of `encodeState`. The stack name
  is the GitHub repository, `owner/name`, so `stacks` is the index that Samebase reads.
- The store exists before the stack runs, so there is no local or in-memory state during a
  bootstrap: the project and the push happen before the engine reads anything.
- Every function of the store is internal. Measured: a public function of a root app answers
  `POST /api/mutation` and `/api/query` with no key at all
  (`test/fixtures/state/public_mutation_no_key.json`). An internal function answers only
  `POST /api/function` with a deploy key of the deployment, the call that `convex run` makes; without
  a key it answers HTTP 403.
- Credentials: each run creates a deploy key of the store deployment with
  `deployment:functions:runInternalQueries` and `deployment:functions:runInternalMutations`, expiry
  two hours, and deletes it when the scope of the stack closes. A call that gets HTTP 401 or 403,
  such as after the expiry in a run longer than two hours, creates one new key and runs once more. Measured: `deployment:data:view` and
  `deployment:data:write` do not run an internal function; the reply names the action that is
  missing. A reader of the index, such as Samebase, needs a key with `runInternalQueries` only.
  The deployment also accepts the Convex CLI login token itself as `Authorization: Convex <token>`;
  that path is not official and not measured for a team access token, so the store does not use it.
- Version: `state:version` answers `STORE_VERSION` of `src/store/convex/version.ts`. A missing
  function (reply `Could not find function for 'state:version'`) or an older number makes the run
  push `src/store/convex` with the Convex CLI of the app, `convex deploy --typecheck disable
  --codegen disable`, from `src/store` of the installed package, with a push key of
  `PUSH_KEY_ACTIONS` that is deleted after the push. The version is read again right before the
  push, because another run can push a newer store in the meantime. A newer number is used as it
  is: the names are a wire contract, so a newer store serves an older client, and the store is never
  pushed back. Unlike the Cloudflare store, which compares for equality and would deploy an older
  Worker over a newer one. A deployment with code but no `state:version` is another app with the
  name of the store, and the run fails instead of pushing over it.
- The functions directory is found from the module: `src/State.ts` in a checkout, `lib/index.js` in
  the installed package, and `../src/store/convex` from either, because the package ships `src`.
  The CLI needs a `package.json` with `convex` among its dependencies or peer dependencies in the
  directory above the functions, so `src/store/package.json` declares the peer dependency. The CLI
  comes from `createRequire(src/store/package.json).resolve("convex/package.json")`: the `convex`
  of the app, through the virtual store of pnpm or the flat `node_modules` of npm.
- Function names are a wire contract: Samebase calls `state:stacks`, `state:stages`,
  `state:list`, `state:get`, and `state:getOutput` by name, and an older package calls an older
  set. Add functions, never rename or remove one. `stacks` and `stages` list a stage that has only
  an output row too, so a reader sees a stack with no resources.
- Not kept from 0.5.0: the `alchemyState` component, its `convex.config` export, and
  `CONVEX_STATE_DEPLOY_KEY`. The 0.5.0 rows are not migrated: a stack moves with one
  `alchemy deploy --adopt`, which takes its project and deployments over by name.
- The earlier rejection of a store for each team ("its key reads the state of every app of the
  team, and no app push maintains its code") rested on deploy keys only, with no team token. With
  the team token, the run mints its own keys, and the package pushes the store code itself.

## Measured

Proof: the public starter `samebase/base-alchemy` on a local branch, with the stack named
`GITHUB_REPOSITORY` and the project named after the repository, run from a laptop with the Convex
CLI login and no `CONVEX_ACCESS_TOKEN`. The store deployment is `artful-alligator-66` of
`alchemy-state` (3259168) in team `nicu`.

| Check                                                     | Result                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only the team token, no project of the stack              | `deploy --stage main`: the run created `alchemy-state`, pushed store version 1 in 3.3 s, created the app project `tmp-bf6f-base-alchemy`, and pushed to it: 34 s. `stacks` answered `["samebase/tmp-bf6f-base-alchemy"]`, `list` of `main` `["Deployment", "Project"]`, `getOutput` the site URL. |
| Main and preview stages share the rows of the stack       | `deploy --stage feature-preview-1a2b3c4d`: the preview read the project of `main` with `Convex.Project.ref`, created one deployment, 29 s. `stages` answered `["feature-preview-1a2b3c4d", "main"]`; its destroy left `["main"]`.                                                                 |
| The run key is gone at the end of a run                   | `list_deploy_keys` of the store deployment: `[]` after every run; one key with the two `runInternal*` actions during a run.                                                                                                                                                                       |
| Destroy of the app project does not touch the store       | `destroy --stage main` deleted the project; `stacks` no longer listed the stack, `list` and `getOutput` of `main` were empty, and `alchemy-state` kept its id and deployment.                                                                                                                     |
| Two stacks of two repositories in one team do not collide | A second checkout deployed `samebase/tmp-bf6f-second` while the first stack was destroyed. `stacks` answered both names, each `getOutput` its own site URL.                                                                                                                                       |
| Deploy again after destroy                                | `deploy --stage main` created a new project and deployment, 33 s.                                                                                                                                                                                                                                 |
| The version check detects an older store and upgrades it  | A push of the store with `STORE_VERSION = 0`, then `alchemy plan --stage main`: the log shows `pushing the store version 1`, and `state:version` answered 1 after it. A store that answers a newer version fails the run (unit test).                                                             |
| A narrow key reads the index and the outputs              | With curl only: the project listing of the team, `create_deploy_key` with `deployment:functions:runInternalQueries`, `state:stacks` and `state:getOutput` answered, `state:set` was refused with the name of the missing action.                                                                  |
| Not measured                                              | A team access token from the dashboard: the laptop has the Convex CLI login only. The first CI run of `samebase/base-alchemy` with `CONVEX_ACCESS_TOKEN` measures it.                                                                                                                             |

## Limits

- No lock: keep the CI concurrency group for each stage. No encryption beyond Convex at rest; a
  holder of a key with `runInternalQueries` reads every `Redacted` prop of every stack of the team.
- Two first runs of two repositories at the same time in a team with no store can both create a
  project named `alchemy-state`. Each run lists the projects again after its create; the run whose
  project is not the oldest deletes its own, which holds nothing yet, and uses the oldest. A
  duplicate that a person creates by hand still fails every run with `AmbiguousProject`.
- The push of the store has no lock. Two runs of two package versions that both find an older
  store can push in the order new, then old, in the seconds between the second read of the version
  and the end of the push; the next run of the newer package pushes its store again. The upgrade
  happens once for each new package version in a team.
- A team access token (0.6.1): `GET /token_details` names its team, and the dashboard's team list
  answers it HTTP 403, so a slug is checked against the `teamSlug` of the team's projects instead;
  a team without a project needs the numeric id. Measured with a temporary team token on a
  temporary stack: bootstrap, project create, push, index read, and destroy.
