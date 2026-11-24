import { PLATFORM_BY_ID } from "../platforms/catalog";
import { getPath, isRecord } from "../platforms/records";
import type { PlatformId, PlatformRecord, PlatformsConfig } from "../platforms/types";
import { SETTINGS_PLATFORMS_KEY } from "../constants";

/**
 * One path edit for the host settings form.
 * A redacted read never contains `role("secret")` values, so a save must name
 * changed leaves instead of replacing the whole section.
 */
export type SettingsPathOp =
  | { readonly op: "set"; readonly path: readonly string[]; readonly value: SettingsJson }
  | { readonly op: "unset"; readonly path: readonly string[] };

export type SettingsJson =
  | string
  | number
  | boolean
  | null
  | readonly SettingsJson[]
  | { readonly [key: string]: SettingsJson };

export function samePlatforms(
  left: PlatformsConfig | undefined,
  right: PlatformsConfig | undefined,
): boolean {
  return sameValue(left ?? {}, right ?? {});
}

/**
 * Whether a secret field is absent because the host redacted a stored value.
 * Nested secrets leave their parent object behind. A top-level secret counts
 * only when some other saved field shows the platform record was written.
 */
export function secretWasRedacted(record: PlatformRecord | undefined, key: string): boolean {
  if (record === undefined) return false;
  const current = getPath(record, key);
  if (typeof current === "string" && current.length > 0) return false;
  const dot = key.lastIndexOf(".");
  if (dot >= 0) {
    return isRecord(getPath(record, key.slice(0, dot)));
  }
  return Object.entries(record).some(([entryKey, entryValue]) => {
    return entryKey !== "enabled" && entryKey !== key && entryValue !== undefined;
  });
}

export function platformSettingsOps(
  previous: PlatformsConfig | undefined,
  next: PlatformsConfig,
): SettingsPathOp[] {
  const ops: SettingsPathOp[] = [];
  syncValue(previous ?? {}, next, [SETTINGS_PLATFORMS_KEY], ops);
  return ops;
}

function syncValue(
  previous: unknown,
  next: unknown,
  path: readonly string[],
  ops: SettingsPathOp[],
): void {
  if (isRecord(next) && (previous === undefined || isRecord(previous))) {
    const prevRecord = isRecord(previous) ? previous : {};
    for (const key of Object.keys(next)) {
      syncValue(prevRecord[key], next[key], [...path, key], ops);
    }
    for (const key of Object.keys(prevRecord)) {
      if (key in next) continue;
      if (shouldKeepStoredSecret(path, key)) continue;
      ops.push({ op: "unset", path: [...path, key] });
    }
    return;
  }
  if (sameValue(previous, next)) return;
  if (isSettingsJson(next)) {
    ops.push({ op: "set", path, value: next });
  }
}

function shouldKeepStoredSecret(parentPath: readonly string[], key: string): boolean {
  const fieldKey = settingsFieldKey(parentPath, key);
  if (fieldKey === undefined) return false;
  return isSecretField(fieldKey.platformId, fieldKey.key);
}

function settingsFieldKey(
  parentPath: readonly string[],
  key: string,
): { readonly platformId: PlatformId; readonly key: string } | undefined {
  if (parentPath[0] !== SETTINGS_PLATFORMS_KEY || parentPath[1] === undefined) return undefined;
  const platformId = parentPath[1];
  if (!isPlatformId(platformId)) return undefined;
  const prefix = parentPath.slice(2);
  return { platformId, key: [...prefix, key].join(".") };
}

function isPlatformId(value: string): value is PlatformId {
  return Object.prototype.hasOwnProperty.call(PLATFORM_BY_ID, value);
}

function isSecretField(platformId: PlatformId, key: string): boolean {
  return PLATFORM_BY_ID[platformId].fields.find((field) => field.key === key)?.kind === "secret";
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => sameValue(left[key], right[key]));
  }
  return false;
}

function isSettingsJson(value: unknown): value is SettingsJson {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every((item) => isSettingsJson(item));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isSettingsJson(item));
}
