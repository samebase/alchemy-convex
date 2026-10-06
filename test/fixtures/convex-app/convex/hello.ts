// The one query of the fixture app that the live tests push. It uses the
// generic builder from "convex/server", so the push needs no codegen and
// writes no convex/_generated files into this repository.
import { queryGeneric } from "convex/server";

export const hello = queryGeneric({
  args: {},
  handler: async () => "hello from alchemy-convex",
});
