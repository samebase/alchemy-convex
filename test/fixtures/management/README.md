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
| deployment_list_deploy_keys.json | GET /deployments/{deployment_name}/list_deploy_keys |
| project_list_preview_deploy_keys.json | GET /projects/{project_id}/list_preview_deploy_keys |
| deployment_list_environment_variables.json | GET https://{deployment}.convex.cloud/api/v1/list_environment_variables |

Facts learned while capturing: `delete_deploy_key` takes the key's unique name (as listed, with the
short id suffix), the full secret, or the encoded token in `id`; a numeric id is rejected. The
deployment API authenticates with `Authorization: Convex <deploy key>`.
