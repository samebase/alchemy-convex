// The run record: what the stage output says about the run that wrote it.
// Alchemy state holds no time, author, commit, branch, or run (measured in
// the Samebase research of 2026-10-21), so a state layer adds this record to
// the output document under the reserved key `samebase.run`. The record
// depends on no store: it comes from the GitHub Actions variables, or from
// git on a laptop, and holds no secret. See docs/design/convex-state.md.
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { promisify } from "node:util";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The key of the record in the stage output document. */
export const RUN_RECORD_KEY = "samebase.run";

/** The name of the stack file. Alchemy resolves `--config` against the working directory and does not expose it to a state layer, so the record assumes the default name. */
export const STACK_FILE_NAME = "alchemy.run.ts";

/** Version 1 of the record. A reader validates `version` first. */
export interface RunRecord {
  readonly version: 1;
  /** GitHub `owner/name`. */
  readonly repository: string;
  /** Path of the stack file from the repository root, POSIX separators, such as `apps/samebase/alchemy.run.ts`. */
  readonly stackFile: string;
  /** The branch that was deployed: the head branch of a pull request, else the pushed branch. */
  readonly branch: string;
  /** The pull request whose head was deployed, or null for a push and for a laptop. */
  readonly pullRequest: number | null;
  /** The commit that was deployed: the head of the pull request, else GITHUB_SHA, else git HEAD. */
  readonly headCommit: string;
  /** The GitHub Actions run and attempt, or null for a laptop. */
  readonly runUrl: string | null;
  readonly source: "github-actions" | "laptop";
  /** ISO 8601, when the record was written. */
  readonly recordedAt: string;
}

export class RunRecordError extends Schema.TaggedError<RunRecordError>()("RunRecordError", {
  reason: Schema.String,
}) {
  override get message() {
    return `The run record of the stage output cannot be made: ${this.reason}`;
  }
}

/** Where the run happens: the working directory of the stack and the process environment. */
export interface RunEnvironment {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The part of the GitHub Actions event payload that the record reads. A push event has no `pull_request`. */
const EventPayload = Schema.Struct({
  pull_request: Schema.optionalKey(
    Schema.Struct({ number: Schema.Number, head: Schema.Struct({ sha: Schema.String }) }),
  ),
});

/** `owner/name` of an https, ssh, or scp-like git URL with a host. A local path is not one. */
const REMOTE_URL = /^(?:[a-z+]+:\/\/[^/]+\/|[^/@:]+@[^:/]+:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

const execFileAsync = promisify(execFile);

const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

const git = (cwd: string, args: readonly string[]) =>
  Effect.tryPromise({
    try: async () =>
      (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim(),
    catch: (error) =>
      new RunRecordError({
        reason: `git ${args.join(" ")} failed in ${cwd} (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
      }),
  });

/** The stack file from the repository root: the working directory below the git top level, plus {@link STACK_FILE_NAME}. */
const stackFileOf = (cwd: string) =>
  Effect.gen(function* () {
    const top = yield* git(cwd, ["rev-parse", "--show-toplevel"]);
    // git prints the real path, and the working directory can hold a symlink, such as macOS /tmp.
    const [realTop, realCwd] = yield* Effect.tryPromise({
      try: () => Promise.all([realpath(top), realpath(cwd)]),
      catch: () => new RunRecordError({ reason: `${cwd} is gone` }),
    });
    const directory = relative(realTop, realCwd)
      .split(sep)
      .filter((part) => part !== "");
    return [...directory, STACK_FILE_NAME].join("/");
  });

const variable = (env: RunEnvironment["env"], name: string) =>
  Effect.suspend(() => {
    const value = env[name];
    return value === undefined || value === ""
      ? Effect.fail(
          new RunRecordError({ reason: `GITHUB_ACTIONS is true, and ${name} is not set` }),
        )
      : Effect.succeed(value);
  });

const fromGitHubActions = (where: RunEnvironment) =>
  Effect.gen(function* () {
    const { env } = where;
    const repository = yield* variable(env, "GITHUB_REPOSITORY");
    const refName = yield* variable(env, "GITHUB_REF_NAME");
    const sha = yield* variable(env, "GITHUB_SHA");
    const serverUrl = yield* variable(env, "GITHUB_SERVER_URL");
    const runId = yield* variable(env, "GITHUB_RUN_ID");
    const runAttempt = yield* variable(env, "GITHUB_RUN_ATTEMPT");
    const eventPath = env["GITHUB_EVENT_PATH"];
    const payload =
      eventPath === undefined || eventPath === ""
        ? undefined
        : yield* Effect.tryPromise({
            try: () => readFile(eventPath, "utf8"),
            catch: () =>
              new RunRecordError({ reason: `GITHUB_EVENT_PATH ${eventPath} cannot be read` }),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EventPayload))),
            Effect.mapError((error) =>
              error instanceof RunRecordError
                ? error
                : new RunRecordError({
                    reason: `GITHUB_EVENT_PATH ${eventPath} is not an event payload`,
                  }),
            ),
          );
    const pullRequest = payload?.pull_request;
    // GITHUB_SHA is the merge commit on a pull request event; the head of the pull request is what a person sees.
    const headCommit = pullRequest?.head.sha ?? sha;
    const headRef = env["GITHUB_HEAD_REF"];
    const mergeRef = /^refs\/pull\/(\d+)\/merge$/.exec(env["GITHUB_REF"] ?? "");
    const stackFile = yield* stackFileOf(where.cwd);
    const record: RunRecord = {
      version: 1,
      repository,
      stackFile,
      branch: headRef === undefined || headRef === "" ? refName : headRef,
      pullRequest: pullRequest?.number ?? (mergeRef === null ? null : Number(mergeRef[1])),
      headCommit,
      runUrl: `${serverUrl}/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
      source: "github-actions",
      recordedAt: yield* now,
    };
    return record;
  });

const fromGit = (where: RunEnvironment) =>
  Effect.gen(function* () {
    const { cwd } = where;
    const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
    const match = REMOTE_URL.exec(origin);
    if (match === null) {
      return yield* new RunRecordError({
        reason: `the origin remote of ${cwd} is not a git URL with a host and owner/name: ${origin}`,
      });
    }
    const branch = yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") {
      return yield* new RunRecordError({
        reason: `the checkout at ${cwd} is on no branch (detached HEAD)`,
      });
    }
    const record: RunRecord = {
      version: 1,
      repository: `${match[1]}/${match[2]}`,
      stackFile: yield* stackFileOf(cwd),
      branch,
      pullRequest: null,
      headCommit: yield* git(cwd, ["rev-parse", "HEAD"]),
      runUrl: null,
      source: "laptop",
      recordedAt: yield* now,
    };
    return record;
  });

/**
 * The record of this run: from the GitHub Actions variables and the event
 * payload when GITHUB_ACTIONS is `true`, else from git in `cwd`, which needs
 * a branch and an `origin` remote with `owner/name`. Fails when a value is
 * missing; nothing is guessed.
 */
export const runRecord = (where: RunEnvironment): Effect.Effect<RunRecord, RunRecordError> =>
  where.env["GITHUB_ACTIONS"] === "true" ? fromGitHubActions(where) : fromGit(where);

/**
 * The output document of a stage: the stack's output plus the record under
 * {@link RUN_RECORD_KEY}. A value that the stack itself put under that key
 * stays. An output that is not a plain object has no place for the key and
 * stays as it is.
 */
export const withRunRecord = (output: unknown, record: RunRecord): unknown =>
  typeof output === "object" && output !== null && !Array.isArray(output)
    ? RUN_RECORD_KEY in output
      ? output
      : { ...output, [RUN_RECORD_KEY]: record }
    : output;
