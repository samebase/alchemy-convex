import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Convex codegen writes src/store/convex/_generated and src/store/component/_generated.
    ignorePatterns: ["test/fixtures/**", "src/store/*/_generated/**"],
  },
  lint: {
    ignorePatterns: ["test/fixtures/**", "src/store/*/_generated/**"],
    options: { typeAware: true },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    outDir: "lib",
    // "type": "module" makes the ESM output `index.js`, the file that `exports` names.
    fixedExtension: false,
    sourcemap: true,
    dts: { sourcemap: true },
    publint: true,
    // The package is ESM only, so the CommonJS resolution modes do not apply.
    attw: { profile: "esm-only" },
    // A publint or attw finding fails the build.
    failOnWarn: true,
  },
  staged: {
    "*": "vp check --fix",
  },
});
