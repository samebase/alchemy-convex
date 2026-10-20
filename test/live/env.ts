// Targets for the live tests. Maintainers run them against a throwaway team;
// the defaults are the Samebase live-tests team. Override with env vars to
// point at your own throwaway resources. Live tests only run when
// ALCHEMY_CONVEX_LIVE=1.
export const liveEnabled = process.env["ALCHEMY_CONVEX_LIVE"] === "1";

export const liveTargets = {
  /** Team slug that holds the throwaway projects. */
  team: process.env["ALCHEMY_CONVEX_LIVE_TEAM"] ?? "samebase-live-tests",
  /**
   * Name prefix of every project that a live test creates. A guard refuses
   * to delete a project or a deployment of a project without it.
   */
  prefix: process.env["ALCHEMY_CONVEX_LIVE_PREFIX"] ?? "tmp-alchemy-convex-",
};
