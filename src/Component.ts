import { toPath } from "alchemy/FQN";
import type { NamespaceNode } from "alchemy/Namespace";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Deployment } from "./Deployment.ts";

/** A component's resources occupy this namespace in the deployment's Alchemy stack and stage. */
export interface ComponentBinding {
  readonly type: "component";
  readonly path: string;
  readonly namespace: readonly string[];
}

/**
 * Associate a native namespace with an installed component. `component` is the
 * installed name from the app's `convex.config.ts`; a nested install joins the
 * names with slashes, such as `"workspace/mail"`. An undefined namespace
 * associates the stack root. This records display metadata; it does not install
 * the component, set its environment, or change removal policies.
 */
export const bindComponent = (options: {
  deployment: Deployment;
  component: string;
  namespace: NamespaceNode | undefined;
}) =>
  Effect.gen(function* () {
    if (options.component === "") {
      return yield* Effect.die(new Error("The component name is empty."));
    }
    const namespace = toPath(options.namespace);
    const sid = `convex.component:${JSON.stringify(namespace)}`;
    const stack = yield* Stack;
    const previous = stack.bindings[options.deployment.FQN]?.find((binding) => binding.sid === sid);
    // Alchemy keeps the last binding with a given sid. Reject conflicting owners before that happens.
    if (previous !== undefined) {
      const existing = Schema.decodeUnknownSync(Schema.Struct({ path: Schema.String }))(
        previous.data,
      );
      if (existing.path !== options.component) {
        return yield* Effect.die(
          new Error(
            `Alchemy namespace ${JSON.stringify(namespace)} is already bound to ${existing.path}.`,
          ),
        );
      }
      return;
    }
    yield* options.deployment.bind(sid, {
      type: "component",
      path: options.component,
      namespace,
    });
  });
