// The wire version of the store: the `state:version` query answers it, and
// Convex.state() pushes this directory when the store of the team answers an
// older one or has no `version` yet. Raise it when a function changes in a way
// that an older client cannot use. Never rename or remove a function: an
// older client, and Samebase, call the store by these names.
export const STORE_VERSION = 1;
