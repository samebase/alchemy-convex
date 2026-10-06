// One Convex app end to end on Cloudflare. The stage `prod` owns the Convex
// project and pushes to its production deployment. Every other stage, such as
// `pr-42`, pushes to a preview deployment of that project, named after the
// stage, and deletes it on `alchemy destroy`. The Vite site gets the URLs of
// the deployment at build time.
//
//   npx alchemy deploy --stage prod
//   npx alchemy deploy --stage pr-42
//   npx alchemy destroy --stage pr-42
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Convex from "../../src/index.ts"; // in your app: "@samebase/alchemy-convex"

/** The project, its production deployment, a deploy key, and the push. */
const production = Effect.gen(function* () {
  const project = yield* Convex.Project("Project", { team: 38516, name: "score-four" });
  const prod = yield* Convex.Deployment("Prod", { projectId: project.projectId, type: "prod" });
  const key = yield* Convex.DeployKey("DeployKey", {
    deployment: prod.name,
    name: "alchemy",
    allowedActions: ["deployment:deploy", "deployment:env:view", "deployment:env:write"],
  });
  return yield* Convex.Code("Backend", { deployment: prod, deployKey: key.deployKey, cwd: "." });
});

/** A preview deployment of the project that the stage `prod` owns, and the push. */
const preview = (stage: string) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project.ref("Project", { stage: "prod" });
    const deployment = yield* Convex.Deployment("Preview", {
      projectId: project.projectId,
      type: "preview",
      name: stage,
    }).pipe(RemovalPolicy.destroy());
    const key = yield* Convex.PreviewDeployKey("PreviewDeployKey", {
      projectId: project.projectId,
      name: "alchemy",
    });
    return yield* Convex.Code("Backend", {
      deployment,
      deployKey: key.previewDeployKey,
      cwd: ".",
    });
  });

export default Alchemy.Stack(
  "ConvexApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const backend = stage === "prod" ? yield* production : yield* preview(stage);
    const site = yield* Cloudflare.Website.Vite("Site", {
      env: { VITE_CONVEX_URL: backend.url, VITE_CONVEX_SITE_URL: backend.siteUrl },
    });
    return { url: site.url, convexUrl: backend.url };
  }),
);
