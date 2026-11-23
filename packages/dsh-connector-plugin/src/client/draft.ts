import { setPath } from "../platforms/records";
import type { PlatformId, PlatformRecord, PlatformsConfig } from "../platforms/types";
import { PLATFORM_IDS } from "../platforms/types";

export interface SettingsStatus {
  readonly kind: "error" | "saved";
  readonly text: string;
}

export interface SettingsDraft {
  readonly selectedId: PlatformId;
  readonly platforms: PlatformsConfig;
  readonly status?: SettingsStatus;
}

export type DraftAction =
  | { readonly type: "select"; readonly id: PlatformId }
  | { readonly type: "set-enabled"; readonly enabled: boolean }
  | {
      readonly type: "set-field";
      readonly key: string;
      readonly value: string | boolean | number | readonly string[] | undefined;
    }
  | { readonly type: "status"; readonly status: SettingsStatus };

export function createSettingsDraft(platforms: PlatformsConfig | undefined): SettingsDraft {
  const selectedId = PLATFORM_IDS.find((id) => platforms?.[id]?.enabled === true) ?? "feishu";
  return { selectedId, platforms: platforms ?? {} };
}

export function reduceSettingsDraft(draft: SettingsDraft, action: DraftAction): SettingsDraft {
  if (action.type === "select") {
    return { selectedId: action.id, platforms: draft.platforms };
  }
  if (action.type === "status") {
    return { ...draft, status: action.status };
  }

  const current: PlatformRecord = draft.platforms[draft.selectedId] ?? {};
  const nextRecord =
    action.type === "set-enabled"
      ? { ...current, enabled: action.enabled }
      : setPath(current, action.key, action.value);
  return {
    selectedId: draft.selectedId,
    platforms: { ...draft.platforms, [draft.selectedId]: nextRecord },
  };
}
