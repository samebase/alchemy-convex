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
      remove: FunctionReference<
        "mutation",
        "internal",
        { fqn: string; stack: string; stage: string },
        null,
        Name
      >;
      removeStack: FunctionReference<
        "mutation",
        "internal",
        { stack: string; stage?: string },
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
        { fqn: string; stack: string; stage: string; value: string },
        null,
        Name
      >;
      setOutput: FunctionReference<
        "mutation",
        "internal",
        { stack: string; stage: string; value: string },
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
