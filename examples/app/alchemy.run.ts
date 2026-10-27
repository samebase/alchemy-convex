// One Convex app end to end on Cloudflare, with Convex as the central plane.
// The stage `prod` takes over the existing Convex project and pushes
// `./convex` to its production deployment. Every other stage, such as
// `pr-42`, pushes to a preview deployment of that project, named after the
// stage, and deletes it on `alchemy destroy`. The Vite site gets the URLs of
// the deployment at build time. No deploy key leaves the Convex resources.
//
//   npx alchemy deploy --stage prod --adopt   # the first time only
//   npx alchemy deploy --stage pr-42
//   npx alchemy destroy --stage pr-42
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Convex from "../../src/index.ts"; // in your app: "@samebase/alchemy-convex"

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const backend =
      stage === "prod"
        ? yield* Convex.Deployment("Backend", {
            // An existing project. A new one: { team: "my-team", name: "my-app" }.
            project: yield* Convex.Project("Project", { team: "my-team", slug: "my-app" }),
            type: "prod",
            source: "./convex",
            env: { AUTH_SECRET: Config.Redacted("AUTH_SECRET") },
          })
        : yield* Convex.Deployment("Backend", {
            // The project that the stage "prod" owns, read from its state.
            project: yield* Convex.Project.ref("Project", { stage: "prod" }),
            type: "preview",
            name: stage, // such as "pr-42"
            source: "./convex",
          }).pipe(RemovalPolicy.destroy());
    const site = yield* Cloudflare.Website.Vite("Site", {
      env: { VITE_CONVEX_URL: backend.url, VITE_CONVEX_SITE_URL: backend.siteUrl },
    });
    return { url: site.url, convexUrl: backend.url };
  }),
);
