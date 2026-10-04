// Convex.Deploy: pushes the functions in a `convex/` directory with
// `npx convex deploy` and exposes the deployment URL for a frontend build.
//
// The deployment itself belongs to the project, so delete leaves the last
// pushed functions running. The URL comes from the CLI's own output because
// the deploy key, not this resource, decides which deployment receives the push.
import { stripVTControlCharacters } from "node:util";
import { Resource } from "alchemy";
import { CommandExecutor, type CommandRunProps } from "alchemy/Command";
import { hashDirectory, type MemoOptions } from "alchemy/Command/Memo";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Providers } from "./Providers.ts";

export interface DeployProps extends Pick<CommandRunProps, "cwd" | "env" | "timeout"> {
  /**
   * Deploy key that selects the target deployment: a production, development,
   * project, or preview deploy key. The CLI receives it as `CONVEX_DEPLOY_KEY`,
   * and Alchemy removes its value from the logged output.
   */
  readonly deployKey: Redacted.Redacted<string>;
  /**
   * Preview deployment name for a preview deploy key. The CLI reuses an
   * existing preview deployment with this name.
   */
  readonly previewName?: string;
  /**
   * Like {@link previewName}, but the CLI deletes and recreates an existing
   * preview deployment with this name, so every run gets a new URL.
   */
  readonly previewCreate?: string;
  /**
   * Function to run after the push, such as `init:seed`. The CLI runs it only
   * when the push created a new preview deployment.
   */
  readonly previewRun?: string;
  /**
   * More `convex deploy` flags, added after the preview flags. Alchemy splits
   * the command on whitespace, so an argument cannot contain whitespace: use
   * `--typecheck=disable`, not `--typecheck disable` as one argument.
   */
  readonly extraArgs?: readonly string[];
  /**
   * Files hashed to skip an unchanged push. By default every non-gitignored
   * file under `cwd` and the nearest lockfile. Use
   * `{ include: ["convex/**"], lockfile: true }` to ignore frontend changes,
   * or `false` to push on every deploy.
   * @default true
   */
  readonly memo?: MemoOptions | boolean;
}

export interface DeployAttributes {
  /** Client URL of the deployment that received the push, such as `https://happy-otter-123.convex.cloud`. */
  readonly url: string;
  /** First label of the URL host, such as `happy-otter-123`. */
  readonly deploymentName: string;
  /** Hash of the memoized input files after the push, or `undefined` when `memo` is `false`. */
  readonly hash: string | undefined;
}

export type Deploy = Resource<"Convex.Deploy", DeployProps, DeployAttributes, never, Providers>;
export const Deploy = Resource<Deploy>("Convex.Deploy");

/**
 * The CLI prints this line with `logFinishedStep` after the push succeeds, to
 * stderr (convex 1.45 `cli/lib/deploy2.js` for existing deployments,
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

/** The `convex deploy` argv, starting with `npx`. */
export const deployArgs = (
  props: Pick<DeployProps, "previewName" | "previewCreate" | "previewRun" | "extraArgs">,
): readonly string[] => [
  "npx",
  "convex",
  "deploy",
  ...(props.previewName === undefined ? [] : ["--preview-name", props.previewName]),
  ...(props.previewCreate === undefined ? [] : ["--preview-create", props.previewCreate]),
  ...(props.previewRun === undefined ? [] : ["--preview-run", props.previewRun]),
  ...(props.extraArgs ?? []),
];

/** Number of output lines quoted when the CLI exits 0 without the deployed line. */
const OUTPUT_TAIL_LINES = 20;

export const DeployProvider = () =>
  Provider.effect(
    Deploy,
    Effect.gen(function* () {
      const { run } = yield* CommandExecutor;

      const hashOf = (props: DeployProps) =>
        props.memo === false
          ? Effect.succeed(undefined)
          : hashDirectory({
              ...(props.cwd === undefined ? {} : { cwd: props.cwd }),
              memo: props.memo === true || props.memo === undefined ? {} : props.memo,
            });

      return {
        // No `stables`: the same deploy key can push to a different URL. A
        // project deploy key follows the project's default production
        // deployment, and a preview deployment can expire or be recreated
        // under the same name.
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (output === undefined || output.hash === undefined || havePropsChanged(olds, news)) {
            return { action: "update" } as const;
          }
          return { action: (yield* hashOf(news)) === output.hash ? "noop" : "update" } as const;
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const args = deployArgs(news);
          const spaced = args.find((arg) => /\s/.test(arg));
          if (spaced !== undefined) {
            return yield* Effect.die(
              new Error(
                `Convex.Deploy argument "${spaced}" contains whitespace; Alchemy splits commands on whitespace`,
              ),
            );
          }
          // A push is idempotent: the CLI uploads the full function set every time.
          const { stdout, stderr } = yield* run(
            {
              command: args.join(" "),
              ...(news.cwd === undefined ? {} : { cwd: news.cwd }),
              ...(news.timeout === undefined ? {} : { timeout: news.timeout }),
              env: { ...news.env, CONVEX_DEPLOY_KEY: news.deployKey },
            },
            session,
          );
          // `run` returns output with the deploy key already replaced.
          const output = `${stdout}\n${stderr}`;
          const deployed = parseDeployOutput(output);
          if (deployed === undefined) {
            const tail = stripVTControlCharacters(output)
              .split(/\r?\n|\r/)
              .filter((line) => line.trim() !== "")
              .slice(-OUTPUT_TAIL_LINES)
              .join("\n");
            return yield* Effect.die(
              new Error(
                `npx convex deploy exited 0 but printed no "Deployed Convex functions to <url>" line. Last output:\n${tail}`,
              ),
            );
          }
          return { ...deployed, hash: yield* hashOf(news) };
        }),

        // The deployment belongs to the project; its functions stay deployed.
        delete: () => Effect.void,
      };
    }),
  );
