// The push of a Convex.Deployment: a short-lived deploy key, the `env`
// variables, and `convex deploy` with the Convex CLI that the app installed.
//
// - The key is created for one push with the Management API credential and
//   deleted after it, also after a failure. It can only deploy and read and
//   write variables (with a push command: every action), and it expires
//   after PUSH_KEY_LIFETIME_MS, so a run that stops before the delete leaves
//   no key that works for long. No key
//   goes into state, into an output, or to another resource.
// - With an OAuth token as the credential, Convex creates no new key: it
//   returns the OAuth token with a new prefix. The push uses it, and the
//   delete is skipped, because it would revoke the OAuth token.
// - The key reaches the CLI only through an env file (`--env-file`) with
//   mode 0600 in a new temporary directory. The directory is removed after
//   the run, on success, on failure, and on interruption. It is also the home
//   directory of the CLI, so the CLI cannot read the Convex login of this
//   machine. Variables named `CONVEX_*` are not passed on to the CLI.
// - The CLI output stays out of the logs. A failure shows its last lines with
//   the key removed.
//
// The CLI runner follows Confect `packages/alchemy/src/internal/CommandRunner.ts`
// (https://github.com/rjdellecese/confect, ISC license, see NOTICE).
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createDeploymentClient } from "@convex-dev/platform";
import type { paths } from "@convex-dev/platform/managementApi";
import { hashDirectory } from "alchemy/Command/Memo";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  absentAsUndefined,
  type ManagementApiService,
  retryIdempotentWrite,
  settle,
  settleVoid,
} from "./ManagementApi.ts";

/** A value of the `env` prop: a string, or a secret such as `Config.Redacted("AUTH_SECRET")`. */
export type EnvValue = string | Redacted.Redacted<string>;

/**
 * The `source` prop: the Convex functions directory relative to the app
 * directory (`rootDir`), such as `./convex`, or that directory with a push
 * command and more files for the content identity.
 */
export type Source =
  | string
  | {
      /** The Convex functions directory relative to the app directory, such as `./convex`. */
      readonly path: string;
      /**
       * Replaces `convex deploy`: a program and its arguments, run in the app
       * directory with CONVEX_DEPLOY_KEY in its environment, such as
       * `["pnpm", "exec", "convex-hosting", "deploy", "--build", "pnpm run build", "--dist", "dist"]`.
       * It must push with `convex deploy`, such as through `--cmd`, so that
       * its output has the CLI's "Deployed Convex functions to" line.
       */
      readonly command?: readonly [string, ...string[]];
      /**
       * The files of the content identity, as globs relative to the app
       * directory, next to `path`, package.json, convex.json, and the
       * lockfile, such as the build inputs `["src/**", "vite.config.ts"]`.
       * By default, every file of the app that git does not ignore.
       */
      readonly include?: readonly string[];
    };

const sourceOf = (source: Source) =>
  typeof source === "string"
    ? { path: source, command: undefined, include: undefined }
    : { path: source.path, command: source.command, include: source.include };

/** Lifetime of a push key. Long enough for a slow push with index backfills. */
export const PUSH_KEY_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** An action of a deploy key, such as `deployment:deploy`, from the generated schema. */
export type DeployKeyAction = NonNullable<
  NonNullable<
    paths["/deployments/{deployment_name}/create_deploy_key"]["post"]["requestBody"]
  >["content"]["application/json"]["allowedActions"]
>[number];

/** The only actions a key for `convex deploy` gets. */
export const PUSH_KEY_ACTIONS = [
  "deployment:deploy",
  "deployment:env:view",
  "deployment:env:write",
] as const satisfies readonly DeployKeyAction[];

/** POST /deployments/{deployment_name}/create_deploy_key */
const CreatedDeployKey = Schema.Struct({ deployKey: Schema.String });

/** GET https://<deployment>.convex.cloud/api/v1/list_environment_variables */
const EnvironmentVariableList = Schema.Struct({
  environmentVariables: Schema.Record(Schema.String, Schema.String),
});

/** No `convex` package resolves from the app directory. */
export class ConvexCliNotFound extends Schema.TaggedError<ConvexCliNotFound>()(
  "ConvexCliNotFound",
  { cwd: Schema.String },
) {
  override get message() {
    return `Convex.Deployment found no installed convex package from ${this.cwd}, and it does not download one. Install convex in the app (npm install convex), or set rootDir to the directory of the app.`;
  }
}

/** The app directory (`rootDir`) has no package.json. */
export class ConvexAppNotFound extends Schema.TaggedError<ConvexAppNotFound>()(
  "ConvexAppNotFound",
  {
    /** The app directory, resolved against the working directory of the deploy. */
    rootDir: Schema.String,
  },
) {
  override get message() {
    return `Convex.Deployment found no package.json in ${this.rootDir}. Set rootDir to the directory of the Convex app, relative to the directory where the deploy runs, such as "apps/web".`;
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
      ? `convex deploy exited 0 but printed no "Deployed Convex functions to <url>" line. Last output, with the deploy key removed:\n${this.outputTail}`
      : `convex deploy failed${this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`}. Last output, with the deploy key removed:\n${this.outputTail}`;
  }
}

/** The CLI pushed to another deployment than the one of the resource. Checked after the push. */
export class PushTargetMismatch extends Schema.TaggedError<PushTargetMismatch>()(
  "PushTargetMismatch",
  { expected: Schema.String, actual: Schema.String },
) {
  override get message() {
    return `The Convex CLI pushed the functions to deployment ${this.actual}, but Convex.Deployment expected ${this.expected}. Check that convex.json does not select another deployment.`;
  }
}

/** Variables in `env` exist on the deployment with other values, and adoption is off. */
export class VariablesOwnedBySomeoneElse extends Schema.TaggedError<VariablesOwnedBySomeoneElse>()(
  "VariablesOwnedBySomeoneElse",
  { deployment: Schema.String, names: Schema.Array(Schema.String) },
) {
  override get message() {
    return `Environment variables ${this.names.join(", ")} already exist on deployment ${this.deployment} with other values. Re-run with --adopt to take them over and overwrite them, or remove them from env.`;
  }
}

/** A preview deploy key cannot set variables: the deployment API takes only a deploy key of the deployment. */
export class EnvironmentNeedsDeployKey extends Schema.TaggedError<EnvironmentNeedsDeployKey>()(
  "EnvironmentNeedsDeployKey",
  { deployment: Schema.String },
) {
  override get message() {
    return `Convex.Deployment cannot set or remove env variables on preview deployment ${this.deployment} with a preview deploy key: Convex lets that key create, push to, and delete preview deployments, but not change their variables. Set CONVEX_ACCESS_TOKEN for this stage, or set the values as project default environment variables for preview deployments in the Convex dashboard.`;
  }
}

/**
 * What a deploy key targets, from its prefix: `<type>:<deployment>|<secret>`
 * (or `<deployment>|<secret>` in old keys) for one deployment, and
 * `preview:<team>:<project>|<secret>` for the preview deployments of a
 * project. Same rules as convex 1.46 `cli/lib/deployment.js`.
 */
export const keyTargetOf = (
  key: string,
):
  | { readonly kind: "deployment"; readonly deployment: string }
  | { readonly kind: "preview"; readonly team: string; readonly project: string }
  | { readonly kind: "other" } => {
  const bar = key.indexOf("|");
  // A key in the env file must be one unquoted dotenv value.
  if (bar <= 0 || /[\s#'"`]/.test(key)) return { kind: "other" };
  const [first, second, third, ...rest] = key.slice(0, bar).split(":");
  if (rest.length > 0) return { kind: "other" };
  if (first === "preview" && second && third)
    return { kind: "preview", team: second, project: third };
  if (third !== undefined) return { kind: "other" };
  if (second) return { kind: "deployment", deployment: second };
  if (first && second === undefined) return { kind: "deployment", deployment: first };
  return { kind: "other" };
};

/**
 * The CLI prints this line with `logFinishedStep` after the push succeeds, to
 * stderr (convex 1.46 `cli/lib/deploy2.js`). The host is
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

const valueOf = (value: EnvValue) => (Redacted.isRedacted(value) ? Redacted.value(value) : value);

/**
 * The app directory: `rootDir` resolved against the working directory of the
 * deploy. It must have a package.json. There is no search above it.
 */
const appDirectoryOf = (rootDir: string) => {
  const directory = resolve(rootDir);
  return Effect.tryPromise({
    try: () => access(join(directory, "package.json")).then(() => directory),
    catch: () => new ConvexAppNotFound({ rootDir: directory }),
  });
};

/** `source` is not the functions directory that the Convex CLI pushes from the app directory. */
export class SourceMismatch extends Schema.TaggedError<SourceMismatch>()("SourceMismatch", {
  /** The app directory, resolved. */
  rootDir: Schema.String,
  source: Schema.String,
  functions: Schema.String,
}) {
  override get message() {
    return `Convex.Deployment source is ${this.source}, but the Convex CLI pushes ${this.functions} from the app directory ${this.rootDir} (the "functions" field of convex.json, or convex/ by default). Set rootDir to the directory of the Convex app, and source to its functions directory relative to rootDir, such as "./convex".`;
  }
}

const ConvexJson = Schema.Struct({ functions: Schema.optionalKey(Schema.String) });

/** Fails with {@link SourceMismatch} when `path` is not the functions directory of the app in `cwd`. */
const checkFunctionsDirectory = (cwd: string, path: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() =>
      readFile(join(cwd, "convex.json"), "utf8").catch(() => undefined),
    );
    const configured =
      text === undefined
        ? undefined
        : Schema.decodeUnknownSync(Schema.fromJsonString(ConvexJson))(text).functions;
    const functions = resolve(cwd, configured ?? "convex");
    if (functions !== path) {
      return yield* new SourceMismatch({ rootDir: cwd, source: path, functions });
    }
  });

const CliManifest = Schema.Struct({
  bin: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
});

/** `[node, <convex bin>]` for the `convex` package that `cwd` resolves. Never downloads. */
export const installedCli = (cwd: string) =>
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
 * The content identity of a push: the files of the app directory that git
 * does not ignore (or `path`, the manifests, and the `include` globs), the
 * nearest lockfile, the target deployment, and the `env` names and values.
 * A change in a workspace package outside the app directory is not seen.
 */
export const pushHash = (options: {
  /** The app directory, relative to the working directory of the deploy or absolute. */
  readonly rootDir: string;
  readonly source: Source | undefined;
  readonly deployment: string;
  readonly env: Readonly<Record<string, EnvValue>>;
}) =>
  Effect.gen(function* () {
    const source = options.source === undefined ? undefined : sourceOf(options.source);
    const files =
      source === undefined
        ? undefined
        : yield* appDirectoryOf(options.rootDir).pipe(
            Effect.flatMap((cwd) => {
              const functions = relative(cwd, resolve(cwd, source.path)).split("\\").join("/");
              return hashDirectory({
                cwd,
                // By default every file of the app that git does not ignore,
                // such as a module outside `source` that a function imports,
                // and the functions when convex.json puts them outside
                // rootDir. `include` narrows it to the functions, the
                // manifests, and the listed globs.
                memo:
                  source.include !== undefined
                    ? {
                        include: [
                          `${functions}/**`,
                          "package.json",
                          "convex.json",
                          ...source.include,
                        ],
                        lockfile: true,
                      }
                    : functions === ".." || functions.startsWith("../")
                      ? { include: ["**/*", `${functions}/**`], lockfile: true }
                      : {},
              });
            }),
          );
    const env = Object.entries(options.env)
      .map(([name, value]): readonly [string, string] => [name, valueOf(value)])
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return createHash("sha256")
      .update(JSON.stringify({ files, deployment: options.deployment, env }))
      .digest("hex");
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

/** This process's variables without `CONVEX_*`, with `home` as the home directory. */
const cliEnvironment = (home: string): Record<string, string | undefined> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("CONVEX_")),
  ),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
});

/**
 * A deploy key of `deployment` that expires after PUSH_KEY_LIFETIME_MS, with
 * only `allowedActions`, or every action when that is undefined. Delete it
 * with {@link deleteDeployKey} when the work is done.
 */
export const createDeployKey = (
  api: ManagementApiService,
  deployment: string,
  name: string,
  allowedActions: readonly DeployKeyAction[] | undefined,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const created = yield* api.request("create deploy key", (client) =>
      client.POST("/deployments/{deployment_name}/create_deploy_key", {
        params: { path: { deployment_name: deployment } },
        body: {
          name,
          ...(allowedActions === undefined ? {} : { allowedActions: [...allowedActions] }),
          expiresAt: now + PUSH_KEY_LIFETIME_MS,
        },
      }),
    );
    return Redacted.make(Schema.decodeUnknownSync(CreatedDeployKey)(created).deployKey);
  });

/**
 * Deletes a key that {@link createDeployKey} made. The delete is skipped for
 * a key that is the OAuth credential. A failed delete is logged: the key
 * expires anyway.
 */
export const deleteDeployKey = (
  api: ManagementApiService,
  deployment: string,
  key: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    if (yield* api.isCredentialToken(Redacted.value(key))) return;
    yield* absentAsUndefined(
      retryIdempotentWrite(
        api.requestVoid("delete deploy key", (client) =>
          client.POST("/deployments/{deployment_name}/delete_deploy_key", {
            params: { path: { deployment_name: deployment } },
            body: { id: Redacted.value(key) },
          }),
        ),
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Convex.Deployment could not delete its key on ${deployment} (${error.message}). The key expires on its own within ${PUSH_KEY_LIFETIME_MS / 60_000} minutes.`,
      ),
    ),
  );

/**
 * Creates a deploy key for one push, runs `use` with it, and deletes it
 * afterwards, also after a failure. `allowedActions` is PUSH_KEY_ACTIONS for
 * `convex deploy`, or undefined for a push command, which can do more than a
 * push, such as the uploads of convex-hosting through `convex run`.
 */
export const withPushKey = <A, E, R>(
  api: ManagementApiService,
  deployment: string,
  allowedActions: readonly DeployKeyAction[] | undefined,
  use: (key: Redacted.Redacted<string>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    createDeployKey(api, deployment, "alchemy-push", allowedActions),
    use,
    (key) => deleteDeployKey(api, deployment, key),
  );

/** Every variable of the deployment with its value. */
const listVariables = (url: string, key: Redacted.Redacted<string>) =>
  settle("list environment variables", () =>
    createDeploymentClient(url, Redacted.value(key)).GET("/list_environment_variables"),
  ).pipe(
    Effect.map(
      (body) => Schema.decodeUnknownSync(EnvironmentVariableList)(body).environmentVariables,
    ),
  );

/** One call that sets variables, or removes those whose value is null. */
const writeVariables = (
  url: string,
  key: Redacted.Redacted<string>,
  changes: ReadonlyArray<{ readonly name: string; readonly value: string | null }>,
) =>
  settleVoid("update environment variables", () =>
    createDeploymentClient(url, Redacted.value(key)).POST("/update_environment_variables", {
      body: { changes: changes.map(({ name, value }) => ({ name, value })) },
    }),
  );

export interface PushOptions {
  /** Deployment name, such as `happy-animal-123`. */
  readonly deployment: string;
  /** Client URL of the deployment. */
  readonly url: string;
  /** The app directory, relative to the working directory of the deploy or absolute. The push runs in it. */
  readonly rootDir: string;
  /** The functions directory relative to `rootDir`, or it with a push command. Without it, only the variables change. */
  readonly source: Source | undefined;
  readonly env: Readonly<Record<string, EnvValue>>;
  /** Names that an earlier push set on this deployment. Names that left `env` are removed. */
  readonly previousEnvNames: readonly string[];
  /** True when the resource may overwrite variables that it did not set. */
  readonly adopt: boolean;
  /**
   * The preview name for `convex deploy --preview-name`, when `key` is a
   * preview deploy key. Such a key cannot set variables.
   */
  readonly previewName: string | undefined;
}

/**
 * The app directory and the program of a push. Fails before any change when
 * `rootDir` has no package.json, when `source` is not the functions directory
 * of the app, or when the app has no installed Convex CLI and no push command.
 */
export const checkSource = (rootDir: string, input: Source) =>
  Effect.gen(function* () {
    const source = sourceOf(input);
    const cwd = yield* appDirectoryOf(rootDir);
    yield* checkFunctionsDirectory(cwd, resolve(cwd, source.path));
    const program = source.command ?? (yield* installedCli(cwd));
    return { cwd, program };
  });

/**
 * Sets the `env` variables and pushes the functions of `source` to one
 * deployment with `key`: a deploy key of the deployment, or a preview deploy
 * key of its project with `previewName`. Returns the URL that the CLI
 * printed, or undefined without `source`.
 */
export const push = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  key: Redacted.Redacted<string>,
  options: PushOptions,
) =>
  Effect.gen(function* () {
    const source = options.source === undefined ? undefined : sourceOf(options.source);
    const resolved =
      options.source === undefined
        ? undefined
        : yield* checkSource(options.rootDir, options.source);
    const cwd = resolved?.cwd;
    const program = resolved?.program;
    const env = Object.entries(options.env).sort(([a], [b]) => (a < b ? -1 : 1));
    const removed = options.previousEnvNames.filter((name) => !Object.hasOwn(options.env, name));

    // 1. Variables before the push, so the push sees them. Each attempt
    // reads the current values first, so a retry after a write conflict never
    // overwrites a value that another writer set in the meantime. Only
    // changed values are written, and the earlier ones are kept for a
    // rollback.
    const written =
      env.length === 0 && removed.length === 0
        ? { current: {}, changes: [] }
        : yield* retryIdempotentWrite(
            Effect.gen(function* () {
              const current = yield* listVariables(options.url, key);
              if (!options.adopt) {
                // The same value loses nothing, such as a value that an
                // earlier run set before its push failed.
                const taken = env
                  .filter(
                    ([name, value]) =>
                      !options.previousEnvNames.includes(name) &&
                      Object.hasOwn(current, name) &&
                      current[name] !== valueOf(value),
                  )
                  .map(([name]) => name);
                if (taken.length > 0) {
                  return yield* new VariablesOwnedBySomeoneElse({
                    deployment: options.deployment,
                    names: taken,
                  });
                }
              }
              const changes = [
                ...env
                  .filter(([name, value]) => current[name] !== valueOf(value))
                  .map(([name, value]) => ({ name, value: valueOf(value) })),
                ...removed
                  .filter((name) => Object.hasOwn(current, name))
                  .map((name) => ({ name, value: null })),
              ];
              if (changes.length > 0) yield* writeVariables(options.url, key, changes);
              return { current, changes };
            }),
          );

    /**
     * After a failed push, the variables go back to their earlier values, so
     * that the deployment matches the hash in state. A failed rollback is
     * logged: the push error is the one to report.
     */
    const rollback =
      written.changes.length === 0
        ? Effect.void
        : retryIdempotentWrite(
            writeVariables(
              options.url,
              key,
              written.changes.map(({ name }) => ({
                name,
                value: Object.hasOwn(written.current, name)
                  ? (written.current[name] ?? null)
                  : null,
              })),
            ),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Convex.Deployment could not set the env variables of ${options.deployment} back after the failed push (${error.message}). Run the deploy again.`,
              ),
            ),
          );

    // 2. The push, with the key only in the env file.
    if (source === undefined || cwd === undefined || program === undefined) return undefined;
    return yield* runPush(spawner, key, { ...options, cwd, program, command: source.command }).pipe(
      Effect.onError(() => rollback),
    );
  });

/** Runs the installed CLI or the push command once, and checks the deployment that it names. */
const runPush = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  key: Redacted.Redacted<string>,
  options: PushOptions & {
    readonly cwd: string;
    readonly program: readonly [string, ...string[]];
    readonly command: readonly [string, ...string[]] | undefined;
  },
) =>
  Effect.gen(function* () {
    const { cwd, program } = options;
    const secret = Redacted.value(key);
    const secrets = [secret, secret.slice(secret.indexOf("|") + 1)].filter(
      (value) => value.length >= 8,
    );
    const result = yield* withKeyFile(secret, ({ envFile, home }) =>
      Effect.gen(function* () {
        const [command, ...programArgs] = program;
        // The installed CLI reads the key from the env file. A push command
        // gets it as CONVEX_DEPLOY_KEY, which the CLI that it runs reads.
        const args =
          options.command === undefined
            ? [
                ...programArgs,
                "deploy",
                ...(options.previewName === undefined
                  ? []
                  : ["--preview-name", options.previewName]),
                "--env-file",
                envFile,
              ]
            : programArgs;
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd,
            env: {
              ...cliEnvironment(home),
              ...(options.command === undefined ? {} : { CONVEX_DEPLOY_KEY: secret }),
            },
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
      }).pipe(Effect.scoped),
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
    if (deployed.deploymentName !== options.deployment) {
      return yield* new PushTargetMismatch({
        expected: options.deployment,
        actual: deployed.deploymentName,
      });
    }
    return deployed.url;
  });
