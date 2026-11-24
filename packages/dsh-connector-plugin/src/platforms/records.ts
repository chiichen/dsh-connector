import type { PlatformField, PlatformId, PlatformRecord, PlatformsConfig } from "./types";
import { PLATFORM_IDS } from "./types";

export function isRecord(value: unknown): value is PlatformRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPath(record: PlatformRecord | undefined, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function setPath(record: PlatformRecord, path: string, value: unknown): PlatformRecord {
  const parts = path.split(".");
  const head = parts[0] ?? "";
  if (head.length === 0) return record;
  const rest = parts.slice(1);
  if (rest.length === 0) {
    const next: PlatformRecord = { ...record };
    if (value === undefined) {
      delete next[head];
      return next;
    }
    return { ...next, [head]: value };
  }

  const currentChild = record[head];
  const child = isRecord(currentChild) ? currentChild : {};
  const updated = setPath(child, rest.join("."), value);
  const next: PlatformRecord = { ...record };
  if (Object.keys(updated).length === 0) {
    delete next[head];
    return next;
  }
  return { ...next, [head]: updated };
}

export function readString(record: PlatformRecord, key: string): string | undefined {
  const value = getPath(record, key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function readBoolean(record: PlatformRecord, key: string): boolean | undefined {
  const value = getPath(record, key);
  return typeof value === "boolean" ? value : undefined;
}

export function readNumber(record: PlatformRecord, key: string): number | undefined {
  const value = getPath(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readId(record: PlatformRecord, key: string): string | number | undefined {
  const value = getPath(record, key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return readString(record, key);
}

export function readStringList(record: PlatformRecord, key: string): readonly string[] | undefined {
  const value = getPath(record, key);
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length === 0 ? undefined : items;
}

export function readChoice<T extends string>(
  record: PlatformRecord,
  key: string,
  choices: readonly T[],
): T | undefined {
  const value = readString(record, key);
  if (value === undefined) return undefined;
  return (choices as readonly string[]).includes(value) ? (value as T) : undefined;
}

function sanitizeFieldValue(field: PlatformField, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (field.kind === "string" || field.kind === "secret" || field.kind === "enum") {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (field.kind === "string-list") {
    if (!Array.isArray(value)) return value;
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length === 0 ? undefined : items;
  }
  return value;
}

export function sanitizePlatforms(
  platforms: PlatformsConfig,
  fieldsByPlatform: ReadonlyMap<PlatformId, readonly PlatformField[]>,
): PlatformsConfig {
  const sanitized: PlatformsConfig = {};
  for (const id of PLATFORM_IDS) {
    const record = platforms[id];
    if (!isRecord(record)) continue;
    let next: PlatformRecord = {};
    if (typeof record.enabled === "boolean") {
      next = { enabled: record.enabled };
    }
    const rawMode = record.mode;
    const selectedMode = typeof rawMode === "string" ? rawMode.trim() : "";
    for (const field of fieldsByPlatform.get(id) ?? []) {
      if (
        selectedMode.length > 0 &&
        field.modes !== undefined &&
        !field.modes.includes(selectedMode)
      ) {
        continue;
      }
      const value = sanitizeFieldValue(field, getPath(record, field.key));
      if (value !== undefined) {
        next = setPath(next, field.key, value);
      }
    }
    if (Object.keys(next).length > 0) {
      sanitized[id] = next;
    }
  }
  return sanitized;
}
