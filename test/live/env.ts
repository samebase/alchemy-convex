// Targets for the live tests. Maintainers run them against a throwaway
// project; the defaults are the Samebase live-tests team. Override with env
// vars to point at your own throwaway resources. Live tests only run when
// ALCHEMY_CONVEX_LIVE=1.
export const liveEnabled = process.env["ALCHEMY_CONVEX_LIVE"] === "1";

export const liveTargets = {
  /** Team slug that holds the throwaway project. */
  team: process.env["ALCHEMY_CONVEX_LIVE_TEAM"] ?? "samebase-live-tests",
  /** Numeric id of the throwaway project. */
  projectId: Number(process.env["ALCHEMY_CONVEX_LIVE_PROJECT_ID"] ?? "3145389"),
  /** A deployment of that project that may receive test keys and env vars. */
  deployment: process.env["ALCHEMY_CONVEX_LIVE_DEPLOYMENT"] ?? "beaming-okapi-932",
};
