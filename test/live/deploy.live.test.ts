// Proves parseDeployOutput against the real Convex CLI. Runs only with
// ALCHEMY_CONVEX_LIVE=1: it mints a deploy key for a throwaway dev deployment,
// pushes a Convex project with `npx convex deploy`, and deletes the key.
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { fromConfig } from "../../src/Credentials.ts";
import { parseDeployOutput } from "../../src/Deploy.ts";
import { absentAsUndefined, ManagementApi, ManagementApiLive } from "../../src/ManagementApi.ts";

const live = process.env.ALCHEMY_CONVEX_LIVE === "1";

/** Dev deployment of the throwaway project 3145389 in team `samebase-live-tests`. */
const DEPLOYMENT = "beaming-okapi-932";

/**
 * Convex project whose `convex/` functions already run on {@link DEPLOYMENT},
 * with its own `node_modules`. It lives outside this repository, so the live
 * run names it: ALCHEMY_CONVEX_LIVE_PROJECT_DIR=/path/to/app.
 */
const projectDir = () => {
  const dir = process.env["ALCHEMY_CONVEX_LIVE_PROJECT_DIR"];
  if (dir === undefined) {
    throw new Error(
      "Set ALCHEMY_CONVEX_LIVE_PROJECT_DIR to a Convex app directory for the live deploy test.",
    );
  }
  return dir;
};

const CreatedKey = Schema.Struct({ deployKey: Schema.String });
const KeyRows = Schema.Array(Schema.Struct({ name: Schema.String }));

interface DeployRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawns the CLI the way Alchemy's CommandExecutor does: no shell, piped output, `process.env` plus the key. */
const runDeploy = (deployKey: Redacted.Redacted<string>) =>
  new Promise<DeployRun>((resolve, reject) => {
    const child = spawn("npx", ["convex", "deploy"], {
      cwd: projectDir(),
      env: { ...process.env, CONVEX_DEPLOY_KEY: Redacted.value(deployKey) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const secret = Redacted.value(deployKey);
      const redact = (text: string) => text.split(secret).join("[REDACTED]");
      resolve({ exitCode, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });

const deployWithTemporaryKey = Effect.gen(function* () {
  const api = yield* ManagementApi;
  const name = `tmp-alchemy-convex-deploy-live-${Date.now()}`;

  // Listed names carry a short id suffix: `<name> (0e71106d)`.
  const keysNamed = api
    .request("list deploy keys", (client) =>
      client.GET("/deployments/{deployment_name}/list_deploy_keys", {
        params: { path: { deployment_name: DEPLOYMENT } },
      }),
    )
    .pipe(
      Effect.map((rows) =>
        Schema.decodeUnknownSync(KeyRows)(rows)
          .map((row) => row.name)
          .filter((listed) => listed === name || listed.startsWith(`${name} (`)),
      ),
    );

  const deleteKeys = Effect.gen(function* () {
    for (const listed of yield* keysNamed) {
      yield* absentAsUndefined(
        api.requestVoid("delete deploy key", (client) =>
          client.POST("/deployments/{deployment_name}/delete_deploy_key", {
            params: { path: { deployment_name: DEPLOYMENT } },
            body: { id: listed },
          }),
        ),
      );
    }
  });

  // Cleanup looks keys up by name, so it also covers a key whose create
  // response failed. A transient HTTP 500 from the Management API once left a
  // key behind, so cleanup retries; the expiry bounds a key it still misses.
  const run = yield* Effect.gen(function* () {
    const created = yield* api.request("create deploy key", (client) =>
      client.POST("/deployments/{deployment_name}/create_deploy_key", {
        params: { path: { deployment_name: DEPLOYMENT } },
        body: { name, expiresAt: Date.now() + 40 * 60 * 1000 },
      }),
    );
    const deployKey = Redacted.make(Schema.decodeUnknownSync(CreatedKey)(created).deployKey);
    return yield* Effect.promise(() => runDeploy(deployKey));
  }).pipe(
    Effect.ensuring(
      deleteKeys.pipe(
        Effect.retry({ times: 2, schedule: Schedule.spaced("2 seconds") }),
        Effect.orDie,
      ),
    ),
  );

  return { ...run, remainingKeys: yield* keysNamed };
});

describe.skipIf(!live)("convex deploy output (live)", () => {
  it("parses the URL the real CLI prints", { timeout: 300_000 }, async () => {
    const result = await Effect.runPromise(
      deployWithTemporaryKey.pipe(
        Effect.provide(ManagementApiLive().pipe(Layer.provide(fromConfig()))),
      ),
    );
    console.info(
      `exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );

    expect(result.exitCode).toBe(0);
    expect(parseDeployOutput(`${result.stdout}\n${result.stderr}`)).toEqual({
      url: `https://${DEPLOYMENT}.convex.cloud`,
      deploymentName: DEPLOYMENT,
    });
    expect(result.remainingKeys).toEqual([]);
  });
});
