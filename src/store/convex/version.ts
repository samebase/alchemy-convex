// The wire version of the store: the `state:version` query answers it, and
// Convex.state() pushes this directory when the store of the team answers an
// older one or has no `version` yet, and fails the run on a newer one. Raise
// it only when a function that a released client calls changes or goes away:
// each consumer needs the exact number, so a raise moves every consumer of a
// team at once.
//
// 1: `version`, `stacks`, `stages`, `list`, `get`, `replaced`, `getOutput`,
//    `set`, `remove`, `removeStack`, `setOutput` (0.6.0).
// 2: `readStack` (0.7.0).
// 3: authenticated subscriptions and current stage run records (0.9.0).
// 4: the store is a component (same functions).
export const STORE_VERSION = 4;
