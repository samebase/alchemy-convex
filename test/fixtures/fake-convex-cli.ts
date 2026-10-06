// A stand-in for the Convex CLI in the Convex.Code unit tests, which run it
// through the `command` prop: `node fake-convex-cli.ts deploy ... --env-file <path>`.
// It appends one JSON line per run to ALCHEMY_CONVEX_FAKE_CLI_LOG and acts by
// ALCHEMY_CONVEX_FAKE_CLI_MODE:
// - "ok": prints the line of a finished push, like convex 1.46. The deployment
//   is the one in the key prefix, or ALCHEMY_CONVEX_FAKE_CLI_PREVIEW for
//   `--preview-name`.
// - "other": prints the line of a push to another deployment.
// - "fail": prints the deploy key, like a CLI that echoes its input, and exits 1.
// - "hang": waits until it is stopped.
// The log records a SHA-256 hash of the key in the env file, never the key.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const envFile = args[args.indexOf("--env-file") + 1] ?? "";
const key = /^CONVEX_DEPLOY_KEY=(.*)$/m.exec(readFileSync(envFile, "utf8"))?.[1] ?? "";
const mode = process.env["ALCHEMY_CONVEX_FAKE_CLI_MODE"] ?? "ok";
const previewName = args.includes("--preview-name")
  ? args[args.indexOf("--preview-name") + 1]
  : undefined;
const deployment =
  previewName === undefined
    ? key.slice(0, key.indexOf("|")).split(":").at(-1)
    : process.env["ALCHEMY_CONVEX_FAKE_CLI_PREVIEW"];

appendFileSync(
  process.env["ALCHEMY_CONVEX_FAKE_CLI_LOG"] ?? "",
  `${JSON.stringify({
    args,
    envFile,
    envFileMode: (statSync(envFile).mode & 0o777).toString(8),
    keySha256: createHash("sha256").update(key).digest("hex"),
    home: process.env["HOME"],
    convexVariables: Object.keys(process.env).filter((name) => name.startsWith("CONVEX_")),
    cwd: process.cwd(),
  })}\n`,
);

const announce = `▌ Deploying code to deployment:\n▌ └─ https://${deployment}.convex.cloud\n`;
switch (mode) {
  case "ok":
    process.stderr.write(
      `${announce}Uploading functions to Convex...\n✔ Deployed Convex functions to https://${deployment}.convex.cloud\n`,
    );
    break;
  case "other":
    process.stderr.write(`✔ Deployed Convex functions to https://other-deployment-123.convex.cloud\n`);
    break;
  case "fail":
    process.stderr.write(`${announce}✖ Error: the key ${key} was rejected\n`);
    process.exitCode = 1;
    break;
  case "hang":
    setTimeout(() => undefined, 60_000);
    break;
  default:
    process.exitCode = 2;
}
