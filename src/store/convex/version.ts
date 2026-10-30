// The wire version of the store: the `state:version` query answers it, and
// Convex.state() pushes the store app when a seed answers an older one or the
// deployment has no `version` yet. It fails the run when a base answers an
// older one, and on a newer one. Raise it with each change of a function of
// src/store/functions.ts or of the alchemyState component
// (src/store/component). The store and its readers (Samebase) are released
// and upgraded together: a renamed function is a version bump on both sides.
//
// 1: `version`, `stacks`, `stages`, `list`, `get`, `replaced`, `getOutput`,
//    `set`, `remove`, `removeStack`, `setOutput` (0.6.0).
// 2: `readStack` (0.7.0).
// 3: authenticated subscriptions and current stage run records (0.9.0).
// 4: the store is a component (same functions).
// 5: `version` answers `{ version, host }`; the functions come from `@samebase/alchemy-convex/state/functions`.
export const STORE_VERSION = 5;
