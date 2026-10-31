#!/usr/bin/env node
// The commands of the package:
//
//   alchemy-convex hub-client --team <team> --app <app> --callback-path <path>
//   alchemy-convex stack-comment [--team <team>]
//
// hub-client runs in the directory of a Convex app, and gives the development deployment of that
// directory a client of the identity hub of the team: see registerDevelopmentClient. stack-comment
// runs as a step of a pull request workflow after the deploys, and keeps one comment with the stacks
// of the repository: see src/StackComment.ts. It needs GITHUB_TOKEN and, with a team access token,
// no --team. Both use CONVEX_ACCESS_TOKEN or the Convex CLI login.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { fromConfig } from "./Credentials.ts";
import { registerDevelopmentClient } from "./HubClient.ts";
import { ManagementApiLive } from "./ManagementApi.ts";
import { installedCli } from "./Push.ts";
import { updateStackComment } from "./StackComment.ts";
import { state } from "./State.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    team: { type: "string" },
    app: { type: "string" },
    "callback-path": { type: "string" },
  },
});
const { team, app, "callback-path": callbackPath } = values;
const USAGE = `Usage:
  alchemy-convex hub-client --team <team> --app <app> --callback-path <path>
  alchemy-convex stack-comment [--team <team>]`;

const hubClient = (hub: { team: string; app: string; callbackPath: string }) =>
  Effect.gen(function* () {
    const [command, ...prefix] = yield* installedCli(process.cwd());
    const callbackUrl = yield* registerDevelopmentClient({
      ...hub,
      convex: (args, input) =>
        execFileSync(command, [...prefix, ...args], {
          encoding: "utf8",
          input,
          stdio: ["pipe", "pipe", "inherit"],
        }).trim(),
    });
    console.log(
      callbackUrl === undefined
        ? "Hub client already registered."
        : `Hub client registered for ${callbackUrl}.`,
    );
  }).pipe(Effect.provide(ManagementApiLive().pipe(Layer.provide(fromConfig()))));

const stackComment = (options: { team?: string }) =>
  updateStackComment.pipe(
    Effect.tap((url) => Effect.sync(() => console.log(url))),
    Effect.provide(state(options).pipe(Layer.provide(NodeServices.layer))),
  );

const subcommand = positionals.join(" ");
const program: Effect.Effect<unknown, unknown> | undefined =
  subcommand === "stack-comment"
    ? stackComment(team === undefined ? {} : { team })
    : subcommand === "hub-client" &&
        team !== undefined &&
        app !== undefined &&
        callbackPath !== undefined
      ? hubClient({ team, app, callbackPath })
      : undefined;
if (program === undefined) {
  console.error(USAGE);
  process.exit(1);
}

await Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
