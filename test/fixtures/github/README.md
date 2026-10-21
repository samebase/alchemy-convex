# Recorded GitHub payloads

| File | Request |
| --- | --- |
| pull_request_event.json | The payload of a `pull_request` event for [samebase/alchemy-convex#19](https://github.com/samebase/alchemy-convex/pull/19): `action`, `number`, and `pull_request` as `GET /repos/samebase/alchemy-convex/pulls/19` answered it on 2026-10-21. The `body` of the pull request is set to `null`. |

The run record reads `pull_request.number` and `pull_request.head.sha` from the file at
`GITHUB_EVENT_PATH`. No file contains a token.
