import { v, type GenericValidator, type Infer } from "convex/values";

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

/** Whether `value` passes `validator`. Only the kinds of {@link runRecord} pass; another kind fails. */
export const validate = <V extends GenericValidator>(
  validator: V,
  value: unknown,
): value is Infer<V> => {
  switch (validator.kind) {
    case "object": {
      if (typeof value !== "object" || value === null) return false;
      const fields = new Map(Object.entries(value));
      return Object.entries(validator.fields).every(([key, field]) =>
        validate(field, fields.get(key)),
      );
    }
    case "union":
      return validator.members.some((member) => validate(member, value));
    case "literal":
      return value === validator.value;
    case "string":
      return typeof value === "string";
    case "float64":
      return typeof value === "number";
    case "null":
      return value === null;
    default:
      return false;
  }
};
