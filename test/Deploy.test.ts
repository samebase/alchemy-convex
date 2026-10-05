import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandExecutor } from "alchemy/Command";
import { hashDirectory } from "alchemy/Command/Memo";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Deploy,
  type DeployProps,
  DeployProvider,
  deployArgs,
  parseDeployOutput,
} from "../src/Deploy.ts";

// Real `npx convex deploy` stderr (convex 1.45.0) through pipes, as Alchemy's
// CommandExecutor receives it, against the throwaway dev deployment
// beaming-okapi-932. The `-` line is the spinner when stderr is not a TTY.
const PIPED_STDERR = `npm warn Unknown env config "manage-package-manager-versions". This will stop working in the next major version of npm.
▌ Deploying code to deployment:
▌ [Development] samebase-live-tests:tmp-alchemy-spike-base:dev/nicu (dev) (dashboard: https://dashboard.convex.dev/t/samebase-live-tests/tmp-alchemy-spike-base/beaming-okapi-932)
▌ └─ https://beaming-okapi-932.convex.cloud
- Deploying to https://beaming-okapi-932.convex.cloud...

\u001b[36mA minor update is available for Convex\u001b[39m \u001b[2m(1.45.0 → 1.46.0)\u001b[22m
\u001b[2mChangelog:\u001b[22m \u001b[4mhttps://github.com/get-convex/convex-js/blob/main/CHANGELOG.md#changelog\u001b[24m
Your Convex AI files are out of date. Run npx convex ai-files update to get the latest.
✔ No indexes are deleted by this push
Uploading functions to Convex...
Generating TypeScript bindings...
Running TypeScript...
Pushing code to your Convex deployment...
Schema validation complete.
Finalizing push...
✔ Deployed Convex functions to https://beaming-okapi-932.convex.cloud
`;

// The same deploy through a pseudo-terminal: OSC 8 hyperlinks, cursor
// control, spinner frames, and CRLF line endings.
const TTY_OUTPUT = `▌ Deploying code to deployment:\r
▌ [Development] samebase-live-tests:tmp-alchemy-spike-base:dev/nicu (dev) (\u001b]8;;https://dashboard.convex.dev/t/samebase-live-tests/tmp-alchemy-spike-base/beaming-okapi-932\u001b\\dashboard\u001b]8;;\u001b\\)\r
▌ └─ \u001b]8;;https://beaming-okapi-932.convex.cloud\u001b\\https://beaming-okapi-932.convex.cloud\u001b]8;;\u001b\\\r
\u001b[?25l\u001b[1G⠋ Deploying to https://beaming-okapi-932.convex.cloud...\r
\u001b[1G⠙ Bundling component schemas and implementations...\r
\u001b[1G⠹ Downloading current deployment state...\r
\u001b[1G\u001b[36mA minor update is available for Convex\u001b[39m \u001b[2m(1.45.0 → 1.46.0)\u001b[22m\r
\u001b[2mChangelog:\u001b[22m \u001b[4mhttps://github.com/get-convex/convex-js/blob/main/CHANGELOG.md#changelog\u001b[24m\r
\u001b[1GYour Convex AI files are out of date. Run npx convex ai-files update to get the latest.\r
\u001b[1G⠸ Downloading current deployment state...\r
\u001b[1G⠼ Verifying that the push isn’t deleting large indexes...\r
\u001b[1G⠴ Verifying that the push isn’t deleting large indexes...\r
\u001b[1G⠦ Verifying that the push isn’t deleting large indexes...\r
\u001b[1G⠧ Verifying that the push isn’t deleting large indexes...\r
\u001b[1G⠇ Verifying that the push isn’t deleting large indexes...\r
\u001b[1G⠏ Verifying that the push isn’t deleting large indexes...\r
\u001b[1G\u001b[?25h✔ No indexes are deleted by this push\r
Uploading functions to Convex...\r
Generating TypeScript bindings...\r
Running TypeScript...\r
Pushing code to your Convex deployment...\r
Schema validation complete.\r
Finalizing push...\r
✔ Deployed Convex functions to https://beaming-okapi-932.convex.cloud\r
\u001b[?25h\\\u001b[1G\u001b[0K`;

const DEPLOYED_LINE = "✔ Deployed Convex functions to https://beaming-okapi-932.convex.cloud";

describe("parseDeployOutput", () => {
  it("reads the URL from the piped CLI output", () => {
    expect(parseDeployOutput(PIPED_STDERR)).toEqual({
      url: "https://beaming-okapi-932.convex.cloud",
      deploymentName: "beaming-okapi-932",
    });
  });

  it("reads the URL from terminal output with escape codes and spinner frames", () => {
    expect(parseDeployOutput(TTY_OUTPUT)).toEqual({
      url: "https://beaming-okapi-932.convex.cloud",
      deploymentName: "beaming-okapi-932",
    });
  });

  it("reads a preview deployment URL", () => {
    const preview = PIPED_STDERR.replace(
      DEPLOYED_LINE,
      "✔ Deployed Convex functions to https://flippant-cardinal-923.convex.cloud",
    );
    expect(parseDeployOutput(preview)).toEqual({
      url: "https://flippant-cardinal-923.convex.cloud",
      deploymentName: "flippant-cardinal-923",
    });
  });

  it("reads a regional URL and keeps the region out of the deployment name", () => {
    const regional = PIPED_STDERR.replace(
      DEPLOYED_LINE,
      "\u001b[32m✔\u001b[39m Deployed Convex functions to https://beaming-okapi-932.eu-west-1.convex.cloud",
    );
    expect(parseDeployOutput(regional)).toEqual({
      url: "https://beaming-okapi-932.eu-west-1.convex.cloud",
      deploymentName: "beaming-okapi-932",
    });
  });

  it("finds nothing when the push did not finish, although other lines name the URL", () => {
    expect(parseDeployOutput(PIPED_STDERR.replace(DEPLOYED_LINE, ""))).toBeUndefined();
  });

  it("finds nothing in dry-run output", () => {
    const dryRun = PIPED_STDERR.replace(
      DEPLOYED_LINE,
      "✔ Would have deployed Convex functions to https://beaming-okapi-932.convex.cloud",
    );
    expect(parseDeployOutput(dryRun)).toBeUndefined();
  });
});

describe("deployArgs", () => {
  it("deploys to the deploy key's deployment without preview flags", () => {
    expect(deployArgs({})).toEqual(["npx", "convex", "deploy"]);
  });

  it("names a reused preview deployment", () => {
    expect(deployArgs({ previewName: "feature-login" })).toEqual([
      "npx",
      "convex",
      "deploy",
      "--preview-name",
      "feature-login",
    ]);
  });

  it("recreates a preview deployment and runs a function on it", () => {
    expect(deployArgs({ previewCreate: "pr-42", previewRun: "init:seed" })).toEqual([
      "npx",
      "convex",
      "deploy",
      "--preview-create",
      "pr-42",
      "--preview-run",
      "init:seed",
    ]);
  });

  it("adds extra arguments after the preview flags, in order", () => {
    expect(
      deployArgs({
        extraArgs: ["--typecheck=disable", "--codegen=disable"],
        previewRun: "init:seed",
        previewName: "feature-login",
      }),
    ).toEqual([
      "npx",
      "convex",
      "deploy",
      "--preview-name",
      "feature-login",
      "--preview-run",
      "init:seed",
      "--typecheck=disable",
      "--codegen=disable",
    ]);
  });
});

describe("Deploy diff", () => {
  const { deployKey } = Schema.decodeUnknownSync(Schema.Struct({ deployKey: Schema.String }))(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/management/deployment_create_deploy_key.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  /** A Convex app directory whose hash the last push recorded. */
  const cwd = mkdtempSync(join(tmpdir(), "alchemy-convex-deploy-"));
  writeFileSync(join(cwd, "convex.json"), "{}\n");
  afterAll(() => rmSync(cwd, { recursive: true }));

  /** The diff never runs a command. */
  const noCommands = Layer.succeed(CommandExecutor, {
    spawn: () => Effect.die("Deploy diff spawned a command"),
    run: () => Effect.die("Deploy diff ran a command"),
  });
  /** The diff of unchanged props after a push of the same files. */
  const diffOf = (props: Omit<DeployProps, "deployKey" | "cwd">) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Provider.Provider<Deploy>("Convex.Deploy");
        const news = { ...props, deployKey: Redacted.make(deployKey), cwd };
        const hash = yield* hashDirectory({ cwd, memo: {} });
        return yield* (
          service.diff?.({
            id: "Backend",
            fqn: "Backend",
            instanceId: "instance-1",
            olds: news,
            news,
            oldBindings: [],
            newBindings: [],
            output: {
              url: "https://flippant-cardinal-923.convex.cloud",
              deploymentName: "flippant-cardinal-923",
              hash,
            },
          }) ?? Effect.void
        );
      }).pipe(
        Effect.provide(DeployProvider().pipe(Layer.provide(noCommands))),
        // The hash reads files.
        Effect.provide(NodeServices.layer),
      ),
    );

  it("skips the push of unchanged files to a deployment", async () => {
    expect(await diffOf({})).toEqual({ action: "noop" });
  });

  it("always pushes a named preview, because the preview can have expired", async () => {
    expect(await diffOf({ previewName: "feature-login" })).toEqual({ action: "update" });
  });

  it("always pushes a recreated preview", async () => {
    expect(await diffOf({ previewCreate: "pr-42" })).toEqual({ action: "update" });
  });
});
