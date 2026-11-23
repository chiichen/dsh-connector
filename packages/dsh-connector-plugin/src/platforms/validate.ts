import { PLATFORM_CATALOG } from "./catalog";
import {
  getPath,
  isRecord,
  readBoolean,
  readChoice,
  readId,
  readNumber,
  readString,
  sanitizePlatforms,
} from "./records";
import type {
  PlatformDefinition,
  PlatformField,
  PlatformId,
  PlatformRecord,
  PlatformsConfig,
} from "./types";

/**
 * Slack bot and app token shapes enforced by `@dsh-connector/connector-slack`.
 * Kept here so the settings form can reject a value before the host restarts the plugin.
 */
const SLACK_BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,}$/;
const SLACK_APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]{10,}$/;

/** Telegram `secret_token` pattern from `@dsh-connector/connector-telegram`. */
const TELEGRAM_SECRET_TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

const PLATFORM_FIELDS = new Map<PlatformId, readonly PlatformField[]>(
  PLATFORM_CATALOG.map((definition) => [definition.id, definition.fields]),
);

function required(platform: string, key: string): string {
  return `${platform} requires ${key} when the connector is enabled.`;
}

function fieldTypeIssue(
  platform: string,
  field: PlatformField,
  value: unknown,
): string | undefined {
  if (field.key === "app.agentId") {
    if (typeof value === "number" && Number.isFinite(value)) return undefined;
    if (typeof value === "string") return undefined;
    return `${platform} field app.agentId must be a string or a number.`;
  }

  switch (field.kind) {
    case "string":
    case "secret":
    case "enum":
      if (typeof value !== "string") return `${platform} field ${field.key} must be a string.`;
      if (field.kind === "enum" && field.choices !== undefined && !field.choices.includes(value)) {
        return `${platform} field ${field.key} must be one of: ${field.choices.join(", ")}.`;
      }
      return undefined;
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : `${platform} field ${field.key} must be a boolean.`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `${platform} field ${field.key} must be a number.`;
    case "string-list":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return `${platform} field ${field.key} must be a list of strings.`;
      }
      return undefined;
  }
}

function fieldTypeIssues(definition: PlatformDefinition, record: PlatformRecord): string[] {
  const issues: string[] = [];
  for (const field of definition.fields) {
    const value = getPath(record, field.key);
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const issue = fieldTypeIssue(definition.id, field, value);
    if (issue !== undefined) issues.push(issue);
  }
  return issues;
}

function present(value: unknown): boolean {
  return value !== undefined;
}

function wecomIssues(record: PlatformRecord): string[] {
  const issues: string[] = [];
  const corpId = readString(record, "app.corpId");
  const corpSecret = readString(record, "app.corpSecret");
  const agentId = readId(record, "app.agentId");
  const anyApp = [
    corpId,
    corpSecret,
    agentId,
    readString(record, "app.apiBaseUrl"),
    readBoolean(record, "app.enableDuplicateCheck"),
    readNumber(record, "app.duplicateCheckIntervalSeconds"),
  ].some(present);
  if (anyApp && (corpId === undefined || corpSecret === undefined || agentId === undefined)) {
    issues.push("wecom app requires corpId, corpSecret, and agentId together.");
  }

  const callbackToken = readString(record, "callback.token");
  const encodingAesKey = readString(record, "callback.encodingAesKey");
  const anyCallback = [
    callbackToken,
    encodingAesKey,
    readString(record, "callback.receiveId"),
  ].some(present);
  if (anyCallback && (callbackToken === undefined || encodingAesKey === undefined)) {
    issues.push("wecom callback requires token and encodingAesKey together.");
  }

  const botId = readString(record, "aibotWs.botId");
  const secret = readString(record, "aibotWs.secret");
  const anySocket = [botId, secret, readString(record, "aibotWs.wsUrl")].some(present);
  if (anySocket && (botId === undefined || secret === undefined)) {
    issues.push("wecom aibotWs requires botId and secret together.");
  }
  return issues;
}

function requirementIssues(id: PlatformId, record: PlatformRecord): string[] {
  switch (id) {
    case "feishu":
      return [
        ...(readString(record, "appId") === undefined ? [required("feishu", "appId")] : []),
        ...(readString(record, "appSecret") === undefined ? [required("feishu", "appSecret")] : []),
      ];
    case "weixin": {
      const rawMode = readString(record, "mode");
      const mode = readChoice(record, "mode", ["official-account", "ilink"] as const);
      if (rawMode !== undefined && mode === undefined) return [];
      if (mode === "ilink") {
        return readString(record, "botToken") === undefined ? [required("weixin", "botToken")] : [];
      }
      return [
        ...(readString(record, "appId") === undefined ? [required("weixin", "appId")] : []),
        ...(readString(record, "token") === undefined ? [required("weixin", "token")] : []),
      ];
    }
    case "dingtalk":
      return [];
    case "wecom":
      return wecomIssues(record);
    case "qq":
      return [
        ...(readString(record, "appId") === undefined ? [required("qq", "appId")] : []),
        ...(readString(record, "clientSecret") === undefined
          ? [required("qq", "clientSecret")]
          : []),
      ];
    case "slack":
      return slackIssues(record);
    case "telegram":
      return telegramIssues(record);
    case "discord":
      return discordIssues(record);
    case "whatsapp":
      return [
        ...(readString(record, "accessToken") === undefined
          ? [required("whatsapp", "accessToken")]
          : []),
        ...(readString(record, "phoneNumberId") === undefined
          ? [required("whatsapp", "phoneNumberId")]
          : []),
      ];
  }
}

function slackIssues(record: PlatformRecord): string[] {
  const issues: string[] = [];
  const botToken = readString(record, "botToken");
  const appToken = readString(record, "appToken");
  const signingSecret = readString(record, "signingSecret");
  if (botToken === undefined) issues.push(required("slack", "botToken"));
  else if (!SLACK_BOT_TOKEN_RE.test(botToken)) {
    issues.push('Invalid Slack botToken: expected a token starting with "xoxb-".');
  }
  if (appToken !== undefined && !SLACK_APP_TOKEN_RE.test(appToken)) {
    issues.push('Invalid Slack appToken: expected a token starting with "xapp-".');
  }
  const mode = readChoice(record, "mode", ["socket", "webhook", "hybrid"] as const);
  if ((mode === "socket" || mode === "hybrid") && appToken === undefined) {
    issues.push(`slack requires appToken when mode is "${mode}".`);
  }
  if ((mode === "webhook" || mode === "hybrid") && signingSecret === undefined) {
    issues.push(`slack requires signingSecret when mode is "${mode}".`);
  }
  return issues;
}

function telegramIssues(record: PlatformRecord): string[] {
  const issues: string[] = [];
  if (readString(record, "botToken") === undefined) issues.push(required("telegram", "botToken"));
  const secret = readString(record, "webhookSecretToken");
  if (secret !== undefined && !TELEGRAM_SECRET_TOKEN_RE.test(secret)) {
    issues.push(
      "Invalid Telegram webhookSecretToken: must be 1..256 characters containing only [A-Za-z0-9_-].",
    );
  }
  return issues;
}

function discordIssues(record: PlatformRecord): string[] {
  const issues: string[] = [];
  const botToken = readString(record, "botToken");
  const publicKey = readString(record, "publicKey");
  if (botToken === undefined && publicKey === undefined) {
    issues.push("discord requires botToken or publicKey when the connector is enabled.");
  }
  if (readBoolean(record, "enableGateway") === true && botToken === undefined) {
    issues.push("discord requires botToken when enableGateway is true.");
  }
  return issues;
}

export function collectPlatformIssues(platforms: PlatformsConfig | undefined): string[] {
  if (platforms === undefined) return [];
  const issues: string[] = [];
  for (const definition of PLATFORM_CATALOG) {
    const record = platforms[definition.id];
    if (record === undefined) continue;
    if (!isRecord(record)) {
      issues.push(`${definition.id} settings must be an object.`);
      continue;
    }
    if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
      issues.push(`${definition.id} field enabled must be a boolean.`);
      continue;
    }
    if (record.enabled !== true) continue;
    issues.push(
      ...fieldTypeIssues(definition, record),
      ...requirementIssues(definition.id, record),
    );
  }
  return issues;
}

export type PreparedPlatforms =
  | { readonly ok: true; readonly platforms: PlatformsConfig }
  | { readonly ok: false; readonly message: string };

export function preparePlatformSave(platforms: PlatformsConfig): PreparedPlatforms {
  const sanitized = sanitizePlatforms(platforms, PLATFORM_FIELDS);
  const issues = collectPlatformIssues(sanitized);
  if (issues.length > 0) return { ok: false, message: issues.join("\n") };
  return { ok: true, platforms: sanitized };
}

export function sanitizePlatformSettings(platforms: PlatformsConfig): PlatformsConfig {
  return sanitizePlatforms(platforms, PLATFORM_FIELDS);
}
