// Live round trip against the Management API and the deployment API.
// Runs only with ALCHEMY_CONVEX_LIVE=1 and a Convex login (CONVEX_ACCESS_TOKEN
// or `npx convex login`) that can reach team samebase-live-tests.
//
// Assertions compare secrets as booleans so a failure never prints one.
import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { assert, describe, expect, it } from "vitest";
import { fromConfig } from "../../src/Credentials.ts";
import { CreatedDeployKey, DeployKeyList, selectCreatedKey } from "../../src/DeployKey.ts";
import {
  EnvironmentVariableList,
  findVariable,
  updateVariable,
} from "../../src/EnvironmentVariable.ts";
import { absentAsUndefined, ManagementApi, ManagementApiLive } from "../../src/ManagementApi.ts";
import { CreatedPreviewDeployKey, PreviewDeployKeyList } from "../../src/PreviewDeployKey.ts";
import { liveTargets } from "./env.ts";

/** Throwaway targets, overridable through env (see env.ts). */
const { deployment, projectId } = liveTargets;

const roundTrip = Effect.gen(function* () {
  const api = yield* ManagementApi;
  const hex = randomBytes(4).toString("hex");
  const keyName = `tmp-alchemy-convex-${hex}`;
  const variable = `TMP_ALCHEMY_CONVEX_${hex.toUpperCase()}`;

  const listDeployKeys = api
    .request("list deploy keys", (client) =>
      client.GET("/deployments/{deployment_name}/list_deploy_keys", {
        params: { path: { deployment_name: deployment } },
      }),
    )
    .pipe(Effect.map((body) => Schema.decodeUnknownSync(DeployKeyList)(body)));
  const deleteDeployKey = (id: string) =>
    api.requestVoid("delete deploy key", (client) =>
      client.POST("/deployments/{deployment_name}/delete_deploy_key", {
        params: { path: { deployment_name: deployment } },
        body: { id },
      }),
    );
  const listPreviewKeys = api
    .request("list preview deploy keys", (client) =>
      client.GET("/projects/{project_id}/list_preview_deploy_keys", {
        params: { path: { project_id: projectId } },
      }),
    )
    .pipe(Effect.map((body) => Schema.decodeUnknownSync(PreviewDeployKeyList)(body).items));
  const deletePreviewKey = (id: string) =>
    api.requestVoid("delete preview deploy key", (client) =>
      client.POST("/projects/{project_id}/delete_preview_deploy_key", {
        params: { path: { project_id: projectId } },
        body: { id },
      }),
    );
  const listVariables = (deployKey: Redacted.Redacted<string>) =>
    api
      .deploymentRequest("list environment variables", deployment, deployKey, (client) =>
        client.GET("/list_environment_variables"),
      )
      .pipe(Effect.map((body) => Schema.decodeUnknownSync(EnvironmentVariableList)(body)));

  const createDeployKey = api
    .request("create deploy key", (client) =>
      client.POST("/deployments/{deployment_name}/create_deploy_key", {
        params: { path: { deployment_name: deployment } },
        body: { name: keyName },
      }),
    )
    .pipe(
      Effect.map((body) =>
        Redacted.make(Schema.decodeUnknownSync(CreatedDeployKey)(body).deployKey),
      ),
    );
  const createPreviewKey = api
    .request("create preview deploy key", (client) =>
      client.POST("/projects/{project_id}/create_preview_deploy_key", {
        params: { path: { project_id: projectId } },
        body: { name: keyName },
      }),
    )
    .pipe(
      Effect.map((body) =>
        Redacted.make(Schema.decodeUnknownSync(CreatedPreviewDeployKey)(body).previewDeployKey),
      ),
    );

  const useDeployKey = (deployKey: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      expect(Redacted.value(deployKey).startsWith(`dev:${deployment}|`)).toBe(true);
      const listed = selectCreatedKey(yield* listDeployKeys, keyName);
      assert(listed !== undefined, `deploy key ${keyName} is not listed`);
      console.log(`deploy key listed as "${listed.name}"`);

      // Environment variable: set, read back, remove, read back.
      yield* Effect.acquireUseRelease(
        updateVariable(deployment, deployKey, variable, Redacted.make("alchemy-convex-live")),
        () =>
          Effect.gen(function* () {
            expect(findVariable(yield* listVariables(deployKey), deployment, variable)).toEqual({
              deployment,
              name: variable,
            });
            yield* updateVariable(deployment, deployKey, variable, null);
            expect(
              findVariable(yield* listVariables(deployKey), deployment, variable),
            ).toBeUndefined();
            // Removing an absent variable also succeeds.
            yield* updateVariable(deployment, deployKey, variable, null);
            console.log(`environment variable ${variable} set and removed`);
          }),
        () => updateVariable(deployment, deployKey, variable, null),
      );

      // Preview deploy key: create, find by unique name, delete by unique name.
      yield* Effect.acquireUseRelease(
        createPreviewKey,
        (previewKey) =>
          Effect.gen(function* () {
            expect(Redacted.value(previewKey).startsWith("preview:")).toBe(true);
            const previewListed = selectCreatedKey(yield* listPreviewKeys, keyName);
            assert(previewListed !== undefined, `preview deploy key ${keyName} is not listed`);
            console.log(`preview deploy key listed as "${previewListed.name}"`);
            yield* deletePreviewKey(previewListed.name);
            expect(
              (yield* listPreviewKeys).some((entry) => entry.name === previewListed.name),
            ).toBe(false);
            const again = yield* Effect.flip(deletePreviewKey(previewListed.name));
            expect({ status: again.status, code: again.code }).toEqual({
              status: 404,
              code: "PreviewDeployKeyNotFound",
            });
            console.log(
              `delete_preview_deploy_key accepted the unique name; a second delete is 404 ${again.code}`,
            );
          }),
        (previewKey) => absentAsUndefined(deletePreviewKey(Redacted.value(previewKey))),
      );

      // Deploy key: delete by unique name, as the provider does.
      yield* deleteDeployKey(listed.name);
      expect((yield* listDeployKeys).some((entry) => entry.name === listed.name)).toBe(false);
      const again = yield* Effect.flip(deleteDeployKey(listed.name));
      expect({ status: again.status, code: again.code }).toEqual({
        status: 404,
        code: "DeployKeyNotFound",
      });
      console.log(
        `delete_deploy_key accepted the unique name; a second delete is 404 ${again.code}`,
      );
    });

  // The release deletes by the full secret, which Convex also accepts, so
  // cleanup works even when the listing step failed.
  yield* Effect.acquireUseRelease(createDeployKey, useDeployKey, (deployKey) =>
    absentAsUndefined(deleteDeployKey(Redacted.value(deployKey))),
  );
});

describe.skipIf(process.env.ALCHEMY_CONVEX_LIVE !== "1")(
  "live: deploy keys and environment variables",
  () => {
    it("creates, uses, and deletes a deploy key, a variable, and a preview deploy key", async () => {
      await Effect.runPromise(
        roundTrip.pipe(Effect.provide(ManagementApiLive().pipe(Layer.provide(fromConfig())))),
      );
    }, 60_000);
  },
);
