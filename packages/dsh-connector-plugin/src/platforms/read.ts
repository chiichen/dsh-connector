import type { PlatformsConfig } from "./types";

/**
 * cosmokit marks a live settings value with this symbol and a `get()` snapshot.
 * dsh writes Connectors settings into that reference instead of a plain object.
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cosmokit/src/volatile.ts
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

export function readPlatformsConfig(value: unknown): PlatformsConfig | undefined {
  const snapshot = volatileSnapshot(value);
  const record = snapshot === undefined ? value : snapshot;
  if (!isPlatformsConfig(record)) return undefined;
  return record;
}

function isPlatformsConfig(value: unknown): value is PlatformsConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function volatileSnapshot(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !(VOLATILE_WRITE in value)) return undefined;
  const read = Reflect.get(value, "get");
  if (typeof read !== "function") return undefined;
  return read.call(value);
}
