import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ConvexApiError, isRetryableWriteError } from "../src/ManagementApi.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/management/${file}`, import.meta.url), "utf8"));

const ErrorBody = Schema.Struct({ code: Schema.String, message: Schema.String });

/** The error that ManagementApi makes from a recorded error body. */
const errorFrom = (
  file: string,
  status: number,
  change: { code?: string; message?: string } = {},
) =>
  new ConvexApiError({
    operation: "test",
    status,
    ...Schema.decodeUnknownSync(ErrorBody)(fixture(file)),
    ...change,
  });

describe("isRetryableWriteError", () => {
  it("retries the recorded write conflict of update_environment_variables", () => {
    expect(
      isRetryableWriteError(
        errorFrom("deployment_update_environment_variables_conflict.json", 503),
      ),
    ).toBe(true);
  });

  it("retries the recorded 500 of a parallel delete_preview_deploy_key", () => {
    expect(
      isRetryableWriteError(errorFrom("project_delete_preview_deploy_key_500.json", 500)),
    ).toBe(true);
  });

  it("retries the platform codes OCC and WriteConflict and the conflict message", () => {
    const file = "deployment_update_environment_variables_conflict.json";
    expect(isRetryableWriteError(errorFrom(file, 400, { code: "OCC" }))).toBe(true);
    expect(isRetryableWriteError(errorFrom(file, 400, { code: "WriteConflict" }))).toBe(true);
    expect(
      isRetryableWriteError(
        errorFrom(file, 400, {
          code: "Other",
          message:
            'Documents read from or written to the "_environment_variables" table changed while this mutation was being run and on every subsequent retry.',
        }),
      ),
    ).toBe(true);
  });

  it("does not retry the recorded 404", () => {
    expect(isRetryableWriteError(errorFrom("project_not_found.json", 404))).toBe(false);
  });
});
