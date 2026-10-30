import type { AuthConfig } from "convex/server";
import { env } from "./_generated/server.js";

export default {
  providers: [
    {
      type: "customJwt",
      issuer: env.CONVEX_CLOUD_URL,
      applicationID: `${env.CONVEX_CLOUD_URL}/alchemy-reader`,
      jwks: `${env.CONVEX_CLOUD_URL}/.well-known/jwks.json`,
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
