# Recorded Management API payloads

Captured on 2026-10-05 from `https://api.convex.dev/v1` against the temporary project
`tmp-alchemy-spike-base` in team `samebase-live-tests`, dev deployment `beaming-okapi-932`.
Secret values are replaced with `REDACTED`. Ids are real and harmless. Unit tests only read these
files. Negative-case fixtures are derived by mutating these, never written from scratch.

| File | Endpoint |
| --- | --- |
| teams_projects.json | GET /teams/{team_id}/projects |
| project.json | GET /projects/{project_id} |
| project_list_deployments.json | GET /projects/{project_id}/list_deployments |
| deployment.json | GET /deployments/{deployment_name} |
| team_list_deployment_regions.json | GET /teams/{team_id}/list_deployment_regions |
| deployment_create_deploy_key.json | POST /deployments/{deployment_name}/create_deploy_key |
| deployment_list_environment_variables.json | GET https://{deployment}.convex.cloud/api/v1/list_environment_variables |
| team_create_project.json | POST /teams/{team_id}/create_project |
| project_update.json | PATCH /projects/{project_id} |
| project_not_found.json | GET /projects/{project_id} for a deleted project (404) |
| deployment_update_environment_variables_conflict.json | POST https://{deployment}.convex.cloud/api/v1/update_environment_variables, two parallel writes (503) |
| project_delete_preview_deploy_key_500.json | POST /projects/{project_id}/delete_preview_deploy_key, parallel deletes (500) |
| project_create_deployment_preview.json | POST /projects/{project_id}/create_deployment, `type: "preview"` |
| project_create_deployment_dev.json | POST /projects/{project_id}/create_deployment, `type: "dev"` |
| project_create_deployment_reference_exists.json | POST /projects/{project_id}/create_deployment, a dev reference that exists (400) |
| project_create_deployment_missing_reference.json | POST /projects/{project_id}/create_deployment, a preview without a reference (400) |
| project_list_deployments_all.json | GET /projects/{project_id}/list_deployments, with prod, dev, and preview rows |
| deployment_get_preview.json | GET /deployments/{deployment_name} for a preview deployment |
| deployment_not_found.json | POST /deployments/{deployment_name}/delete for a deleted deployment (404) |
| team_get_project_by_slug.json | GET /teams/{team_id_or_slug}/projects/{project_slug} |
| team_get_project_by_slug_not_found.json | GET /teams/{team_id_or_slug}/projects/{project_slug} for a missing slug (404) |
| deployment_info.json | GET https://{deployment}.convex.cloud/api/v1/deployment_info with a full-access deploy key |
| deployment_info_not_permitted.json | the same with a key that has only `deployment:deploy` (403) |
| deployment_get_canonical_urls.json | GET https://{deployment}.convex.cloud/api/v1/get_canonical_urls |
| deployment_create_deploy_key_preview_key_refused.json | POST /deployments/{deployment_name}/create_deploy_key with a preview deploy key (403) |

The files from `team_create_project.json` down were captured on 2026-10-06 by
`test/live/safety.live.test.ts` against a temporary project `tmp-alchemy-convex-<8 hex>` in team
`nicu` (id 38516). That project was deleted at the end of the run.

Facts learned while capturing: `delete_deploy_key` takes the key's unique name (as listed, with the
short id suffix), the full secret, or the encoded token in `id`; a numeric id is rejected. The
deployment API authenticates with `Authorization: Convex <deploy key>`.

The deployment files were captured on 2026-10-06 by a probe against temporary projects
`tmp-alchemy-convex-<8 hex>` in team `nicu` (id 38516), deleted at the end of the run. Facts
learned: `create_deployment` with `type: "preview"` needs a `reference`, records it as the
preview identifier, and derives the reference `preview/<slug>` from it. A second create with the
same preview identifier deletes the first preview deployment. A dev reference stays as given, and
a second create with it answers 400 `DeploymentReferenceAlreadyExists`. `GET /deployments/{name}`
and `GET /projects/{project_id}/deployment` answer `previewIdentifier: null`, also for a preview;
only `list_deployments` and the create answer show it. `npx convex deploy --preview-name <name>`
with a preview deploy key pushes to a preview deployment that the Management API created with that
name. `--preview-create <name>` deletes it and creates a new one with a new name. A new preview
deployment expires after 14 days.

Facts learned on 2026-10-06: the key list shows a new key under its requested name. Only when a
listed key already has that name does Convex add a suffix, such as
`" (870993b4-ffe6-4911-adbd-e29f7fd712f2)"`. `delete_deploy_key` and `delete_preview_deploy_key`
with the secret as `id` delete exactly that key, and a second delete answers 404. Two parallel
`update_environment_variables` calls on one deployment can answer 503
`OptimisticConcurrencyControlFailure`, and two parallel `delete_preview_deploy_key` calls on one
project can answer 500 `InternalServerError`. A new attempt succeeds.

The files from `team_get_project_by_slug.json` down were captured on 2026-10-20 against temporary
projects `tmp-ea1d03a3-record` and `tmp-ea1d03a3-record2` in team `nicu`, deleted after the run.
Facts learned then: a production deploy key gets `UnexpectedAuthHeaderFormat` (400) on the
Management API, and its `deployment_info` needs `deployment:data:view`; a preview deploy key reads
its project and creates, gets, and deletes its preview deployments on the Management API, but cannot
create a deploy key or use the deployment API.

The token files were captured on 2026-10-21 with a temporary team access token
`tmp-0485-token-details` of team `nicu` (deleted at the end of the run) and the Convex CLI login:

| File | Endpoint |
| --- | --- |
| token_details_team_token.json | GET /token_details with a team access token (200) |
| token_details_cli_login.json | GET /token_details with the Convex CLI login (403 `NotOAuthTeamToken`) |
| dashboard_teams_cli_login.json | GET https://api.convex.dev/api/dashboard/teams with the Convex CLI login (200, referral codes replaced) |
| dashboard_teams_team_token.json | the same with a team access token (403 `NotAllowed`) |

Facts learned: a team access token names its team only through `/token_details`; it cannot list
teams. The Convex CLI login lists teams and gets 403 from `/token_details`.
