// The state functions of the store app of this package, a seed: Convex.state()
// pushes this directory to the samebase project of a team. The raw state
// functions are internal; reader.ts exposes authenticated, redacted reads.
// The functions come from src/store/functions.ts, which a base app imports
// too. Each export has its own name, so that Convex finds it.
import { stateFunctions } from "../functions.js";
import { components } from "./_generated/api.js";

export const {
  version,
  host,
  stacks,
  stages,
  list,
  get,
  replaced,
  set,
  remove,
  removeStack,
  getOutput,
  setOutput,
  readStack,
} = stateFunctions(components.alchemyState, "seed");
