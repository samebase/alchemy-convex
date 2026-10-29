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
- The raw state functions are internal. Measured: a public function of a root app answers
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
  push, because another run can push a newer store in the meantime. A newer number fails the run
  with both versions: the store and its clients are released and upgraded together, and the store
  is never pushed back. Unlike the Cloudflare store, which compares for equality and would deploy an
  older Worker over a newer one. A deployment with code but no `state:version` is another app with the
  name of the store, and the run fails instead of pushing over it.
- The functions directory is found from the module: `src/State.ts` in a checkout, `lib/index.js` in
  the installed package, and `../src/store/convex` from either, because the package ships `src`.
  The CLI needs a `package.json` with `convex` among its dependencies or peer dependencies in the
  directory above the functions, so `src/store/package.json` declares the peer dependency. The CLI
  comes from `createRequire(src/store/package.json).resolve("convex/package.json")`: the `convex`
  of the app, through the virtual store of pnpm or the flat `node_modules` of npm.
- Samebase calls `state:stacks`, `state:stages`, `state:list`, `state:get`, and
  `state:getOutput` by name. The store and Samebase are released and upgraded together: a renamed
  function is a version bump on both sides. `stacks` and `stages` list a stage that has only an
  output row too, so a reader sees a stack with no resources.
- Not kept from 0.5.0: the `alchemyState` component, its `convex.config` export, and
  `CONVEX_STATE_DEPLOY_KEY`. The 0.5.0 rows are not migrated: a stack moves with one
  `alchemy deploy --adopt`, which takes its project and deployments over by name.
- The earlier rejection of a store for each team ("its key reads the state of every app of the
  team, and no app push maintains its code") rested on deploy keys only, with no team token. With
  the team token, the run mints its own keys, and the package pushes the store code itself.

## Decision: the run record in the stage output (0.7.0)

Alchemy state holds no time, author, commit, branch, or run; the only "when" is the content hash
(measured in the Samebase research `research/2026-10-21-alchemy-state-rows-for-workers-and-convex.md`,
sections 4 and 6, which this section follows). The engine writes the stage output once, after a full
successful apply (`alchemy/Apply.ts`, `state.setOutput` after `Output.evaluate`).

- Placement: `Convex.state()` wraps `setOutput`. The stored document is the stack's output plus the
  reserved key `samebase.run`; the stack's own keys stay as they are, and a value that the stack
  itself put under `samebase.run` wins. `getOutput` returns the document as stored: the reader strips
  nothing, and a stack that spreads the whole output of another stack into its props sees the key
  and a new `recordedAt` after every deploy; such a stack reads the named outputs. An output that is
  not a plain object (a string, an array, a Date, a Redacted value) has no place for the key and is
  stored as it is, with a warning in the log. The record needs no store function, so this part keeps
  the wire names of version 1.
- The record, version 1: `{ version: 1, repository, stackFile, branch, pullRequest, headCommit,
  runUrl, source, recordedAt }`, no secret. `src/RunRecord.ts` derives it with no Convex dependency,
  so any state layer can add it. The derivation runs once, at the first use of the state;
  `recordedAt` is the time of the write. A checkout that gives no record (a tarball without git, no
  `origin` remote, a detached HEAD) still reads, plans, and destroys: the first use logs the reason,
  and the outputs of that run carry no record. A reader treats a missing `samebase.run` as an unknown
  run, which it does for every output written before 0.7.0 anyway.

| Field         | GitHub Actions (`GITHUB_ACTIONS` is `true`)                                                                              | Laptop                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `repository`  | `GITHUB_REPOSITORY`                                                                                                      | `git remote get-url origin`, the last two path segments of an https, ssh, or scp URL |
| `stackFile`   | the working directory below `git rev-parse --show-toplevel`, plus `alchemy.run.ts`                                       | the same                                                                             |
| `branch`      | `GITHUB_HEAD_REF` when set (pull request events), else `GITHUB_REF_NAME`                                                 | `git rev-parse --abbrev-ref HEAD`; a detached HEAD fails                             |
| `pullRequest` | `pull_request.number` of the payload at `GITHUB_EVENT_PATH`, else `<n>` of `GITHUB_REF` `refs/pull/<n>/merge`, else null | null                                                                                 |
| `headCommit`  | `pull_request.head.sha` of the payload, else `GITHUB_SHA`                                                                | `git rev-parse HEAD`                                                                 |
| `runUrl`      | `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}`                 | null                                                                                 |
| `source`      | `github-actions`                                                                                                         | `laptop`                                                                             |

- `headCommit` on a pull request event is the head of the pull request, not `GITHUB_SHA`, which is
  the merge commit that no branch holds: the head is what GitHub's run reports as `head_sha` and what
  a person sees on the pull request. The tree that `actions/checkout` deploys by default is that
  merge commit, so the base of the pull request at that moment is not in the record; `runUrl` names
  the run that has it.
- `stackFile` assumes the default name. The alchemy CLI resolves `--config` against the working
  directory (`alchemy/src/Alchemist/Entrypoint.ts`) and keeps it in the session, not in the
  `StackServices` or `AlchemyContext` that a state layer sees, so the record takes the working
  directory below the git top level plus `alchemy.run.ts`. A stack file with another name is
  recorded under the default name until Alchemy exposes the path.
- The one-call read: `state:readStack({ stack })` answers
  `{ stages: [{ stage, resources: [{ fqn, value }], output }] }` in stage order, resources in fqn
  order, values as the JSON texts of the rows, `output: null` for a stage without one. It is a new
  function, so `STORE_VERSION` is 2: the first run of 0.7.0 in a team pushes the store in place, the
  path that 0.6.0 measured. The rows and the names of version 1 stay (unit test: a version 1 store
  with rows answers the old names unchanged after the upgrade, and `readStack` after it). One
  function reads at most 16 MiB (Convex limit); the measured rows are a few KB each, and a stack
  beyond the limit is read with the per-stage functions.

Limits of the record: a failed deploy leaves the previous record, and a deploy of selected resources
(`alchemy deploy <fqn>`) writes none, because the engine writes the output only after a full
successful apply. The record therefore describes the last full successful deploy of the stage, which
is what the resources of the stage reflect; the failed run is GitHub's fact. A dirty laptop tree is
recorded by its last commit.

## Repository subscriptions (0.9.0)

Store version 3 adds `reader:authorize`, an internal mutation. A trusted server must check the
user's current repository and team access before each call. It sends `{ repository, subject }`
with a deployment credential that can run internal mutations. The reply is `{ token }`. The
token is signed with the deployment's native ES256 key, has a 300-second lifetime, and contains
`scope: "alchemy:read"` and the exact repository. Its audience is the deployment's cloud URL plus
`/alchemy-reader`. `auth.config.ts` accepts only that deployment's issuer, native JWKS, and
audience. This requires Convex 1.48.0 or newer. Deployment credentials stay on the trusted server.

The browser connects a separate `ConvexClient` to the store, uses `setAuth` to get and renew the
token, then subscribes to `reader:repository({})`. The query takes no repository argument. It
reads the exact stack name and names that start with `repository + "/"`, with indexed ranges.
It checks the scope and repository claim, and returns only stages whose current run record
matches that repository. Each query reads one consistent database snapshot. Its wire reply is:

```ts
{
  store: "found",
  stacks: [{
    name,
    stages: [{
      name, record, deployedHeadCommit,
      resources: [{ fqn, value }],
      output,
    }],
  }],
}
```

Stacks, stages, and resources have deterministic name order. Resource values and output stay JSON
strings. Before returning them, the query replaces any object that has `__redacted__` with
`{ __redacted__: null }`, including nested values. It removes `samebase.run` from output. The
raw internal state functions still return the stored values. The reader does not hide Convex query
size limits or return a partial repository. A repository above the backend's read or result limit
fails the query.

The writer sends the record of its run with `state:set`, `state:remove`, and `state:setOutput`.
The mutation stores it in `outputs.currentRun` in the same transaction as the resource change.
`outputs.value` is optional so the first resource can appear before the output. `getOutput` and
`readStack.output` stay `null` until the stack writes an output. `readStack.record` is the current
record or `null`. A write without a record (see the run record section) clears `currentRun`, so
the reader does not show the stage. `removeStack` removes both the resources and the output row,
including the current record.

`record` is `currentRun`. `deployedHeadCommit` is the `headCommit` of the output's
`samebase.run` when that value passes the `runRecord` validator and names the same repository,
else `null`. A new run can therefore appear while the deployed commit stays the last successful
commit. Arbitrary JSON outputs stay valid; an output without a run record has no deployed commit.

There is no immediate token revocation table. A refused renewal ends the normal client's access;
an issued token remains valid until the backend rejects its expiry, including its clock tolerance
(currently five seconds for custom JWTs). A local proof with a 60-second token rejected HTTP
reads at expiry plus six seconds, and the open subscription stopped at expiry plus one second.
The trusted server must not treat its deployment credential as a browser credential.

## The store is a component (store version 4)

Store version 4 puts the tables and the data functions of the store into the Convex component
`alchemyState`. The provider and the readers call the same functions as before.

Why: a team project will mount this component next to other components. A component has its own
tables and functions, so it can go into an app that has other tables. The project `alchemy-state`
that the provider creates stays as it is: an app that has only the store.

What moved to `src/store/component/`, with `defineComponent("alchemyState")`, its own schema, and
its own `_generated`:

- The tables `resources` and `outputs` and the `runRecord` validator (`schema.ts`, `runRecord.ts`).
- The data functions `stacks`, `stages`, `list`, `get`, `replaced`, `set`, `remove`, `removeStack`,
  `getOutput`, `setOutput`, and `readStack` (`state.ts`), as component queries and mutations. They
  have the same semantics, the same order, and `value` as JSON text.
- The redacted read of one repository (`reader.ts`, `repository({ repository })`): the range reads,
  the removal of secrets, and the `deployedHeadCommit` check.

What stays in the store app `src/store/convex/`, and why:

- `convex.config.ts`: `defineApp()` and `app.use(alchemyState)`.
- `state.ts`: each `state:*` function is an internal query or mutation with the same name,
  arguments, and result, and it calls the component function with the same name. The provider and
  Samebase call these names with a deploy key. A component argument is required: an absent `run`
  or `stage` goes to the component as `null`. This is the chosen contract of the component; the
  generated component API also types an optional field without `undefined`.
- `state:version` answers `STORE_VERSION` and does not call the component. The number counts the
  functions of the app and of the component, `reader.ts` included, so the app keeps it.
- `reader.ts`: `authorize` signs the token with `ctx.auth.signJwt`, and `repository` verifies it
  with `ctx.auth.getUserIdentity`. A component has no `ctx.auth`. `repository` gives the verified
  repository to the component read. The component read runs in the transaction of the app query,
  so the subscription stays reactive.
- `auth.config.ts` and `version.ts`.

The wire contract does not change: the function names, the arguments, the results, and the JSON
text of `value`. The recorded payloads in `test/fixtures/state/` stay as they are. The push does
not change: `convex deploy --typecheck disable --codegen disable` from `src/store`, with the
committed `_generated` of the app and of the component. The component directory is in that push
root.

The rows move. Convex keeps the tables of a component apart from the tables of the app. After the
push of store version 4, the rows of store version 3 stay in the root tables `resources` and
`outputs`, and no function reads them. The push does not move rows, and this package has no
migration. A run that finds no rows plans each resource as new. A team whose store has rows moves
them once. Every consumer pins the version of this package, so no run pushes store version 4 before
the team upgrades a consumer: the move comes before the first upgrade, and no deploy has to stop.

1. Export the store deployment before the push: with the Convex CLI login, in a directory that
   selects the `alchemy-state` project, `npx convex export --prod --path snapshot.zip`, and extract
   the file. The snapshot holds every secret of the state: keep it for minutes, with permissions
   for the operator only, and delete it after step 5.
2. Run `alchemy plan` once for a stack that has no resources, on store version 4: a scratch stack
   with `Convex.providers()`, `Convex.state({ team })`, and an empty body. The run pushes the
   store. `state:version` answers 4, and `state:stacks` answers `[]`.
3. Import each root table into the component:
   `npx convex import --prod --component alchemyState --table resources --append resources/documents.jsonl`,
   and the same for `outputs`. The import keeps `_id` and `_creationTime`.
4. Compare. `state:stacks`, and `state:stages` for each stack, answer what they answered before
   the push, and the row count of each component table is the line count of its file. After a
   failed or partial import, delete the rows of that component table and repeat step 3 for it.
5. Clear the root tables, which hold the secrets of store version 3 and which no function reads:
   `npx convex import --prod --table resources --replace empty.jsonl` with an empty file, and the
   same for `outputs`. Then delete the snapshot.
6. Upgrade the consumers to this version. Their first run finds the rows.

This version does not export the component from the package. A later version exports it, so that
other apps can mount it.

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

### Measured for the run record (0.7.0)

Proof on 2026-10-21 in team `nicu` with the scratch stack `samebase/tmp-d524-run-record`, run from
a clone of this repository (`examples/run-record/alchemy.run.ts` on a local branch), with the
Convex CLI login and no `CONVEX_ACCESS_TOKEN`. The reads used a key with
`deployment:functions:runInternalQueries` only, minted through the Management API and deleted
after each read. The project and the rows were deleted at the end; `samebase/base-alchemy` was not
touched.

| Check                                 | Result                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The store upgrade in place            | `deploy --stage prod`: `pushing the store version 2 to artful-alligator-66`, 4.2 s; `state:version` answered 2 after it, and `state:stacks` still listed `samebase/base-alchemy`.                                                                                                                     |
| A laptop deploy records the checkout  | `state:getOutput` of `prod`: the stack's `projectId` and `convexUrl` plus `samebase.run` with `repository: "samebase/alchemy-convex"`, `stackFile: "examples/run-record/alchemy.run.ts"`, the branch and the HEAD commit of the clone, `pullRequest: null`, `runUrl: null`, `source: "laptop"`.       |
| A pull request deploy records the run | `deploy --stage pr-1` with the GitHub Actions variables of a `pull_request` event and an event payload file: `pullRequest: 1`, `branch` from `GITHUB_HEAD_REF`, `headCommit` the `pull_request.head.sha` of the payload (not `GITHUB_SHA`), the run URL with the attempt, `source: "github-actions"`. |
| One call reads the stack              | `state:readStack`: both stages in order, `pr-1` with `Backend` and `prod` with `Project`, each with its output document.                                                                                                                                                                              |
| The read key cannot write             | `state:set` with the read key: `You do not have permission to perform this operation (deployment:functions:runInternalMutations)`.                                                                                                                                                                    |
| Cleanup                               | `destroy --stage pr-1` deleted the preview deployment (0.8 s); `destroy --stage prod` deleted the project (0.5 s). After it: `stacks` without the scratch stack, `readStack` `{ stages: [] }`, no project named `tmp-d524`, `list_deploy_keys` of the store `[]`.                                     |

### Measured for store version 4 (0.12.0)

Proof on 2026-10-30 in team `nicu` on the development deployment `gallant-skunk-112` of
`alchemy-state`, with the Convex CLI login and `convex` 1.48.0. The production deployment of the
store was not touched. The probe rows were deleted at the end.

| Check                       | Result                                                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The push of the provider    | From store version 3, the push of `pushStore` (a key with `PUSH_KEY_ACTIONS` only, `convex deploy --typecheck disable --codegen disable` in `src/store`) installed the component. The committed `_generated` files did not change.                                                              |
| The wire contract           | `state:version` answered 4. `state:set` and `state:setOutput` with a run record, then `state:readStack`, answered as store version 3 does. `reader:repository` with an `alchemy:read` identity removed the `__redacted__` value; without one it refused.                                        |
| The installed package       | The same push from `node_modules/@samebase/alchemy-convex/src/store` of the packed tarball, installed with npm next to `convex` 1.48.0, passed.                                                                                                                                                 |
| The subscription            | A `ConvexClient` with a token of `reader:authorize` subscribed to `reader:repository`. A `state:set` through the component gave the subscription a new reply with the resource.                                                                                                                 |
| The rows of store version 3 | A row that store version 3 wrote stayed in the root table `resources`, and `state:stacks` answered `[]`. After the import of the root tables into the component (step 3 above), `state:stacks` and `state:readStack` answered the row again. The Convex import keeps `_id` and `_creationTime`. |
| Not measured                | The production store of a team, and the move of its rows.                                                                                                                                                                                                                                       |

## Limits

- No lock: keep the CI concurrency group for each stage. No encryption beyond Convex at rest; a
  holder of a key with `runInternalQueries` reads every `Redacted` prop of every stack of the team.
- Two first runs of two repositories at the same time in a team with no store can both create a
  project named `alchemy-state`. Each run lists the projects again after its create; the run whose
  project is not the oldest deletes its own, which holds nothing yet, and uses the oldest. A
  duplicate that a person creates by hand still fails every run with `AmbiguousProject`.
- The push of the store has no lock. Two runs of two package versions that both find an older
  store can push in the order new, then old, in the seconds between the second read of the version
  and the end of the push; the newer run then fails with both versions, and its next run pushes its
  store again. The upgrade happens once for each new package version in a team.
- A team access token (0.6.1): `GET /token_details` names its team, and the dashboard's team list
  answers it HTTP 403, so a slug is checked against the `teamSlug` of the team's projects instead;
  a team without a project needs the numeric id. Measured with a temporary team token on a
  temporary stack: bootstrap, project create, push, index read, and destroy.
