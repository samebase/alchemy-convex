# Recorded function API payloads

Captured on 2026-10-20 against the temporary project `tmp-ea1d03a3-convex-state` in team `nicu`
(production deployment `fine-cow-747`), after the first `alchemy deploy --stage main` of the proof
stack. The project was deleted after the proof. Ids are real and harmless. No file contains a key.

| File | Request |
| --- | --- |
| url_for_key.json | POST https://api.convex.dev/api/deployment/url_for_key |
| components_list_empty.json | POST /api/query `_system/frontend/components:list` on a deployment with no code |
| components_list_active.json | the same with `alchemyState` mounted |
| components_list_unmounted.json | the same after a push without the mount (dev deployment) |
| function_list.json | POST /api/function `state:list` with `componentPath: "alchemyState"` |
| function_get.json | POST /api/function `state:get` of the row that the run wrote |
| function_get_absent.json | POST /api/function `state:get` of a row that does not exist |
| function_not_permitted.json | POST /api/function `state:remove` with a key that has only `deployment:data:view` |
| function_no_key.json | POST /api/function without a key (403) |
| function_component_missing.json | POST /api/function on a deployment with no code (500) |
