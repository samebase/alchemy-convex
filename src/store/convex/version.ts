// The wire version of the store: the `state:version` query answers it, and
// Convex.state() pushes this directory when the store of the team answers an
// older one or has no `version` yet. Raise it when a function is added or
// changes in a way that an older client cannot use. Never rename or remove a
// function: an older client, and Samebase, call the store by these names.
//
// 1: `version`, `stacks`, `stages`, `list`, `get`, `replaced`, `getOutput`,
//    `set`, `remove`, `removeStack`, `setOutput` (0.6.0).
// 2: `readStack` (0.7.0).
// 3: authenticated subscriptions and current stage run records (0.9.0).
export const STORE_VERSION = 3;
