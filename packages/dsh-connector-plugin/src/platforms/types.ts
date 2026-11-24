/**
 * Saved connector settings. Field names match each connector's public constructor options.
 * Programmatic `config.connectors` stays separate so tests and hosts can still pass instances.
 */

export const PLATFORM_IDS = [
  "feishu",
  "weixin",
  "dingtalk",
  "wecom",
  "qq",
  "slack",
  "telegram",
  "discord",
  "whatsapp",
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export type FieldKind = "string" | "secret" | "boolean" | "number" | "enum" | "string-list";

export const FIELD_REQUIREMENTS = ["required", "optional"] as const;

export type FieldRequirement = (typeof FIELD_REQUIREMENTS)[number];

export interface LocalizedText {
  readonly en: string;
  readonly zh: string;
}

export interface PlatformField {
  readonly key: string;
  readonly kind: FieldKind;
  readonly label: LocalizedText;
  readonly description: LocalizedText;
  readonly choices?: readonly string[];
  /** When set, the field is shown only while `mode` is one of these values. */
  readonly modes?: readonly string[];
  /** Shown beside the label so a connection form can mark required and optional fields. */
  readonly requirement?: FieldRequirement;
  /** Display labels for enum choices. Choices without a label use the stored value. */
  readonly choiceLabels?: Readonly<Record<string, LocalizedText>>;
  /**
   * Stored value selected when the record has none.
   * The settings control lists only real choices, so this is the option the user sees.
   */
  readonly defaultChoice?: string;
}

export interface PlatformDefinition {
  readonly id: PlatformId;
  readonly label: LocalizedText;
  readonly description: LocalizedText;
  readonly fields: readonly PlatformField[];
}

export interface PlatformRecord {
  enabled?: boolean;
  [key: string]: unknown;
}

export type PlatformsConfig = Partial<Record<PlatformId, PlatformRecord>>;
