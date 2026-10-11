import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * `undefined` object members dropped. Anything that cannot round-trip through
 * JSON (functions, symbols, bigints, non-finite numbers, undefined array items)
 * throws, so a payload hash can never silently depend on lossy serialization.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("cannot canonicalize a non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`cannot canonicalize a value of type ${typeof value}`);
  }
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashOf(value: unknown): string {
  return sha256(canonicalize(value));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

/** Structured clone that also freezes, for values that must not be mutated after recording. */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
