import { isRecord } from "./records";
import type { PlatformRecord, PlatformsConfig } from "./types";
import { PLATFORM_IDS } from "./types";

function mergeRecords(base: PlatformRecord, override: PlatformRecord): PlatformRecord {
  const merged: PlatformRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = merged[key];
    if (isRecord(value) && isRecord(previous)) {
      merged[key] = { ...previous, ...value };
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Deep-merges one level of nested credential groups (WeCom `app`, `callback`, `aibotWs`)
 * so a partial override does not wipe sibling platforms or sibling fields.
 */
export function mergePlatformConfigs(
  base: PlatformsConfig | undefined,
  override: PlatformsConfig | undefined,
): PlatformsConfig | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  const merged: PlatformsConfig = { ...base };
  for (const id of PLATFORM_IDS) {
    const next = override[id];
    if (next === undefined) continue;
    const previous = base[id];
    merged[id] = previous === undefined || !isRecord(next) ? next : mergeRecords(previous, next);
  }
  return merged;
}
