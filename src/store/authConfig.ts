// The auth config of each app that serves the store: the app verifies the
// read tokens that `reader:authorize` signs with the key of its own
// deployment. Exported as `@samebase/alchemy-convex/state/auth.config`.
import type { AuthConfig } from "convex/server";

/** The auth config of the store readers on the deployment at `cloudUrl`, the app's `env.CONVEX_CLOUD_URL`. */
export const authConfig = (cloudUrl: string): AuthConfig => ({
  providers: [
    {
      type: "customJwt",
      issuer: cloudUrl,
      applicationID: `${cloudUrl}/alchemy-reader`,
      jwks: `${cloudUrl}/.well-known/jwks.json`,
      algorithm: "ES256",
    },
  ],
});
