/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    reader: {
      repository: FunctionReference<
        "query",
        "internal",
        { repository: string },
        {
          stacks: Array<{
            name: string;
            stages: Array<{
              deployedHeadCommit: string | null;
              name: string;
              output: string;
              record: {
                branch: string;
                headCommit: string;
                pullRequest: number | null;
                recordedAt: string;
                repository: string;
                runUrl: string | null;
                source: "github-actions" | "laptop";
                stackFile: string;
                version: 1;
              };
              resources: Array<{ fqn: string; value: string }>;
            }>;
          }>;
          store: "found";
        },
        Name
      >;
    };
    state: {
      get: FunctionReference<
        "query",
        "internal",
        { fqn: string; stack: string; stage: string },
        string | null,
        Name
      >;
      getOutput: FunctionReference<
        "query",
        "internal",
        { stack: string; stage: string },
        string | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { stack: string; stage: string },
        Array<string>,
        Name
      >;
      readStack: FunctionReference<
        "query",
        "internal",
        { stack: string },
        {
          stages: Array<{
            output: string | null;
            record: {
              branch: string;
              headCommit: string;
              pullRequest: number | null;
              recordedAt: string;
              repository: string;
              runUrl: string | null;
              source: "github-actions" | "laptop";
              stackFile: string;
              version: 1;
            } | null;
            resources: Array<{ fqn: string; value: string }>;
            stage: string;
          }>;
        },
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        {
          fqn: string;
          run: {
            branch: string;
            headCommit: string;
            pullRequest: number | null;
            recordedAt: string;
            repository: string;
            runUrl: string | null;
            source: "github-actions" | "laptop";
            stackFile: string;
            version: 1;
          } | null;
          stack: string;
          stage: string;
        },
        null,
        Name
      >;
      removeStack: FunctionReference<
        "mutation",
        "internal",
        { stack: string; stage: string | null },
        null,
        Name
      >;
      replaced: FunctionReference<
        "query",
        "internal",
        { stack: string; stage: string },
        Array<string>,
        Name
      >;
      set: FunctionReference<
        "mutation",
        "internal",
        {
          fqn: string;
          run: {
            branch: string;
            headCommit: string;
            pullRequest: number | null;
            recordedAt: string;
            repository: string;
            runUrl: string | null;
            source: "github-actions" | "laptop";
            stackFile: string;
            version: 1;
          } | null;
          stack: string;
          stage: string;
          value: string;
        },
        null,
        Name
      >;
      setOutput: FunctionReference<
        "mutation",
        "internal",
        {
          run: {
            branch: string;
            headCommit: string;
            pullRequest: number | null;
            recordedAt: string;
            repository: string;
            runUrl: string | null;
            source: "github-actions" | "laptop";
            stackFile: string;
            version: 1;
          } | null;
          stack: string;
          stage: string;
          value: string;
        },
        null,
        Name
      >;
      stacks: FunctionReference<"query", "internal", {}, Array<string>, Name>;
      stages: FunctionReference<
        "query",
        "internal",
        { stack: string },
        Array<string>,
        Name
      >;
    };
  };
