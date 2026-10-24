import { v } from "convex/values";
import type { RunRecord } from "../../RunRecord.ts";

export const runRecord = v.object({
  version: v.literal(1),
  repository: v.string(),
  stackFile: v.string(),
  branch: v.string(),
  pullRequest: v.union(v.number(), v.null()),
  headCommit: v.string(),
  runUrl: v.union(v.string(), v.null()),
  source: v.union(v.literal("github-actions"), v.literal("laptop")),
  recordedAt: v.string(),
});

/** Old writers put the record in arbitrary output JSON. Keep only its known fields. */
export function readRunRecord(value: unknown): RunRecord | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("repository" in value) ||
    typeof value.repository !== "string" ||
    !("stackFile" in value) ||
    typeof value.stackFile !== "string" ||
    !("branch" in value) ||
    typeof value.branch !== "string" ||
    !("pullRequest" in value) ||
    (typeof value.pullRequest !== "number" && value.pullRequest !== null) ||
    !("headCommit" in value) ||
    typeof value.headCommit !== "string" ||
    !("runUrl" in value) ||
    (typeof value.runUrl !== "string" && value.runUrl !== null) ||
    !("source" in value) ||
    (value.source !== "github-actions" && value.source !== "laptop") ||
    !("recordedAt" in value) ||
    typeof value.recordedAt !== "string"
  )
    return null;
  return {
    version: value.version,
    repository: value.repository,
    stackFile: value.stackFile,
    branch: value.branch,
    pullRequest: value.pullRequest,
    headCommit: value.headCommit,
    runUrl: value.runUrl,
    source: value.source,
    recordedAt: value.recordedAt,
  };
}
