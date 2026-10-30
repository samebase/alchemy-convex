#!/usr/bin/env node
// The command of the package:
//
//   alchemy-convex hub-client --team <team> --app <app> --callback-path <path>
//
// It runs in the directory of a Convex app, and gives the development deployment of that directory
// a client of the identity hub of the team: see registerDevelopmentClient. It uses
// CONVEX_ACCESS_TOKEN or the Convex CLI login.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { fromConfig } from "./Credentials.ts";
import { registerDevelopmentClient } from "./HubClient.ts";
import { ManagementApiLive } from "./ManagementApi.ts";
import { installedCli } from "./Push.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    team: { type: "string" },
    app: { type: "string" },
    "callback-path": { type: "string" },
  },
});
const { team, app, "callback-path": callbackPath } = values;
if (
  positionals.join(" ") !== "hub-client" ||
  team === undefined ||
  app === undefined ||
  callbackPath === undefined
) {
  console.error(
    "Usage: alchemy-convex hub-client --team <team> --app <app> --callback-path <path>",
  );
  process.exit(1);
}

const program = Effect.gen(function* () {
  const [command, ...prefix] = yield* installedCli(process.cwd());
  const callbackUrl = yield* registerDevelopmentClient({
    team,
    app,
    callbackPath,
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

await Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
