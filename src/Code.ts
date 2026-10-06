// Convex.Code: pushes the functions of a Convex app to one deployment with
// the Convex CLI that the app has installed, and exposes the URLs that a
// frontend or a Worker needs.
//
// - Every apply pushes. The resource does not hash the sources: a preview
//   deployment can expire, a push from outside Alchemy can change the
//   deployment, and a hash of the app directory misses changes in workspace
//   packages. The Convex CLI uploads only the modules that changed.
// - The CLI is the `convex` package that `cwd` resolves, run with the Node.js
//   that runs Alchemy. Nothing is downloaded. The `command` prop replaces it.
// - The deploy key reaches the CLI only through an env file (`--env-file`)
//   with mode 0600 in a new temporary directory. The directory is removed
//   after the run, on success, on failure, and on interruption. It is also the
//   home directory of the CLI, so the CLI cannot read the Convex login of this
//   machine and pushes with the deploy key only. Variables named `CONVEX_*`
//   are not passed on to the CLI.
// - The CLI output stays out of the logs. A failure shows its last lines with
//   the deploy key removed.
// - Before the push, the key must fit the deployment: a deploy key of that
//   deployment, or a preview deploy key for a Convex.Deployment preview. After
//   the push, the deployment that the CLI names must be that deployment.
// - `env` variables are set on the deployment before the push with the deploy
//   key, through the deployment API like Convex.EnvironmentVariable. A
//   variable that exists with another value and that this resource did not
//   set is someone else's: it is overwritten only with --adopt. A name that
//   leaves `env` is removed from the deployment.
// - Delete does nothing. The functions and the variables stay on the
//   deployment: the deployed code can need them.
//
// Patterns from Confect `packages/alchemy/src/Code.ts`,
// `internal/CodeDeployment.ts`, and `internal/CommandRunner.ts`
// (https://github.com/rjdellecese/confect, ISC license).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Resource } from "alchemy";
import { OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { shouldAdopt } from "./Adoption.ts";
import { type DeploymentAttributes, siteUrlOf } from "./Deployment.ts";
import { listVariables, writeVariables } from "./EnvironmentVariable.ts";
import { retryIdempotentWrite } from "./ManagementApi.ts";
import type { Providers } from "./Providers.ts";

/** The attributes of a Convex.Deployment that a push needs. Pass the resource itself. */
export type CodeDeployment = Pick<DeploymentAttributes, "name" | "type" | "url" | "previewName">;

export interface CodeProps {
  /**
   * The deployment that receives the push: a Convex.Deployment resource, or a
   * deployment name such as `happy-animal-123`. A preview deploy key needs the
   * resource. For `env` on a deployment outside US East, pass the resource.
   */
  readonly deployment: string | CodeDeployment;
  /**
   * A deploy key of `deployment` (Convex.DeployKey), or, for a preview
   * deployment, a preview deploy key of its project (Convex.PreviewDeployKey).
   */
  readonly deployKey: Redacted.Redacted<string>;
  /** The Convex app directory: the one with `convex/` and the `convex` package installed. */
  readonly cwd: string;
  /**
   * The program and first arguments that run the Convex CLI, such as
   * `["pnpm", "exec", "convex"]`. Code adds `deploy` and its flags. By
   * default, the `convex` package that `cwd` resolves, run with this Node.js.
   */
  readonly command?: readonly [string, ...string[]];
  /** Environment variables to set on the deployment before the push. Needs a deploy key of the deployment. */
  readonly env?: Readonly<Record<string, string | Redacted.Redacted<string>>>;
  /** `convex deploy --typecheck`. The CLI default is `try`. */
  readonly typecheck?: "enable" | "try" | "disable";
  /** `convex deploy --codegen`. The CLI default is `enable`. */
  readonly codegen?: "enable" | "disable";
}

export interface CodeAttributes {
  /** The deployment that received the push, such as `happy-animal-123`. */
  readonly deploymentName: string;
  /** Client URL, such as `https://happy-animal-123.convex.cloud`. */
  readonly url: string;
  /** HTTP actions URL, such as `https://happy-animal-123.convex.site`. */
  readonly siteUrl: string;
  /** When the push finished, in milliseconds since the Unix epoch. */
  readonly deployedAt: number;
  /** The names of the `env` variables that this resource set on the deployment, sorted. */
  readonly envNames: readonly string[];
}

export type Code = Resource<"Convex.Code", CodeProps, CodeAttributes, never, Providers>;
export const Code = Resource<Code>("Convex.Code");

/**
 * The CLI prints this line with `logFinishedStep` after the push succeeds, to
 * stderr (convex 1.46 `cli/lib/deploy2.js` for existing deployments,
 * `cli/deploy.js` for preview deployments). The host is
 * `<deployment>.convex.cloud` or `<deployment>.<region>.convex.cloud`.
 */
const DEPLOYED_LINE =
  /Deployed Convex functions to (https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.convex\.cloud)\/?(?=\s|$)/m;

/** Reads the deployment URL from `convex deploy` output. ANSI escape codes are removed first. */
export const parseDeployOutput = (
  text: string,
): { url: string; deploymentName: string } | undefined => {
  const match = DEPLOYED_LINE.exec(stripVTControlCharacters(text));
  const url = match?.[1];
  const deploymentName = match?.[2];
  return url === undefined || deploymentName === undefined ? undefined : { url, deploymentName };
};

/**
 * What a deploy key targets, from its prefix: `<type>:<deployment>|<secret>`
 * (or `<deployment>|<secret>` in old keys) for one deployment,
 * `preview:<team>:<project>|<secret>` for preview deployments of a project,
 * `project:<team>:<project>|<secret>` for the project's production
 * deployment. Same rules as convex 1.46 `cli/lib/deployment.js`.
 */
export const keyTargetOf = (
  key: string,
):
  | { readonly kind: "deployment"; readonly deployment: string }
  | { readonly kind: "preview" | "project" | "unknown" } => {
  const bar = key.indexOf("|");
  // A key in the env file must be one unquoted dotenv value.
  if (bar <= 0 || /[\s#'"`]/.test(key)) return { kind: "unknown" };
  const parts = key.slice(0, bar).split(":");
  const [first, second] = parts;
  if (parts.length === 3 && first === "preview") return { kind: "preview" };
  if (parts.length === 3 && first === "project") return { kind: "project" };
  if (parts.length === 2 && second) return { kind: "deployment", deployment: second };
  if (parts.length === 1 && first) return { kind: "deployment", deployment: first };
  return { kind: "unknown" };
};

/** The deploy key does not fit the deployment. Checked before the push. */
export class DeployKeyMismatch extends Schema.TaggedError<DeployKeyMismatch>()(
  "DeployKeyMismatch",
  {
    /** The deployment that should receive the push. */
    deployment: Schema.String,
    /** What the key targets. */
    key: Schema.Literals(["deployment", "preview", "project", "unknown"]),
    /** For a deployment key: the deployment in the key prefix. Never the secret. */
    keyDeployment: Schema.UndefinedOr(Schema.String),
  },
) {
  override get message() {
    switch (this.key) {
      case "deployment":
        return `The deploy key is for deployment ${this.keyDeployment}, not for ${this.deployment}. Pass a deploy key of ${this.deployment}, such as Convex.DeployKey with deployment ${this.deployment}.`;
      case "preview":
        return `A preview deploy key pushes to a preview deployment by its preview name, and ${this.deployment} is not a Convex.Deployment of type "preview". Pass the Convex.Deployment preview resource as deployment, or a deploy key of ${this.deployment}.`;
      case "project":
        return `Convex.Code does not take a project deploy key: it cannot check before the push that the key targets ${this.deployment}. Pass a deploy key of ${this.deployment} (Convex.DeployKey).`;
      case "unknown":
        return `deployKey is not a Convex deploy key ("<type>:<deployment>|<secret>" or "preview:<team>:<project>|<secret>"). Pass Convex.DeployKey(...).deployKey or Convex.PreviewDeployKey(...).previewDeployKey.`;
    }
  }
}

/** `env` needs the deployment API, which takes only a deploy key of the deployment. */
export class EnvironmentNeedsDeployKey extends Schema.TaggedError<EnvironmentNeedsDeployKey>()(
  "EnvironmentNeedsDeployKey",
  { deployment: Schema.String },
) {
  override get message() {
    return `Convex.Code cannot set or remove env variables on ${this.deployment} with a preview deploy key: the deployment API takes only a deploy key of the deployment. Pass a Convex.DeployKey of ${this.deployment}, or use Convex.DefaultEnvironmentVariable with deploymentType "preview" for values that every new preview deployment gets.`;
  }
}

/** No `convex` package resolves from `cwd`. */
export class ConvexCliNotFound extends Schema.TaggedError<ConvexCliNotFound>()(
  "ConvexCliNotFound",
  { cwd: Schema.String },
) {
  override get message() {
    return `Convex.Code found no installed convex package from ${this.cwd}, and it does not download one. Install convex in the app (npm install convex), set cwd to the app directory, or set the command prop.`;
  }
}

/** The Convex CLI failed, or exited 0 without the deployment URL. The output tail never contains the key. */
export class CodePushFailed extends Schema.TaggedError<CodePushFailed>()("CodePushFailed", {
  /** Exit code of the CLI. Undefined when it did not start or a signal stopped it. */
  exitCode: Schema.UndefinedOr(Schema.Number),
  /** The last lines of the CLI output, with the deploy key removed. */
  outputTail: Schema.String,
}) {
  override get message() {
    return this.exitCode === 0
      ? `convex deploy exited 0 but printed no "Deployed Convex functions to <url>" line, so Convex.Code has no deployment URL. Last output, with the deploy key removed:\n${this.outputTail}`
      : `convex deploy failed${this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`}. Last output, with the deploy key removed:\n${this.outputTail}`;
  }
}

/** The CLI pushed to another deployment than the one in the props. Checked after the push. */
export class PushTargetMismatch extends Schema.TaggedError<PushTargetMismatch>()(
  "PushTargetMismatch",
  { expected: Schema.String, actual: Schema.String },
) {
  override get message() {
    return `The Convex CLI pushed the functions to deployment ${this.actual}, but Convex.Code expected ${this.expected}. With a preview deploy key, this happens when the key belongs to another project, or when the preview deployment ${this.expected} expired during the deploy and the CLI created ${this.actual} for the same preview name. Check the key. After an expiry, run the deploy again with --adopt, so that Convex.Deployment takes over ${this.actual}.`;
  }
}

/**
 * Checks that the key fits the deployment, and returns the preview name for
 * `--preview-name` when the key is a preview deploy key.
 */
const previewNameFor = (
  target: {
    readonly name: string;
    readonly type: CodeDeployment["type"] | undefined;
    readonly previewName: string | undefined;
  },
  keyTarget: ReturnType<typeof keyTargetOf>,
  changesEnvironment: boolean,
): Effect.Effect<string | undefined, DeployKeyMismatch | EnvironmentNeedsDeployKey> => {
  const mismatch = new DeployKeyMismatch({
    deployment: target.name,
    key: keyTarget.kind,
    keyDeployment: keyTarget.kind === "deployment" ? keyTarget.deployment : undefined,
  });
  switch (keyTarget.kind) {
    case "deployment":
      return keyTarget.deployment === target.name
        ? Effect.succeed(undefined)
        : Effect.fail(mismatch);
    case "preview":
      if (target.type !== "preview" || target.previewName === undefined) {
        return Effect.fail(mismatch);
      }
      return changesEnvironment
        ? Effect.fail(new EnvironmentNeedsDeployKey({ deployment: target.name }))
        : Effect.succeed(target.previewName);
    case "project":
    case "unknown":
      return Effect.fail(mismatch);
    default:
      return keyTarget satisfies never;
  }
};

/** Number of output lines that a failure quotes. */
const OUTPUT_TAIL_LINES = 20;

/** The last non-empty lines of `text`, without escape codes and with every secret replaced. */
const outputTail = (text: string, secrets: readonly string[]) =>
  secrets
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      stripVTControlCharacters(text),
    )
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() !== "")
    .slice(-OUTPUT_TAIL_LINES)
    .join("\n");

const CliManifest = Schema.Struct({
  bin: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
});

/** `[node, <convex bin>]` for the `convex` package that `cwd` resolves. Never downloads. */
const installedCli = (cwd: string) =>
  Effect.tryPromise({
    try: async (): Promise<readonly [string, ...string[]]> => {
      const manifestPath = createRequire(join(cwd, "package.json")).resolve("convex/package.json");
      const { bin } = Schema.decodeUnknownSync(Schema.fromJsonString(CliManifest))(
        await readFile(manifestPath, "utf8"),
      );
      const entry = typeof bin === "string" ? bin : bin["convex"];
      if (entry === undefined) throw new Error("the convex package has no convex bin");
      return [process.execPath, resolve(dirname(manifestPath), entry)];
    },
    catch: () => new ConvexCliNotFound({ cwd }),
  });

/**
 * Runs `use` with an env file that holds the key, in a new temporary
 * directory, and removes the directory afterwards: on success, on failure,
 * and on interruption.
 */
const withKeyFile = <A, E, R>(
  key: string,
  use: (paths: { readonly envFile: string; readonly home: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "alchemy-convex-"))),
    (home) =>
      Effect.promise(() =>
        writeFile(join(home, "deploy.env"), `CONVEX_DEPLOY_KEY=${key}\n`, { mode: 0o600 }),
      ).pipe(Effect.andThen(use({ envFile: join(home, "deploy.env"), home }))),
    (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
  );

/**
 * The environment of the CLI: this process's variables without `CONVEX_*`,
 * with `home` as the home directory.
 */
const cliEnvironment = (home: string): Record<string, string | undefined> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("CONVEX_")),
  ),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
});

export const CodeProvider = () =>
  Provider.effect(
    Code,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Runs the CLI with piped output. Interruption stops its process group. */
      const run = (argv: readonly [string, ...string[]], cwd: string, home: string) =>
        Effect.gen(function* () {
          const [command, ...args] = argv;
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd,
              env: cliEnvironment(home),
              extendEnv: false,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
          const [exitCode, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              Stream.mkString(Stream.decodeText(child.stdout)),
              Stream.mkString(Stream.decodeText(child.stderr)),
            ],
            { concurrency: "unbounded" },
          );
          return { exitCode: Number(exitCode), output: `${stdout}\n${stderr}` };
        }).pipe(Effect.scoped);

      return {
        // Every apply pushes: see the top of this file.
        diff: () => Effect.succeed({ action: "update" } as const),

        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          const target =
            typeof news.deployment === "string"
              ? {
                  name: news.deployment,
                  address: news.deployment,
                  type: undefined,
                  previewName: undefined,
                }
              : { ...news.deployment, address: news.deployment.url };
          const key = Redacted.value(news.deployKey);
          const secrets = [key, key.slice(key.indexOf("|") + 1)].filter(
            (secret) => secret.length >= 8,
          );
          const env = Object.entries(news.env ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
          // Names set on another deployment stay there: this push does not own them.
          const previous =
            output !== undefined && output.deploymentName === target.name ? output.envNames : [];
          const removed = previous.filter((name) => !env.some(([envName]) => envName === name));

          // 1. The key must fit the deployment. No side effect before this.
          const previewName = yield* previewNameFor(
            target,
            keyTargetOf(key),
            env.length > 0 || removed.length > 0,
          );

          // 2. The CLI must exist before any variable changes.
          const cwd = resolve(news.cwd);
          const program = news.command ?? (yield* installedCli(cwd));

          // 3. Variables before the push, so the push sees them. Each
          // attempt checks first, so a retry after a write conflict never
          // overwrites a value that another writer set in the meantime.
          if (env.length > 0 || removed.length > 0) {
            const adopt = yield* shouldAdopt(fqn);
            const fresh = env.filter(([name]) => !previous.includes(name));
            yield* retryIdempotentWrite(
              Effect.gen(function* () {
                if (fresh.length > 0 && !adopt) {
                  const current = yield* listVariables(target.address, news.deployKey);
                  // The same value loses nothing, such as a value that an
                  // earlier run set before its push failed.
                  const taken = fresh
                    .filter(
                      ([name, value]) =>
                        Object.hasOwn(current, name) &&
                        current[name] !==
                          (Redacted.isRedacted(value) ? Redacted.value(value) : value),
                    )
                    .map(([name]) => name);
                  if (taken.length > 0) {
                    return yield* new OwnedBySomeoneElse({
                      message: `Environment variables ${taken.join(", ")} already exist on deployment ${target.name} with other values. Re-run with --adopt to take them over and overwrite them, or remove them from env.`,
                      resourceType: Code.Type,
                      physicalName: target.name,
                    });
                  }
                }
                yield* writeVariables(target.address, news.deployKey, [
                  ...env.map(([name, value]) => ({ name, value })),
                  ...removed.map((name) => ({ name, value: null })),
                ]);
              }),
            );
          }

          // 4. The push.
          const args = [
            "deploy",
            ...(previewName === undefined ? [] : ["--preview-name", previewName]),
            ...(news.typecheck === undefined ? [] : [`--typecheck=${news.typecheck}`]),
            ...(news.codegen === undefined ? [] : [`--codegen=${news.codegen}`]),
          ];
          const result = yield* withKeyFile(key, ({ envFile, home }) =>
            run([...program, ...args, "--env-file", envFile], cwd, home),
          ).pipe(
            Effect.mapError(
              (error) =>
                new CodePushFailed({
                  exitCode: undefined,
                  outputTail: outputTail(error.message, secrets),
                }),
            ),
          );
          const deployed = parseDeployOutput(result.output);
          if (result.exitCode !== 0 || deployed === undefined) {
            return yield* new CodePushFailed({
              exitCode: result.exitCode,
              outputTail: outputTail(result.output, secrets),
            });
          }
          if (deployed.deploymentName !== target.name) {
            return yield* new PushTargetMismatch({
              expected: target.name,
              actual: deployed.deploymentName,
            });
          }
          return {
            deploymentName: deployed.deploymentName,
            url: deployed.url,
            siteUrl: siteUrlOf(deployed.url),
            deployedAt: yield* Clock.currentTimeMillis,
            envNames: env.map(([name]) => name),
          };
        }),

        // The functions and the variables stay: the deployment runs them.
        delete: () => Effect.void,
      };
    }),
  );
