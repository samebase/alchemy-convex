// Adoption check for reconcile.
//
// The engine checks ownership during plan: `read` returns `Unowned(...)` for
// an object that is not in state, and the engine then needs `--adopt`. A
// reconcile without state can still find an existing object, for example
// after a replacement, after an interrupted create, or when another run
// created it between plan and apply. Reconcile takes that object over only
// when adoption is on. The order is the same as in the engine: the
// resource's own `adopt(...)`, then the AdoptPolicy service, then the
// `--adopt` flag in AlchemyContext.
//
// Pattern from Confect, `packages/alchemy/src/internal/Lifecycle.ts`
// (https://github.com/rjdellecese/confect, ISC license).
import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** True when the resource `fqn` may take over an object that is not in state. */
export const shouldAdopt = (fqn: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const stack = yield* Effect.serviceOption(Stack);
    const own = Option.isSome(stack) ? stack.value.resources[fqn]?.Adopt : undefined;
    if (own !== undefined) return own;
    const policy = yield* Effect.serviceOption(AdoptPolicy);
    if (Option.isSome(policy)) return policy.value;
    const context = yield* Effect.serviceOption(AlchemyContext);
    return Option.isSome(context) && context.value.adopt;
  });
