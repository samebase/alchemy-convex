import { toPath } from "alchemy/FQN";
import type { NamespaceNode } from "alchemy/Namespace";
import { Stack } from "alchemy/Stack";
import { getFunctionAddress } from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Deployment } from "./Deployment.ts";

/** A component's resources occupy this namespace in the deployment's Alchemy stack and stage. */
export interface ComponentBinding {
  readonly type: "component";
  readonly path: string;
  readonly namespace: readonly string[];
}

// Convex 1.48 encodes generated component roots relative to their parent.
const componentAddress = Schema.Struct({
  reference: Schema.String.check(Schema.isPattern(/^_reference\/childComponent\/[^/]+$/)),
});

/**
 * Associate a native namespace with a generated component reference. `parents`
 * contains the generated parent references, from the app root to the direct parent.
 * An undefined namespace associates the stack root. This records display metadata;
 * it does not install the component, set its environment, or change removal policies.
 */
export const bindComponent = (options: {
  deployment: Deployment;
  component: unknown;
  namespace: NamespaceNode | undefined;
  parents?: readonly unknown[];
}) =>
  Effect.gen(function* () {
    const path = [...(options.parents ?? []), options.component]
      .map((reference) =>
        Schema.decodeUnknownSync(componentAddress)(getFunctionAddress(reference)).reference.slice(
          "_reference/childComponent/".length,
        ),
      )
      .join("/");
    const namespace = toPath(options.namespace);
    const sid = `convex.component:${JSON.stringify(namespace)}`;
    const stack = yield* Stack;
    const previous = stack.bindings[options.deployment.FQN]?.find((binding) => binding.sid === sid);
    // Alchemy keeps the last binding with a given sid. Reject conflicting owners before that happens.
    if (previous !== undefined) {
      const existing = Schema.decodeUnknownSync(Schema.Struct({ path: Schema.String }))(
        previous.data,
      );
      if (existing.path !== path) {
        return yield* Effect.die(
          new Error(
            `Alchemy namespace ${JSON.stringify(namespace)} is already bound to ${existing.path}.`,
          ),
        );
      }
      return;
    }
    yield* options.deployment.bind(sid, { type: "component", path, namespace });
  });
