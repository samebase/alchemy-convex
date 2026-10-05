// Runs the live tests with ALCHEMY_CONVEX_LIVE=1 in the child environment and
// forwards the exit code. Node starts the Vite+ entry point directly, so no
// shell is needed on macOS, Linux, or Windows.
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const vitePlus = fileURLToPath(import.meta.resolve("vite-plus/bin"));

// A file or name argument replaces the default filter, so that one live file
// can run alone: `pnpm run test:live test/live/safety.live.test.ts`.
const args = process.argv.slice(2);
const filters = args.some((arg) => !arg.startsWith("-")) ? [] : ["test/live"];

spawn(process.execPath, [vitePlus, "test", "--run", ...filters, ...args], {
  env: { ...process.env, ALCHEMY_CONVEX_LIVE: "1" },
  stdio: "inherit",
}).on("close", (code) => {
  process.exitCode = code ?? 1;
});
