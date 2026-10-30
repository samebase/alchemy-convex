// The wire contract of the store: the `state:version` query answers it, and
// Convex.state() pushes the store app when a seed answers an older one or the
// deployment has no `version` yet. It fails the run when a base answers an
// older one, and on a newer one.
//
// Each consumer of a team needs this exact number, so a raise moves every
// consumer of the team at once. Raise it only when a function that a released
// client calls changes its arguments, its result, or its meaning, or goes
// away. A new function does not raise it. The store and its readers (Samebase)
// move together on a raise: a renamed function is a raise on both sides.
//
// 1: `version`, `stacks`, `stages`, `list`, `get`, `replaced`, `getOutput`,
//    `set`, `remove`, `removeStack`, `setOutput` (0.6.0).
// 2: `readStack` (0.7.0).
// 3: authenticated subscriptions and current stage run records (0.9.0).
// 4: the store is a component (same functions).
export const STORE_VERSION = 4;
