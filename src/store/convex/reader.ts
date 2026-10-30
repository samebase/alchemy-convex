// Authenticated reads stay in the app: `authorize` signs and `repository`
// verifies with `ctx.auth`, which a component does not have. The rows and the
// redaction are in the alchemyState component.
import { v } from "convex/values";
import { repositoryReply } from "../component/reader.ts";
import { components } from "./_generated/api.js";
import { env, internalMutation, query } from "./_generated/server.js";

const repositoryName = /^[^/]+\/[^/]+$/;

/** Only a deployment credential can exchange an approved repository for a read token. */
export const authorize = internalMutation({
  args: { repository: v.string(), subject: v.string() },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
    if (!repositoryName.test(args.repository) || args.subject === "") {
      throw new Error("A repository and subject are required.");
    }
    return {
      token: await ctx.auth.signJwt({
        expiresInSeconds: 300,
        claims: {
          sub: args.subject,
          aud: `${env.CONVEX_CLOUD_URL}/alchemy-reader`,
          repository: args.repository,
          scope: "alchemy:read",
        },
      }),
    };
  },
});

/** A native subscription reads only the repository named in its verified capability. */
export const repository = query({
  args: {},
  returns: repositoryReply,
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (
      identity === null ||
      identity.scope !== "alchemy:read" ||
      typeof identity.repository !== "string" ||
      !repositoryName.test(identity.repository)
    ) {
      throw new Error("Alchemy repository read access is required.");
    }
    return await ctx.runQuery(components.alchemyState.reader.repository, {
      repository: identity.repository,
    });
  },
});
