# Recorded function API payloads

Captured on 2026-10-21 against the temporary project `tmp-44ce-state-probe` in team `nicu`
(production deployment `prestigious-marlin-188`), after a push of `src/store/convex` with
`convex deploy --typecheck disable --codegen disable`. The project was deleted after the proof.
Ids are real and harmless. No file contains a key.

| File | Request |
| --- | --- |
| function_version_1.json | POST /api/function `state:version` of store version 1 with a key that has `deployment:functions:runInternalQueries`: a bare number, as a store of version 4 or older answers |
| function_version_missing.json | POST /api/function for a function that the deployment does not have |
| function_no_key.json | POST /api/function without a key (403) |
| function_not_permitted.json | POST /api/function `state:set` with a key that has only `deployment:functions:runInternalQueries` |
| function_set.json | POST /api/function `state:set` with a key that has `deployment:functions:runInternalMutations` |
| function_get.json | POST /api/function `state:get` of the row that `state:set` wrote |
| function_get_absent.json | POST /api/function `state:get` of a row that does not exist |
| function_stacks.json | POST /api/function `state:stacks` |
| public_mutation_no_key.json | POST /api/mutation `state:set` without a key, while the store still had public functions (200): the reason every function is internal |

`function_version.json` was captured on 2026-10-30 against the development deployment
`gallant-skunk-112` of the project `samebase` in team `nicu`, after a push of `src/store/convex`
(store version 5) with `npx convex dev --once`: POST /api/function `state:version` with a key that
has `deployment:functions:runInternalQueries` only. The key was deleted after the call.

Facts learned: `deployment:data:view` and `deployment:data:write` do not run an internal function
(the reply names `deployment:functions:runInternalQueries` or `runInternalMutations`). An internal
function through `/api/query` without a key answers a bare "Server Error". A deploy key must expire
at least 30 minutes after its creation (`InvalidExpiresAt`).
