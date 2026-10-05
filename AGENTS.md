# AGENTS.md

`@samebase/alchemy-convex` is a community Alchemy v2 provider for Convex. It is pinned to
`alchemy@2.0.0-beta.80` and Effect 4.

## Ownership rule

- This package manages only the Convex control plane: projects, deploy keys, environment
  variables, project default environment variables, and the deploy step.
- The Convex CLI owns typecheck, codegen, bundling, and the code push. `Convex.Deploy` only runs
  `npx convex deploy`. Do not move work of the Convex CLI into this package.

## Commands

- Vite+ (`vp`) owns format, lint, test, and build.
- `pnpm run check`: format check, lint, typecheck, and unit tests. Run it before each commit.
- `pnpm run format`: format the files.
- `pnpm run build`: write `lib/` with `vp pack`. publint and attw then check the package.
- The pre-commit hook runs `vp staged`. The `prepare` script installs the hook.

## Tests

- Unit tests read recorded real Management API payloads in `test/fixtures/management/`.
- Make a negative case from a changed recorded payload. Do not write a fixture from scratch.
- Replace each secret value with `REDACTED`. Do not commit a token, a deploy key, or other secrets.
- Live tests make real API calls. They run only with `ALCHEMY_CONVEX_LIVE=1` (`pnpm run test:live`).

## Automation and docs

- Write automation in TypeScript under `scripts/`. Node 24 from `.node-version` runs it.
- Automation must work on macOS, Linux, and Windows without Bash or PowerShell.
- Do not add authored `.js`, `.mjs`, or `.cjs` files.
- Write docs in ASD-STE100 Simplified Technical English. Do not use the em dash character.

## Releases

- To release, change `version` in `package.json` and add a `CHANGELOG.md` entry in a pull request.
- After the merge, `.github/workflows/release.yml` publishes that version from `main` to npm.
- Do not change `version` in other pull requests.
