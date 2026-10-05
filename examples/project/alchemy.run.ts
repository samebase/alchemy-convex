// Smoke stack: one Convex project, nothing else. Used to prove the provider
// through the real Alchemy engine against the throwaway team.
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Convex from "../../src/index.ts"; // in your app: "@samebase/alchemy-convex"

export default Alchemy.Stack(
  "AlchemyConvexSmoke",
  {
    providers: Convex.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Convex.Project("Project", {
      team: "samebase-live-tests",
      name: "tmp-alchemy-convex-smoke",
    });
    return {
      projectId: project.projectId,
      slug: project.slug,
      prodDeploymentUrl: project.prodDeploymentUrl,
    };
  }),
);
