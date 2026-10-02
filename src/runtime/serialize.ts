import { McjsError } from "../errors.ts";
import { MAX_RESULT_BYTES } from "../protocol.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function serialize(input: unknown, limit = MAX_RESULT_BYTES): JsonValue {
  const ancestors = new Set<object>();
  function walk(value: unknown, path: string, depth: number): JsonValue {
    const fail = (message: string): never => {
      throw new McjsError("SERIALIZATION_ERROR", `${message} at ${path}`);
    };
    if (depth > 64) return fail("Maximum depth exceeded");
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number")
      return Number.isFinite(value) ? value : fail("Nonfinite number");
    if (typeof value !== "object") return fail(`Unsupported ${typeof value}`);
    if (ancestors.has(value)) return fail("Circular reference");
    if (value instanceof Date) return value.toISOString();
    ancestors.add(value);
    try {
      if (Array.isArray(value))
        return value.map((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      const object = value as Record<string, unknown>;
      const name = Object.getPrototypeOf(value)?.constructor?.name;
      const fields: Record<string, string[]> = {
        Vec3: ["x", "y", "z"],
        Item: ["name", "type", "count", "slot", "metadata", "displayName"],
        Block: [
          "name",
          "type",
          "position",
          "stateId",
          "displayName",
          "boundingBox",
        ],
        Entity: [
          "id",
          "name",
          "type",
          "username",
          "position",
          "velocity",
          "height",
          "width",
        ],
      };
      const selected = fields[name];
      if (
        !selected &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        return fail(`Unsupported object ${name}`);
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of selected ?? Object.keys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && !("value" in descriptor))
          return fail(`Accessor property ${key}`);
        const item = object[key];
        if (item !== undefined)
          result[key] = walk(item, `${path}.${key}`, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  const result = walk(input, "$", 0);
  if (Buffer.byteLength(JSON.stringify(result)) > limit)
    throw new McjsError("RESULT_TOO_LARGE", `Result exceeds ${limit} bytes`);
  return result;
}
