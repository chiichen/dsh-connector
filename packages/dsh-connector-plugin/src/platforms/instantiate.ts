import {
  ConnectorValidationError,
  type Connector,
  type ConnectorLogger,
} from "@dsh-connector/core";
import { createDingTalkConnector } from "@dsh-connector/connector-dingtalk";
import { createDiscordConnector } from "@dsh-connector/connector-discord";
import { createFeishuConnector } from "@dsh-connector/connector-feishu";
import { createQqConnector } from "@dsh-connector/connector-qq";
import { createSlackConnector } from "@dsh-connector/connector-slack";
import { createTelegramConnector } from "@dsh-connector/connector-telegram";
import { createWeComConnector } from "@dsh-connector/connector-wecom";
import { createWeixinConnector } from "@dsh-connector/connector-weixin";
import { createWhatsAppConnector } from "@dsh-connector/connector-whatsapp";
import {
  isRecord,
  readBoolean,
  readChoice,
  readId,
  readNumber,
  readString,
  readStringList,
} from "./records";
import type { PlatformId, PlatformRecord, PlatformsConfig } from "./types";
import { PLATFORM_IDS } from "./types";
import {
  WECOM_CONNECTION_AIBOT_WS,
  WECOM_CONNECTION_APP,
  WECOM_CONNECTION_CALLBACK,
  WECOM_CONNECTIONS,
} from "./catalog";
import { collectPlatformIssues } from "./validate";

function attachLogger<T extends object>(
  options: T,
  logger: ConnectorLogger | undefined,
): T & { readonly logger?: ConnectorLogger } {
  return logger === undefined ? options : { ...options, logger };
}

const AUTO_ARCHIVE_MINUTES = {
  "60": 60,
  "1440": 1440,
  "4320": 4320,
  "10080": 10080,
} as const;

export function requireString(record: PlatformRecord, key: string, platform: string): string {
  const value = readString(record, key);
  if (value === undefined) {
    throw new ConnectorValidationError(
      `${platform} requires ${key} when the connector is enabled.`,
      { connectorName: platform },
    );
  }
  return value;
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  if (value === undefined) return {};
  return { [key]: value } as Partial<Record<K, V>>;
}

function readAutoArchive(record: PlatformRecord): 60 | 1440 | 4320 | 10080 | undefined {
  const choice = readChoice(record, "autoArchiveDurationMinutes", [
    "60",
    "1440",
    "4320",
    "10080",
  ] as const);
  return choice === undefined ? undefined : AUTO_ARCHIVE_MINUTES[choice];
}

function buildFeishu(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  return createFeishuConnector(
    attachLogger(
      {
        appId: requireString(record, "appId", "feishu"),
        appSecret: requireString(record, "appSecret", "feishu"),
        ...defined("domain", readString(record, "domain")),
        ...defined("verificationToken", readString(record, "verificationToken")),
        ...defined("encryptKey", readString(record, "encryptKey")),
        ...defined("botOpenId", readString(record, "botOpenId")),
        ...defined("botName", readString(record, "botName")),
        ...defined("allowedOpenIds", readStringList(record, "allowedOpenIds")),
        ...defined(
          "groupMentionPolicy",
          readChoice(record, "groupMentionPolicy", ["mention-required", "all"] as const),
        ),
        ...defined("allowAtAllInGroup", readBoolean(record, "allowAtAllInGroup")),
        ...defined("mode", readChoice(record, "mode", ["webhook", "websocket", "both"] as const)),
        ...defined("resolveBotInfoOnStart", readBoolean(record, "resolveBotInfoOnStart")),
        ...defined(
          "resolveReplyContextFromParent",
          readBoolean(record, "resolveReplyContextFromParent"),
        ),
        ...defined(
          "contextMarker",
          readChoice(record, "contextMarker", ["auto", "always", "never"] as const),
        ),
        ...defined(
          "defaultOutboundFormat",
          readChoice(record, "defaultOutboundFormat", ["text", "markdown"] as const),
        ),
      },
      logger,
    ),
  );
}

function buildWeixin(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  const allowedSenderIds = readStringList(record, "allowedSenderIds");
  const mode =
    readChoice(record, "mode", ["official-account", "ilink"] as const) ?? "official-account";
  if (mode === "ilink") {
    return createWeixinConnector(
      attachLogger(
        {
          mode: "ilink",
          botToken: requireString(record, "botToken", "weixin"),
          ...defined("baseUrl", readString(record, "baseUrl")),
          ...defined("botUserId", readString(record, "botUserId")),
          ...defined("initialUpdatesBuf", readString(record, "initialUpdatesBuf")),
          ...defined("allowedSenderIds", allowedSenderIds),
        },
        logger,
      ),
    );
  }
  return createWeixinConnector(
    attachLogger(
      {
        mode: "official-account",
        appId: requireString(record, "appId", "weixin"),
        token: requireString(record, "token", "weixin"),
        ...defined("appSecret", readString(record, "appSecret")),
        ...defined("encodingAesKey", readString(record, "encodingAesKey")),
        ...defined("accountId", readString(record, "accountId")),
        ...defined("accessToken", readString(record, "accessToken")),
        ...defined(
          "tokenStrategy",
          readChoice(record, "tokenStrategy", ["stable", "classic"] as const),
        ),
        ...defined("apiBaseUrl", readString(record, "apiBaseUrl")),
        ...defined("kfAccount", readString(record, "kfAccount")),
        ...defined("businessId", readString(record, "businessId")),
        ...defined("allowedSenderIds", allowedSenderIds),
      },
      logger,
    ),
  );
}

function buildDingTalk(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  return createDingTalkConnector(
    attachLogger(
      {
        ...defined("clientId", readString(record, "clientId")),
        ...defined("clientSecret", readString(record, "clientSecret")),
        ...defined("robotCode", readString(record, "robotCode")),
        ...defined("coolAppCode", readString(record, "coolAppCode")),
        ...defined("webhookSigningSecret", readString(record, "webhookSigningSecret")),
        ...defined("outgoingToken", readString(record, "outgoingToken")),
        ...defined(
          "inboundMode",
          readChoice(record, "inboundMode", ["stream", "webhook", "both", "none"] as const),
        ),
        ...defined("preferSessionWebhook", readBoolean(record, "preferSessionWebhook")),
        ...defined(
          "defaultFormat",
          readChoice(record, "defaultFormat", ["text", "markdown"] as const),
        ),
        ...defined("requireAtInGroup", readBoolean(record, "requireAtInGroup")),
        ...defined("botUserIds", readStringList(record, "botUserIds")),
        ...defined("botStaffIds", readStringList(record, "botStaffIds")),
        ...defined("apiBaseUrl", readString(record, "apiBaseUrl")),
      },
      logger,
    ),
  );
}

function buildWeCom(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  const connection = readChoice(record, "mode", WECOM_CONNECTIONS);
  const corpId = readString(record, "app.corpId");
  const corpSecret = readString(record, "app.corpSecret");
  const agentId = readId(record, "app.agentId");
  const app =
    (connection === undefined || connection === WECOM_CONNECTION_APP) &&
    corpId !== undefined &&
    corpSecret !== undefined &&
    agentId !== undefined
      ? {
          corpId,
          corpSecret,
          agentId,
          ...defined("apiBaseUrl", readString(record, "app.apiBaseUrl")),
          ...defined("enableDuplicateCheck", readBoolean(record, "app.enableDuplicateCheck")),
          ...defined(
            "duplicateCheckIntervalSeconds",
            readNumber(record, "app.duplicateCheckIntervalSeconds"),
          ),
        }
      : undefined;

  const callbackToken = readString(record, "callback.token");
  const encodingAesKey = readString(record, "callback.encodingAesKey");
  const callback =
    (connection === undefined || connection === WECOM_CONNECTION_CALLBACK) &&
    callbackToken !== undefined &&
    encodingAesKey !== undefined
      ? {
          token: callbackToken,
          encodingAesKey,
          ...defined("receiveId", readString(record, "callback.receiveId")),
        }
      : undefined;

  const botId = readString(record, "aibotWs.botId");
  const secret = readString(record, "aibotWs.secret");
  const aibotWs =
    (connection === undefined || connection === WECOM_CONNECTION_AIBOT_WS) &&
    botId !== undefined &&
    secret !== undefined
      ? {
          botId,
          secret,
          ...defined("wsUrl", readString(record, "aibotWs.wsUrl")),
        }
      : undefined;

  return createWeComConnector(
    attachLogger(
      {
        ...defined("app", app),
        ...defined("callback", callback),
        ...defined("aibotWs", aibotWs),
        ...defined("selfUserIds", readStringList(record, "selfUserIds")),
        ...defined("botMentionNames", readStringList(record, "botMentionNames")),
        ...defined("requireMentionInGroup", readBoolean(record, "requireMentionInGroup")),
        ...defined(
          "includeContextMarkerByDefault",
          connection === undefined || connection === WECOM_CONNECTION_APP
            ? readBoolean(record, "includeContextMarkerByDefault")
            : undefined,
        ),
        ...defined(
          "inboundDeliveryMode",
          readChoice(record, "inboundDeliveryMode", ["queue", "steer"] as const),
        ),
      },
      logger,
    ),
  );
}

function buildQq(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  return createQqConnector(
    attachLogger(
      {
        appId: requireString(record, "appId", "qq"),
        clientSecret: requireString(record, "clientSecret", "qq"),
        ...defined("botUserId", readString(record, "botUserId")),
        ...defined("sandbox", readBoolean(record, "sandbox")),
        ...defined("apiBaseUrl", readString(record, "apiBaseUrl")),
        ...defined("tokenUrl", readString(record, "tokenUrl")),
        ...defined("gatewayUrl", readString(record, "gatewayUrl")),
        ...defined(
          "transport",
          readChoice(record, "transport", ["webhook", "websocket", "both"] as const),
        ),
        ...defined(
          "defaultFormat",
          readChoice(record, "defaultFormat", ["plain", "markdown"] as const),
        ),
        ...defined("includeContextMarker", readBoolean(record, "includeContextMarker")),
        ...defined("autoPassiveReply", readBoolean(record, "autoPassiveReply")),
        ...defined(
          "fallbackToPlainOnMarkdownReject",
          readBoolean(record, "fallbackToPlainOnMarkdownReject"),
        ),
      },
      logger,
    ),
  );
}

function buildSlack(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  return createSlackConnector(
    attachLogger(
      {
        botToken: requireString(record, "botToken", "slack"),
        ...defined("signingSecret", readString(record, "signingSecret")),
        ...defined("appToken", readString(record, "appToken")),
        ...defined("mode", readChoice(record, "mode", ["socket", "webhook", "hybrid"] as const)),
        ...defined("botUserId", readString(record, "botUserId")),
        ...defined("appId", readString(record, "appId")),
        ...defined("apiBaseUrl", readString(record, "apiBaseUrl")),
        ...defined(
          "threadReplyPolicy",
          readChoice(record, "threadReplyPolicy", [
            "all",
            "participating",
            "mention-only",
          ] as const),
        ),
        ...defined("deliveryMode", readChoice(record, "deliveryMode", ["queue", "steer"] as const)),
        ...defined("includeContextMarker", readBoolean(record, "includeContextMarker")),
        ...defined("ignoreHttpRetries", readBoolean(record, "ignoreHttpRetries")),
        ...defined("sanitizeBroadcastMentions", readBoolean(record, "sanitizeBroadcastMentions")),
        ...defined("verifyAuthOnStart", readBoolean(record, "verifyAuthOnStart")),
      },
      logger,
    ),
  );
}

function buildTelegram(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  return createTelegramConnector(
    attachLogger(
      {
        botToken: requireString(record, "botToken", "telegram"),
        ...defined("apiBaseUrl", readString(record, "apiBaseUrl")),
        ...defined("botId", readNumber(record, "botId")),
        ...defined("botUsername", readString(record, "botUsername")),
        ...defined("mode", readChoice(record, "mode", ["polling", "webhook", "passive"] as const)),
        ...defined("webhookSecretToken", readString(record, "webhookSecretToken")),
        ...defined("requireWebhookSecretToken", readBoolean(record, "requireWebhookSecretToken")),
        ...defined(
          "groupTriggerMode",
          readChoice(record, "groupTriggerMode", ["mention", "all", "off"] as const),
        ),
        ...defined("allowedChatIds", readStringList(record, "allowedChatIds")),
        ...defined("allowedUserIds", readStringList(record, "allowedUserIds")),
        ...defined("acceptEditedMessages", readBoolean(record, "acceptEditedMessages")),
        ...defined(
          "inboundDeliveryMode",
          readChoice(record, "inboundDeliveryMode", ["queue", "steer"] as const),
        ),
        ...defined("includeContextMarker", readBoolean(record, "includeContextMarker")),
      },
      logger,
    ),
  );
}

function buildDiscord(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  return createDiscordConnector(
    attachLogger(
      {
        ...defined("botToken", readString(record, "botToken")),
        ...defined("publicKey", readString(record, "publicKey")),
        ...defined("botUserId", readString(record, "botUserId")),
        ...defined("enableGateway", readBoolean(record, "enableGateway")),
        ...defined("gatewayUrl", readString(record, "gatewayUrl")),
        ...defined("apiBaseUrl", readString(record, "apiBaseUrl")),
        ...defined("ignoreBotMessages", readBoolean(record, "ignoreBotMessages")),
        ...defined("requireMentionInGuild", readBoolean(record, "requireMentionInGuild")),
        ...defined("autoCreateThreadOnMention", readBoolean(record, "autoCreateThreadOnMention")),
        ...defined("autoArchiveDurationMinutes", readAutoArchive(record)),
        ...defined("includeContextMarker", readBoolean(record, "includeContextMarker")),
      },
      logger,
    ),
  );
}

function buildWhatsApp(record: PlatformRecord, logger: ConnectorLogger | undefined): Connector {
  return createWhatsAppConnector(
    attachLogger(
      {
        accessToken: requireString(record, "accessToken", "whatsapp"),
        phoneNumberId: requireString(record, "phoneNumberId", "whatsapp"),
        ...defined("businessPhoneNumber", readString(record, "businessPhoneNumber")),
        ...defined("verifyToken", readString(record, "verifyToken")),
        ...defined("appSecret", readString(record, "appSecret")),
        ...defined("allowUnsignedWebhooks", readBoolean(record, "allowUnsignedWebhooks")),
        ...defined("apiBaseUrl", readString(record, "apiBaseUrl")),
        ...defined("apiVersion", readString(record, "apiVersion")),
        ...defined("allowedSenders", readStringList(record, "allowedSenders")),
      },
      logger,
    ),
  );
}

function buildPlatformConnector(
  id: PlatformId,
  record: PlatformRecord,
  logger: ConnectorLogger | undefined,
): Connector {
  switch (id) {
    case "feishu":
      return buildFeishu(record, logger);
    case "weixin":
      return buildWeixin(record, logger);
    case "dingtalk":
      return buildDingTalk(record, logger);
    case "wecom":
      return buildWeCom(record, logger);
    case "qq":
      return buildQq(record, logger);
    case "slack":
      return buildSlack(record, logger);
    case "telegram":
      return buildTelegram(record, logger);
    case "discord":
      return buildDiscord(record, logger);
    case "whatsapp":
      return buildWhatsApp(record, logger);
  }
}

/**
 * Builds connector instances from saved platform settings.
 * Disabled platforms are skipped. This does not call `start()`.
 */
export function createConnectorsFromPlatformConfig(
  platforms: PlatformsConfig | undefined,
  logger?: ConnectorLogger,
): Connector[] {
  const issues = collectPlatformIssues(platforms);
  if (issues.length > 0) {
    throw new ConnectorValidationError(issues.join("\n"));
  }
  if (platforms === undefined) return [];

  const connectors: Connector[] = [];
  for (const id of PLATFORM_IDS) {
    const record = platforms[id];
    if (!isRecord(record) || record.enabled !== true) continue;
    connectors.push(buildPlatformConnector(id, record, logger));
  }
  return connectors;
}
