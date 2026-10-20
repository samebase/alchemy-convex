# AGENTS.md

`@samebase/alchemy-convex` is a community Alchemy v2 provider for Convex. It is pinned to
`alchemy@2.0.0-beta.83` and Effect 4.

## Ownership rule

- This package manages only the Convex plane: projects, deployments, their environment variables,
  and the push of the functions inside `Convex.Deployment`. See `docs/design/convex-plane.md`.
- `Convex.state()` keeps Alchemy state in the `alchemyState` component (`src/component/`). Convex
  codegen writes `src/component/_generated/`. See `docs/design/convex-state.md`.
- The Convex CLI owns typecheck, codegen, bundling, and the code push. `Convex.Deployment` only runs
  the installed `convex deploy`. Do not move work of the Convex CLI into this package.
- Credentials are a layer, never props. No deploy key goes from one resource to another, and the
  only key the provider deletes is the short-lived push key that it created.

## Commands

- Vite+ (`vp`) owns format, lint, test, and build.
- `pnpm run check`: format check, lint, typecheck, and unit tests. Run it before each commit.
- `pnpm run format`: format the files.
- `pnpm run build`: write `lib/` with `vp pack`. publint and attw then check the package.
- The pre-commit hook runs `vp staged`. The `prepare` script installs the hook.

## Tests

- Unit tests read recorded real Management API payloads in `test/fixtures/management/`, and
  recorded function API payloads in `test/fixtures/state/`.
- Make a negative case from a changed recorded payload. Do not write a fixture from scratch.
- Replace each secret value with `REDACTED`. Do not commit a token, a deploy key, or other secrets.
- Live tests make real API calls. They run only with `ALCHEMY_CONVEX_LIVE=1` (`pnpm run test:live`).

## Automation and docs

- Write automation in TypeScript under `scripts/`. Node 24 from `.node-version` runs it.
- Automation must work on macOS, Linux, and Windows without Bash or PowerShell.
- Do not add authored `.js`, `.mjs`, or `.cjs` files.
- Write docs in ASD-STE100 Simplified Technical English. Do not use the em dash character.

## Releases

- The pull request that is the release carries the `version` change in `package.json` and the
  `CHANGELOG.md` entry; a separate version-only pull request is not needed.
- After the merge, `.github/workflows/release.yml` publishes that version from `main` to npm.
