# Examples

Each folder is a complete `alchemy.run.ts` that imports this package from source, so it tracks
the checkout. In your own app replace the import with `@samebase/alchemy-convex`.

- `app/`: a Convex app end to end on Cloudflare. The stage `prod` takes over an existing project
  and pushes `./convex` to its production deployment; every other stage pushes to a preview
  deployment named after the stage. A Vite site gets the URLs. It shows the shape; it needs a Vite
  app and a Convex project next to it to deploy.
- `project/`: one Convex project with local state. Run `npx alchemy deploy --stage dev` inside
  the folder, then `npx alchemy destroy --stage dev`. Needs a Convex login or
  `CONVEX_ACCESS_TOKEN`.
