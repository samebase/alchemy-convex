// The run record from recorded environments: a pull_request event, a push,
// and a laptop checkout made with the real git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUN_RECORD_KEY, type RunRecord, runRecord, withRunRecord } from "../src/RunRecord.ts";

const PULL_REQUEST_EVENT = fileURLToPath(
  new URL("./fixtures/github/pull_request_event.json", import.meta.url),
);
/** The head of pull request 19 in the recorded payload. */
const HEAD_SHA = "8af3c5b7932c528939cbc7aa0597b1fc36c8dc83";
const MERGE_SHA = "0f3d5e5a9c1b2d4e6f7a8b9c0d1e2f3a4b5c6d7e";

let dir = "";
/** A checkout with one commit and an origin remote, in its real path. */
let checkout = "";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "alchemy-convex-run-record-")));
  checkout = join(dir, "checkout");
  mkdirSync(join(checkout, "apps", "site"), { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "config", "user.email", "test@example.com");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "commit.gpgsign", "false");
  writeFileSync(join(checkout, "apps", "site", "alchemy.run.ts"), "export default 1;\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "--message", "stack");
  git(checkout, "remote", "add", "origin", "git@github.com:samebase/tmp-run-record.git");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const actions = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "samebase/tmp-run-record",
  GITHUB_REF_NAME: "main",
  GITHUB_SHA: MERGE_SHA,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_RUN_ID: "12345678901",
  GITHUB_RUN_ATTEMPT: "2",
};

/** The record at 2026-10-21T10:00:00Z of the test clock. */
const at = (cwd: string, env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-21T10:00:00Z"));
    return yield* runRecord({ cwd, env });
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);

/** The rendered failure of the derivation, or "" when it succeeds. */
const failureOf = async (cwd: string, env: Record<string, string | undefined>) => {
  const exit = await Effect.runPromiseExit(runRecord({ cwd, env }));
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
};

describe("runRecord", () => {
  it("records a pull_request event from the variables and the event payload", async () => {
    const record = await at(join(checkout, "apps", "site"), {
      ...actions,
      GITHUB_REF: "refs/pull/19/merge",
      GITHUB_REF_NAME: "19/merge",
      GITHUB_HEAD_REF: "team-token",
      GITHUB_EVENT_PATH: PULL_REQUEST_EVENT,
    });
    expect(record).toEqual({
      version: 1,
      repository: "samebase/tmp-run-record",
      stackFile: "apps/site/alchemy.run.ts",
      branch: "team-token",
      pullRequest: 19,
      headCommit: HEAD_SHA,
      runUrl: "https://github.com/samebase/tmp-run-record/actions/runs/12345678901/attempts/2",
      source: "github-actions",
      recordedAt: "2026-10-21T10:00:00.000Z",
    } satisfies RunRecord);
  });

  it("records a push event: the pushed branch, GITHUB_SHA, and no pull request", async () => {
    const payload = join(dir, "push.json");
    writeFileSync(payload, JSON.stringify({ ref: "refs/heads/main", after: MERGE_SHA }));
    const record = await at(checkout, {
      ...actions,
      GITHUB_REF: "refs/heads/main",
      GITHUB_HEAD_REF: "",
      GITHUB_EVENT_PATH: payload,
    });
    expect(record).toMatchObject({
      repository: "samebase/tmp-run-record",
      stackFile: "alchemy.run.ts",
      branch: "main",
      pullRequest: null,
      headCommit: MERGE_SHA,
      source: "github-actions",
    });
  });

  it("takes the pull request number from GITHUB_REF when the payload has none", async () => {
    const payload = join(dir, "other.json");
    writeFileSync(payload, JSON.stringify({ ref: "refs/pull/7/merge" }));
    const record = await at(checkout, {
      ...actions,
      GITHUB_REF: "refs/pull/7/merge",
      GITHUB_REF_NAME: "7/merge",
      GITHUB_HEAD_REF: "feature",
      GITHUB_EVENT_PATH: payload,
    });
    expect(record).toMatchObject({ branch: "feature", pullRequest: 7, headCommit: MERGE_SHA });
  });

  it("fails on GitHub Actions without a variable", async () => {
    const { GITHUB_RUN_ID: _unset, ...rest } = actions;
    expect(await failureOf(checkout, rest)).toContain("GITHUB_RUN_ID is not set");
    expect(
      await failureOf(checkout, { ...actions, GITHUB_EVENT_PATH: join(dir, "absent") }),
    ).toContain("cannot be read");
  });

  it("records a laptop checkout from git", async () => {
    const record = await at(join(checkout, "apps", "site"), {});
    expect(record).toEqual({
      version: 1,
      repository: "samebase/tmp-run-record",
      stackFile: "apps/site/alchemy.run.ts",
      branch: "main",
      pullRequest: null,
      headCommit: git(checkout, "rev-parse", "HEAD"),
      runUrl: null,
      source: "laptop",
      recordedAt: "2026-10-21T10:00:00.000Z",
    } satisfies RunRecord);
    expect(record.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads the https, ssh, and scp forms of the origin URL", async () => {
    for (const url of [
      "https://github.com/samebase/tmp-run-record.git",
      "https://github.com/samebase/tmp-run-record",
      "ssh://git@github.com/samebase/tmp-run-record.git",
      "git@github.com:samebase/tmp-run-record.git",
    ]) {
      git(checkout, "remote", "set-url", "origin", url);
      expect((await at(checkout, {})).repository).toBe("samebase/tmp-run-record");
    }
  });

  it("fails on a laptop outside a checkout, without origin, with a path remote, or on no branch", async () => {
    expect(await failureOf(dir, {})).toContain("git remote get-url origin failed");
    git(checkout, "remote", "remove", "origin");
    expect(await failureOf(checkout, {})).toContain("git remote get-url origin failed");
    git(checkout, "remote", "add", "origin", "/srv/git/tmp-run-record.git");
    expect(await failureOf(checkout, {})).toContain("is not a git URL with a host");
    git(checkout, "remote", "set-url", "origin", "git@github.com:samebase/tmp-run-record.git");
    git(checkout, "checkout", "--quiet", "--detach");
    expect(await failureOf(checkout, {})).toContain("detached HEAD");
  });
});

describe("withRunRecord", () => {
  const record: RunRecord = {
    version: 1,
    repository: "samebase/app",
    stackFile: "alchemy.run.ts",
    branch: "main",
    pullRequest: null,
    headCommit: HEAD_SHA,
    runUrl: null,
    source: "laptop",
    recordedAt: "2026-10-21T10:00:00.000Z",
  };

  it("adds the record to an object output and keeps the stack's own keys", () => {
    expect(withRunRecord({ url: "https://app.convex.site" }, record)).toEqual({
      url: "https://app.convex.site",
      [RUN_RECORD_KEY]: record,
    });
  });

  it("keeps a value that the stack put under the key", () => {
    const own = { url: "u", [RUN_RECORD_KEY]: { mine: true } };
    expect(withRunRecord(own, record)).toBe(own);
  });

  it("has no document for an output that is not a plain object", () => {
    expect(withRunRecord("https://app.convex.site", record)).toBeUndefined();
    expect(withRunRecord(["a"], record)).toBeUndefined();
    expect(withRunRecord(null, record)).toBeUndefined();
    // A spread would keep only the enumerable own keys of these.
    expect(withRunRecord(new Date(0), record)).toBeUndefined();
    expect(withRunRecord(Redacted.make("secret"), record)).toBeUndefined();
    expect(withRunRecord(Object.create(null), record)).toEqual({ [RUN_RECORD_KEY]: record });
  });
});
