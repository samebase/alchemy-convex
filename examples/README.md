# Examples

Each folder is a complete `alchemy.run.ts` that imports this package from source, so it tracks
the checkout. In your own app replace the import with `@samebase/alchemy-convex`.

- `project/`: one Convex project with local state. Run `npx alchemy deploy --stage dev` inside
  the folder, then `npx alchemy destroy --stage dev`. Needs a Convex login or
  `CONVEX_ACCESS_TOKEN`.
