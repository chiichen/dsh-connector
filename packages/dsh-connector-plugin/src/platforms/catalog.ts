import { getPath, isRecord, setPath } from "./records";
import type {
  FieldKind,
  FieldRequirement,
  LocalizedText,
  PlatformDefinition,
  PlatformField,
  PlatformId,
  PlatformRecord,
  PlatformsConfig,
} from "./types";
import { PLATFORM_IDS } from "./types";

interface FieldInput {
  readonly key: string;
  readonly kind: FieldKind;
  readonly en: string;
  readonly zh: string;
  readonly detailEn: string;
  readonly detailZh: string;
  readonly choices?: readonly string[];
  readonly modes?: readonly string[];
  readonly requirement?: FieldRequirement;
  readonly choiceLabels?: Readonly<Record<string, LocalizedText>>;
  readonly defaultChoice?: string;
}

type FieldExtra = Pick<FieldInput, "modes" | "requirement" | "choiceLabels" | "defaultChoice">;

function field(input: FieldInput): PlatformField {
  return {
    key: input.key,
    kind: input.kind,
    label: { en: input.en, zh: input.zh },
    description: { en: input.detailEn, zh: input.detailZh },
    ...(input.choices !== undefined ? { choices: input.choices } : {}),
    ...(input.modes !== undefined ? { modes: input.modes } : {}),
    ...(input.requirement !== undefined ? { requirement: input.requirement } : {}),
    ...(input.choiceLabels !== undefined ? { choiceLabels: input.choiceLabels } : {}),
    ...(input.defaultChoice !== undefined ? { defaultChoice: input.defaultChoice } : {}),
  };
}

function text(
  key: string,
  en: string,
  zh: string,
  detailEn: string,
  detailZh: string,
  extra?: FieldExtra,
): PlatformField {
  return field({ key, kind: "string", en, zh, detailEn, detailZh, ...extra });
}

function secret(
  key: string,
  en: string,
  zh: string,
  detailEn: string,
  detailZh: string,
  extra?: FieldExtra,
): PlatformField {
  return field({ key, kind: "secret", en, zh, detailEn, detailZh, ...extra });
}

function bool(
  key: string,
  en: string,
  zh: string,
  detailEn: string,
  detailZh: string,
  extra?: FieldExtra,
): PlatformField {
  return field({ key, kind: "boolean", en, zh, detailEn, detailZh, ...extra });
}

function choice(
  key: string,
  en: string,
  zh: string,
  detailEn: string,
  detailZh: string,
  choices: readonly string[],
  extra?: FieldExtra,
): PlatformField {
  return field({ key, kind: "enum", en, zh, detailEn, detailZh, choices, ...extra });
}

function list(
  key: string,
  en: string,
  zh: string,
  detailEn: string,
  detailZh: string,
): PlatformField {
  return field({
    key,
    kind: "string-list",
    en,
    zh,
    detailEn: `${detailEn} One entry per line.`,
    detailZh: `${detailZh}每行一项。`,
  });
}

const lines = list;

const OFFICIAL = ["official-account"] as const;
const ILINK = ["ilink"] as const;

/** Stored `mode` for a WeCom self-built app. */
export const WECOM_CONNECTION_APP = "app" as const;
/** Stored `mode` for a WeCom HTTP callback. */
export const WECOM_CONNECTION_CALLBACK = "callback" as const;
/**
 * Stored `mode` for a WeCom AI bot long connection.
 * The subscribe frame requires only `bot_id` and `secret`.
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export const WECOM_CONNECTION_AIBOT_WS = "aibotWs" as const;

export const WECOM_CONNECTIONS = [
  WECOM_CONNECTION_APP,
  WECOM_CONNECTION_CALLBACK,
  WECOM_CONNECTION_AIBOT_WS,
] as const;

const WECOM_APP = [WECOM_CONNECTION_APP] as const;
const WECOM_CALLBACK = [WECOM_CONNECTION_CALLBACK] as const;
const WECOM_AIBOT_WS = [WECOM_CONNECTION_AIBOT_WS] as const;

/** Inbound messages wait in the session queue. */
const DELIVERY_QUEUE = "queue" as const;
/** Inbound messages steer the active session. */
const DELIVERY_STEER = "steer" as const;
const DELIVERY_MODES = [DELIVERY_QUEUE, DELIVERY_STEER] as const;

const feishu: PlatformDefinition = {
  id: "feishu",
  label: { en: "Feishu", zh: "飞书" },
  description: {
    en: "Feishu or Lark custom app. App ID and App Secret come from the Feishu Open Platform.",
    zh: "飞书或 Lark 企业自建应用。App ID 与 App Secret 来自飞书开放平台。",
  },
  fields: [
    text(
      "appId",
      "App ID",
      "App ID",
      "Feishu custom app App ID (cli_...).",
      "飞书企业自建应用 App ID（cli_...）。",
    ),
    secret(
      "appSecret",
      "App Secret",
      "App Secret",
      "Feishu custom app App Secret.",
      "飞书企业自建应用 App Secret。",
    ),
    text(
      "domain",
      "Domain",
      "域名",
      'open.feishu.cn ("feishu"), open.larksuite.com ("lark"), or a custom API base URL.',
      "feishu（open.feishu.cn）、lark（open.larksuite.com），或自定义 API 基址。",
    ),
    secret(
      "verificationToken",
      "Verification Token",
      "Verification Token",
      "Optional verification token for webhook authenticity checks.",
      "可选。用于校验事件订阅请求的 Verification Token。",
    ),
    secret(
      "encryptKey",
      "Encrypt Key",
      "Encrypt Key",
      "Optional encrypt key for webhook decryption and request signatures.",
      "可选。用于事件订阅解密与签名校验的 Encrypt Key。",
    ),
    choice("mode", "Receive mode", "接收方式", "Inbound transport.", "入站传输方式。", [
      "webhook",
      "websocket",
      "both",
    ]),
    text(
      "botOpenId",
      "Bot open_id",
      "机器人 open_id",
      "Bot open_id (ou_...) used to match @mentions.",
      "用于匹配 @ 的机器人 open_id（ou_...）。",
    ),
    text(
      "botName",
      "Bot name",
      "机器人名称",
      "Bot display name used when matching @mentions.",
      "匹配 @ 时使用的机器人名称。",
    ),
    lines(
      "allowedOpenIds",
      "Allowed open_ids",
      "允许的 open_id",
      "Sender open_id allowlist. Leave empty to allow the tenant.",
      "发送者 open_id 白名单。留空表示允许租户内用户。",
    ),
    choice(
      "groupMentionPolicy",
      "Group mention policy",
      "群聊触发",
      "How group chats wake the bot.",
      "群聊如何唤醒机器人。",
      ["mention-required", "all"],
    ),
    bool(
      "allowAtAllInGroup",
      "Allow @all",
      "允许 @所有人",
      "Treat @all as a mention of the bot.",
      "把 @所有人 视为 @ 机器人。",
    ),
    bool(
      "resolveBotInfoOnStart",
      "Resolve bot info on start",
      "启动时读取机器人信息",
      "Call the bot info API during start when bot open_id is empty.",
      "未填写机器人 open_id 时，在启动阶段请求机器人信息。",
    ),
    bool(
      "resolveReplyContextFromParent",
      "Resolve reply context",
      "解析被回复消息的上下文",
      "Look up the parent message when a user replies.",
      "用户回复消息时，查找被回复消息中的上下文。",
    ),
    choice(
      "contextMarker",
      "Context marker",
      "上下文标记",
      "When to attach an outbound context marker.",
      "何时附带出站上下文标记。",
      ["auto", "always", "never"],
    ),
    choice(
      "defaultOutboundFormat",
      "Default format",
      "默认消息格式",
      "Outbound format used when a send omits format.",
      "发送时未指定格式则使用该格式。",
      ["text", "markdown"],
    ),
  ],
};

const weixin: PlatformDefinition = {
  id: "weixin",
  label: { en: "WeChat", zh: "微信" },
  description: {
    en: "WeChat Official Account callbacks, or an iLink bot token. Official Account mode needs App ID and Token.",
    zh: "微信公众号回调，或 iLink 机器人 Token。公众号模式需要 AppID 与 Token。",
  },
  fields: [
    choice(
      "mode",
      "Mode",
      "模式",
      "Official Account callbacks or iLink long polling.",
      "公众号回调或 iLink 长轮询。",
      ["official-account", "ilink"],
    ),
    text("appId", "App ID", "AppID", "Official Account AppID (wx...).", "公众号 AppID（wx...）。", {
      modes: OFFICIAL,
    }),
    secret(
      "token",
      "Token",
      "Token",
      "Callback verification token from the WeChat developer console.",
      "微信开发者平台里的回调 Token。",
      {
        modes: OFFICIAL,
      },
    ),
    secret(
      "appSecret",
      "App Secret",
      "AppSecret",
      "AppSecret used to obtain an access token.",
      "用于获取 access_token 的 AppSecret。",
      {
        modes: OFFICIAL,
      },
    ),
    secret(
      "encodingAesKey",
      "EncodingAESKey",
      "EncodingAESKey",
      "43-character EncodingAESKey for safe or compatible callback encryption.",
      "安全模式或兼容模式的 43 位 EncodingAESKey。",
      { modes: OFFICIAL },
    ),
    text(
      "accountId",
      "Account ID",
      "原始 ID",
      "Original account ID (gh_...) used to ignore the account's own messages.",
      "用于过滤自己消息的公众号原始 ID（gh_...）。",
      {
        modes: OFFICIAL,
      },
    ),
    secret(
      "accessToken",
      "Access token",
      "access_token",
      "Optional static access token.",
      "可选的静态 access_token。",
      { modes: OFFICIAL },
    ),
    choice(
      "tokenStrategy",
      "Token strategy",
      "令牌策略",
      "How the connector fetches an access token.",
      "获取 access_token 的方式。",
      ["stable", "classic"],
      {
        modes: OFFICIAL,
      },
    ),
    text(
      "apiBaseUrl",
      "API base URL",
      "API 基址",
      "Official Account API base URL.",
      "公众号 API 基址。",
      { modes: OFFICIAL },
    ),
    text(
      "kfAccount",
      "Customer service account",
      "客服账号",
      "Default customer-service account (kf_account).",
      "默认客服账号（kf_account）。",
      {
        modes: OFFICIAL,
      },
    ),
    text(
      "businessId",
      "Business ID",
      "businessid",
      "Optional sub-merchant businessid for customer-service sends.",
      "客服消息可选的子商户 businessid。",
      {
        modes: OFFICIAL,
      },
    ),
    secret(
      "botToken",
      "iLink bot token",
      "iLink 机器人 Token",
      "iLink bot token (ilink_bot_token).",
      "iLink 机器人 Token（ilink_bot_token）。",
      {
        modes: ILINK,
      },
    ),
    text("baseUrl", "iLink base URL", "iLink 基址", "iLink API base URL.", "iLink API 基址。", {
      modes: ILINK,
    }),
    text(
      "botUserId",
      "Bot user ID",
      "机器人用户 ID",
      "Bot user id used to ignore the bot's own iLink messages.",
      "用于过滤 iLink 自己消息的机器人用户 ID。",
      {
        modes: ILINK,
      },
    ),
    text(
      "initialUpdatesBuf",
      "Updates cursor",
      "更新游标",
      "Initial get_updates_buf cursor.",
      "初始 get_updates_buf 游标。",
      { modes: ILINK },
    ),
    lines(
      "allowedSenderIds",
      "Allowed senders",
      "允许的发送者",
      "Sender id allowlist.",
      "发送者 ID 白名单。",
    ),
  ],
};

const dingtalk: PlatformDefinition = {
  id: "dingtalk",
  label: { en: "DingTalk", zh: "钉钉" },
  description: {
    en: "DingTalk internal app. Client ID and Client Secret are optional. When both are set and inbound mode is empty, the connector uses Stream.",
    zh: "钉钉企业内部应用。Client ID 与 Client Secret 可选。两者都填写且未选择入站方式时，连接器使用 Stream。",
  },
  fields: [
    text(
      "clientId",
      "Client ID",
      "Client ID",
      "Internal app Client ID (AppKey) or third-party SuiteKey.",
      "企业内部应用 Client ID（AppKey）或第三方 SuiteKey。",
    ),
    secret(
      "clientSecret",
      "Client Secret",
      "Client Secret",
      "Internal app Client Secret (AppSecret) or SuiteSecret.",
      "企业内部应用 Client Secret（AppSecret）或 SuiteSecret。",
    ),
    text(
      "robotCode",
      "Robot code",
      "robotCode",
      "Enterprise robot robotCode. Defaults to Client ID.",
      "企业机器人 robotCode。默认与 Client ID 相同。",
    ),
    text(
      "coolAppCode",
      "Cool App code",
      "coolAppCode",
      "Optional coolAppCode for group Cool App messages.",
      "群聊酷应用消息可选的 coolAppCode。",
    ),
    secret(
      "webhookSigningSecret",
      "Webhook signing secret",
      "Webhook 签名密钥",
      "Optional HMAC secret for outgoing robot webhooks. Defaults to Client Secret.",
      "可选。Outgoing 机器人签名密钥，默认使用 Client Secret。",
    ),
    secret(
      "outgoingToken",
      "Outgoing token",
      "Outgoing Token",
      "Optional token checked on custom robot outgoing requests.",
      "可选。自定义机器人 Outgoing 请求的 token。",
    ),
    choice(
      "inboundMode",
      "Inbound mode",
      "入站方式",
      "Stream opens a WebSocket on start. Webhook waits for HTTP callbacks.",
      "Stream 会在启动时连接 WebSocket。Webhook 只接收 HTTP 回调。",
      ["stream", "webhook", "both", "none"],
    ),
    bool(
      "preferSessionWebhook",
      "Prefer session webhook",
      "优先使用 sessionWebhook",
      "Reply through a cached session webhook before calling OpenAPI.",
      "优先用缓存的 sessionWebhook 回复，再调用 OpenAPI。",
    ),
    choice(
      "defaultFormat",
      "Default format",
      "默认消息格式",
      "Outbound format used when a send omits format.",
      "发送时未指定格式则使用该格式。",
      ["text", "markdown"],
    ),
    bool(
      "requireAtInGroup",
      "Require @ in groups",
      "群聊必须 @",
      "Require isInAtList on group messages.",
      "群消息必须 isInAtList 为真。",
    ),
    lines(
      "botUserIds",
      "Bot user IDs",
      "机器人 userId",
      "chatbotUserId or senderId values treated as the bot.",
      "视为机器人自己的 chatbotUserId 或 senderId。",
    ),
    lines(
      "botStaffIds",
      "Bot staff IDs",
      "机器人 staffId",
      "staffId values treated as the bot.",
      "视为机器人自己的 staffId。",
    ),
    text(
      "apiBaseUrl",
      "API base URL",
      "API 基址",
      "DingTalk OpenAPI base URL.",
      "钉钉 OpenAPI 基址。",
    ),
  ],
};

/**
 * Three mutually exclusive WeCom connection forms. Pick one, then only that
 * form's credentials are shown and saved.
 *
 * Self-built app: corpid and corpsecret obtain the access token, and agentid
 * identifies the app. API base URL and duplicate-check settings are optional.
 * @see https://developer.work.weixin.qq.com/document/path/91039
 * @see https://developer.work.weixin.qq.com/document/path/96458
 *
 * HTTP callback: Token and EncodingAESKey are required. receiveId is optional;
 * an intelligent-bot callback uses an empty receiveId.
 * @see https://developer.work.weixin.qq.com/document/path/90930
 * @see https://developer.work.weixin.qq.com/document/path/101033
 *
 * AI bot long connection: `aibot_subscribe` requires only `bot_id` and `secret`.
 * That secret is the long-connection key, not the HTTP callback Token or
 * EncodingAESKey. WeCom publishes the WebSocket URL, so `wsUrl` is optional.
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
const wecom: PlatformDefinition = {
  id: "wecom",
  label: { en: "WeCom", zh: "企业微信" },
  description: {
    en: "Choose one connection. A self-built app, an HTTP callback, and an AI bot long connection each use their own credentials.",
    zh: "先选择一种接入形式。自建应用、HTTP 回调和智能机器人长连接各自使用一套凭据。",
  },
  fields: [
    choice(
      "mode",
      "Connection",
      "接入形式",
      "Self-built app, HTTP callback, or AI bot long connection.",
      "自建应用、HTTP 回调，或智能机器人长连接。",
      WECOM_CONNECTIONS,
      {
        defaultChoice: WECOM_CONNECTION_AIBOT_WS,
        choiceLabels: {
          [WECOM_CONNECTION_APP]: { en: "Self-built app", zh: "自建应用" },
          [WECOM_CONNECTION_CALLBACK]: { en: "HTTP callback", zh: "HTTP 回调" },
          [WECOM_CONNECTION_AIBOT_WS]: {
            en: "AI bot long connection",
            zh: "智能机器人长连接",
          },
        },
      },
    ),
    text(
      "app.corpId",
      "Corp ID",
      "企业 ID",
      "Self-built app corpid.",
      "自建应用的企业 ID（corpid）。",
      { modes: WECOM_APP, requirement: "required" },
    ),
    secret(
      "app.corpSecret",
      "Corp secret",
      "应用 Secret",
      "Self-built app corpsecret.",
      "自建应用的 corpsecret。",
      { modes: WECOM_APP, requirement: "required" },
    ),
    text("app.agentId", "Agent ID", "AgentId", "Self-built app agentid.", "自建应用的 agentid。", {
      modes: WECOM_APP,
      requirement: "required",
    }),
    text(
      "app.apiBaseUrl",
      "API base URL",
      "API 基址",
      "WeCom API base URL for the self-built app.",
      "自建应用使用的企业微信 API 基址。",
      { modes: WECOM_APP, requirement: "optional" },
    ),
    bool(
      "app.enableDuplicateCheck",
      "Duplicate check",
      "开启重复消息检查",
      "Enable WeCom duplicate message checking.",
      "开启企业微信重复消息检查。",
      { modes: WECOM_APP, requirement: "optional" },
    ),
    field({
      key: "app.duplicateCheckIntervalSeconds",
      kind: "number",
      en: "Duplicate check interval",
      zh: "重复消息检查间隔",
      detailEn: "duplicate_check_interval in seconds.",
      detailZh: "重复消息检查间隔（秒）。",
      modes: WECOM_APP,
      requirement: "optional",
    }),
    secret(
      "callback.token",
      "Callback token",
      "回调 Token",
      "HTTP callback token.",
      "HTTP 回调 Token。",
      { modes: WECOM_CALLBACK, requirement: "required" },
    ),
    secret(
      "callback.encodingAesKey",
      "Callback EncodingAESKey",
      "回调 EncodingAESKey",
      "HTTP callback EncodingAESKey.",
      "HTTP 回调 EncodingAESKey。",
      { modes: WECOM_CALLBACK, requirement: "required" },
    ),
    text(
      "callback.receiveId",
      "Callback receive ID",
      "回调 receiveId",
      "Optional receiveId. Defaults to the app corp ID. An intelligent-bot callback uses an empty string.",
      "可选 receiveId。默认使用应用的企业 ID。智能机器人回调使用空字符串。",
      { modes: WECOM_CALLBACK, requirement: "optional" },
    ),
    text(
      "aibotWs.botId",
      "Bot ID",
      "Bot ID",
      "AI bot BotID for the long connection.",
      "智能机器人长连接的 BotID。",
      { modes: WECOM_AIBOT_WS, requirement: "required" },
    ),
    secret(
      "aibotWs.secret",
      "Secret",
      "Secret",
      "Long-connection secret. This is not the HTTP callback Token or EncodingAESKey.",
      "长连接 Secret。不是 HTTP 回调的 Token 或 EncodingAESKey。",
      { modes: WECOM_AIBOT_WS, requirement: "required" },
    ),
    text(
      "aibotWs.wsUrl",
      "WebSocket URL",
      "WebSocket 地址",
      "Optional override. WeCom publishes the default long-connection URL.",
      "可选。企业微信公布了默认长连接地址。",
      { modes: WECOM_AIBOT_WS, requirement: "optional" },
    ),
    lines(
      "selfUserIds",
      "Self user IDs",
      "自己的用户 ID",
      "User ids treated as the bot.",
      "视为机器人自己的用户 ID。",
    ),
    lines(
      "botMentionNames",
      "Bot mention names",
      "机器人称呼",
      "Names that count as mentioning the bot.",
      "视为 @ 机器人的名称。",
    ),
    bool(
      "requireMentionInGroup",
      "Require mention in groups",
      "群聊必须 @",
      "Ignore group messages that do not mention the bot.",
      "忽略没有 @ 机器人的群消息。",
    ),
    bool(
      "includeContextMarkerByDefault",
      "Include context marker",
      "默认附带上下文标记",
      "Attach a context marker on outbound app messages.",
      "自建应用出站消息默认附带上下文标记。",
      { modes: WECOM_APP, requirement: "optional" },
    ),
    choice(
      "inboundDeliveryMode",
      "Inbound delivery",
      "入站投递",
      "How inbound messages enter the agent session.",
      "入站消息如何进入 Agent 会话。",
      DELIVERY_MODES,
      { defaultChoice: DELIVERY_QUEUE },
    ),
  ],
};

const qq: PlatformDefinition = {
  id: "qq",
  label: { en: "QQ", zh: "QQ" },
  description: {
    en: "QQ Bot Open Platform app. App ID and client secret are required.",
    zh: "QQ 机器人开放平台应用。需要 App ID 与 Client Secret。",
  },
  fields: [
    text("appId", "App ID", "App ID", "QQ bot app id.", "QQ 机器人 App ID。"),
    secret(
      "clientSecret",
      "Client secret",
      "Client Secret",
      "QQ bot client secret.",
      "QQ 机器人 Client Secret。",
    ),
    text(
      "botUserId",
      "Bot user ID",
      "机器人用户 ID",
      "Known bot user id.",
      "已知的机器人用户 ID。",
    ),
    bool("sandbox", "Sandbox", "沙箱环境", "Call the QQ sandbox API host.", "请求 QQ 沙箱 API。"),
    choice(
      "transport",
      "Transport",
      "传输方式",
      "Webhook, gateway WebSocket, or both.",
      "Webhook、网关 WebSocket，或两者。",
      ["webhook", "websocket", "both"],
    ),
    text("apiBaseUrl", "API base URL", "API 基址", "QQ OpenAPI base URL.", "QQ OpenAPI 基址。"),
    text("tokenUrl", "Token URL", "令牌地址", "OAuth token URL.", "OAuth 令牌地址。"),
    text(
      "gatewayUrl",
      "Gateway URL",
      "网关地址",
      "QQ gateway WebSocket URL.",
      "QQ 网关 WebSocket 地址。",
    ),
    choice(
      "defaultFormat",
      "Default format",
      "默认消息格式",
      "Outbound format used when a send omits format.",
      "发送时未指定格式则使用该格式。",
      ["plain", "markdown"],
    ),
    bool(
      "includeContextMarker",
      "Include context marker",
      "附带上下文标记",
      "Attach a context marker on outbound messages.",
      "出站消息附带上下文标记。",
    ),
    bool(
      "autoPassiveReply",
      "Auto passive reply",
      "自动被动回复",
      "Use a passive reply when the inbound event is still valid.",
      "入站事件仍有效时自动使用被动回复。",
    ),
    bool(
      "fallbackToPlainOnMarkdownReject",
      "Fall back to plain text",
      "Markdown 被拒时回退纯文本",
      "Resend as plain text when QQ rejects markdown.",
      "QQ 拒绝 Markdown 时改发纯文本。",
    ),
  ],
};

const slack: PlatformDefinition = {
  id: "slack",
  label: { en: "Slack", zh: "Slack" },
  description: {
    en: "Slack app. The bot token must start with xoxb-. Socket Mode needs an app-level token (xapp-). Events API webhooks need a signing secret.",
    zh: "Slack 应用。Bot Token 必须以 xoxb- 开头。Socket Mode 需要 xapp- 应用级令牌。Events API Webhook 需要 Signing Secret。",
  },
  fields: [
    secret(
      "botToken",
      "Bot token",
      "Bot Token",
      "Bot user OAuth token (xoxb-...) with chat:write.",
      "具有 chat:write 的 Bot User OAuth Token（xoxb-...）。",
    ),
    secret(
      "signingSecret",
      "Signing secret",
      "Signing Secret",
      "Signing secret used to verify Events API webhooks.",
      "用于校验 Events API Webhook 的 Signing Secret。",
    ),
    secret(
      "appToken",
      "App-level token",
      "App-Level Token",
      "App-level token (xapp-...) with connections:write for Socket Mode.",
      "用于 Socket Mode、具有 connections:write 的应用级令牌（xapp-...）。",
    ),
    choice(
      "mode",
      "Mode",
      "模式",
      "Leave empty to infer socket, webhook, or hybrid from the tokens above.",
      "留空时根据上面的令牌推断 socket、webhook 或 hybrid。",
      ["socket", "webhook", "hybrid"],
    ),
    text(
      "botUserId",
      "Bot user ID",
      "机器人用户 ID",
      "Known bot user id.",
      "已知的机器人用户 ID。",
    ),
    text("appId", "App ID", "App ID", "Slack app id.", "Slack App ID。"),
    text(
      "apiBaseUrl",
      "API base URL",
      "API 基址",
      "Slack Web API base URL.",
      "Slack Web API 基址。",
    ),
    choice(
      "threadReplyPolicy",
      "Thread reply policy",
      "线程回复策略",
      "Which thread messages the bot accepts.",
      "机器人接收哪些线程消息。",
      ["all", "participating", "mention-only"],
    ),
    choice(
      "deliveryMode",
      "Inbound delivery",
      "入站投递",
      "How inbound messages enter the agent session.",
      "入站消息如何进入 Agent 会话。",
      ["queue", "steer"],
    ),
    bool(
      "includeContextMarker",
      "Include context marker",
      "附带上下文标记",
      "Attach a context marker on outbound messages.",
      "出站消息附带上下文标记。",
    ),
    bool(
      "ignoreHttpRetries",
      "Ignore HTTP retries",
      "忽略 HTTP 重试",
      "Drop retried Events API deliveries.",
      "丢弃 Events API 的重试投递。",
    ),
    bool(
      "sanitizeBroadcastMentions",
      "Sanitize broadcast mentions",
      "清理广播 @",
      "Strip channel and here broadcast mentions from outbound text.",
      "发送前移除 <!channel> 与 <!here>。",
    ),
    bool(
      "verifyAuthOnStart",
      "Verify auth on start",
      "启动时校验身份",
      "Call auth.test during start when the bot user id is empty.",
      "未填写机器人用户 ID 时，启动阶段调用 auth.test。",
    ),
  ],
};

const telegram: PlatformDefinition = {
  id: "telegram",
  label: { en: "Telegram", zh: "Telegram" },
  description: {
    en: "Telegram bot token from BotFather. Empty mode polls unless a webhook secret is set, which selects webhook.",
    zh: "来自 BotFather 的 Telegram 机器人令牌。模式留空时默认轮询；填写了 Webhook Secret 且未选择模式时使用 Webhook。",
  },
  fields: [
    secret(
      "botToken",
      "Bot token",
      "机器人令牌",
      "Bot token issued by BotFather.",
      "BotFather 颁发的机器人令牌。",
    ),
    choice(
      "mode",
      "Mode",
      "模式",
      "Polling opens a long-poll loop on start. Webhook and passive wait for HTTP.",
      "Polling 会在启动后长轮询。Webhook 与 passive 等待 HTTP。",
      ["polling", "webhook", "passive"],
    ),
    secret(
      "webhookSecretToken",
      "Webhook secret token",
      "Webhook Secret Token",
      "Secret token checked against X-Telegram-Bot-Api-Secret-Token. 1–256 characters: letters, digits, underscore, hyphen.",
      "与请求头 X-Telegram-Bot-Api-Secret-Token 比对。1–256 位，仅字母、数字、下划线和连字符。",
    ),
    bool(
      "requireWebhookSecretToken",
      "Require webhook secret",
      "要求 Webhook 密钥",
      "Reject webhooks when the secret token is missing.",
      "缺少密钥时拒绝 Webhook。",
    ),
    text(
      "apiBaseUrl",
      "API base URL",
      "API 基址",
      "Telegram Bot API base URL.",
      "Telegram Bot API 基址。",
    ),
    field({
      key: "botId",
      kind: "number",
      en: "Bot ID",
      zh: "机器人 ID",
      detailEn: "Known numeric bot id from getMe.",
      detailZh: "getMe 返回的数字机器人 ID。",
    }),
    text(
      "botUsername",
      "Bot username",
      "机器人用户名",
      "Bot username without @.",
      "不带 @ 的机器人用户名。",
    ),
    choice(
      "groupTriggerMode",
      "Group trigger",
      "群聊触发",
      "How group chats wake the bot.",
      "群聊如何唤醒机器人。",
      ["mention", "all", "off"],
    ),
    lines(
      "allowedChatIds",
      "Allowed chats",
      "允许的会话",
      "Chat id allowlist.",
      "会话 ID 白名单。",
    ),
    lines(
      "allowedUserIds",
      "Allowed users",
      "允许的用户",
      "User id allowlist.",
      "用户 ID 白名单。",
    ),
    bool(
      "acceptEditedMessages",
      "Accept edited messages",
      "接收已编辑消息",
      "Deliver edited messages as new inbound turns.",
      "把已编辑的消息当作新的入站消息。",
    ),
    choice(
      "inboundDeliveryMode",
      "Inbound delivery",
      "入站投递",
      "How inbound messages enter the agent session.",
      "入站消息如何进入 Agent 会话。",
      ["queue", "steer"],
    ),
    bool(
      "includeContextMarker",
      "Include context marker",
      "附带上下文标记",
      "Attach a context marker on outbound messages.",
      "出站消息附带上下文标记。",
    ),
  ],
};

const discord: PlatformDefinition = {
  id: "discord",
  label: { en: "Discord", zh: "Discord" },
  description: {
    en: "Discord bot token, application public key, or both. A bot token connects the gateway on start unless gateway is turned off.",
    zh: "Discord 机器人令牌、应用公钥，或两者。填写机器人令牌后，除非关闭网关，启动时会连接 Gateway。",
  },
  fields: [
    secret(
      "botToken",
      "Bot token",
      "机器人令牌",
      "Bot token used for REST and the gateway.",
      "用于 REST 与 Gateway 的机器人令牌。",
    ),
    text(
      "publicKey",
      "Public key",
      "应用公钥",
      "Application public key (hex) for interaction webhooks.",
      "用于互动回调验签的应用公钥（十六进制）。",
    ),
    text(
      "botUserId",
      "Bot user ID",
      "机器人用户 ID",
      "Known bot user snowflake.",
      "已知的机器人用户 Snowflake。",
    ),
    bool(
      "enableGateway",
      "Enable gateway",
      "启用 Gateway",
      "Connect to the Discord gateway on start. Requires a bot token.",
      "启动时连接 Discord Gateway。需要机器人令牌。",
    ),
    text(
      "gatewayUrl",
      "Gateway URL",
      "Gateway 地址",
      "Explicit gateway WebSocket URL.",
      "显式的 Gateway WebSocket 地址。",
    ),
    text(
      "apiBaseUrl",
      "API base URL",
      "API 基址",
      "Discord REST API base URL.",
      "Discord REST API 基址。",
    ),
    bool(
      "ignoreBotMessages",
      "Ignore bot messages",
      "忽略机器人消息",
      "Drop messages sent by other bots and webhooks.",
      "丢弃其他机器人和 Webhook 发送的消息。",
    ),
    bool(
      "requireMentionInGuild",
      "Require mention in servers",
      "服务器中必须 @",
      "Guild messages must mention or reply to the bot.",
      "服务器消息必须 @ 或回复机器人。",
    ),
    bool(
      "autoCreateThreadOnMention",
      "Create a thread on mention",
      "@ 时创建帖子",
      "Create a public thread when the bot is mentioned in a guild channel.",
      "在服务器频道被 @ 时创建公开帖子。",
    ),
    choice(
      "autoArchiveDurationMinutes",
      "Thread auto-archive",
      "帖子自动归档",
      "Auto-archive duration in minutes for threads created on mention.",
      "因 @ 创建的帖子的自动归档时间（分钟）。",
      ["60", "1440", "4320", "10080"],
    ),
    bool(
      "includeContextMarker",
      "Include context marker",
      "附带上下文标记",
      "Attach a context marker on outbound messages.",
      "出站消息附带上下文标记。",
    ),
  ],
};

const whatsapp: PlatformDefinition = {
  id: "whatsapp",
  label: { en: "WhatsApp", zh: "WhatsApp" },
  description: {
    en: "WhatsApp Cloud API. Access token and phone number ID are required.",
    zh: "WhatsApp Cloud API。需要 Access Token 与 Phone Number ID。",
  },
  fields: [
    secret(
      "accessToken",
      "Access token",
      "Access Token",
      "Cloud API access token.",
      "Cloud API 访问令牌。",
    ),
    text(
      "phoneNumberId",
      "Phone number ID",
      "Phone Number ID",
      "WhatsApp phone number ID.",
      "WhatsApp 电话号码 ID。",
    ),
    text(
      "businessPhoneNumber",
      "Business phone number",
      "业务电话号码",
      "Display phone number for the business account.",
      "业务账号展示用的电话号码。",
    ),
    secret(
      "verifyToken",
      "Verify token",
      "Verify Token",
      "Token checked on the webhook verification challenge.",
      "Webhook 验证挑战使用的 Verify Token。",
    ),
    secret(
      "appSecret",
      "App secret",
      "App Secret",
      "Meta app secret used to verify webhook signatures.",
      "用于校验 Webhook 签名的 Meta App Secret。",
    ),
    bool(
      "allowUnsignedWebhooks",
      "Allow unsigned webhooks",
      "允许未签名的 Webhook",
      "Accept webhooks that do not include an app secret signature.",
      "接受没有 App Secret 签名的 Webhook。",
    ),
    text("apiBaseUrl", "API base URL", "API 基址", "Graph API base URL.", "Graph API 基址。"),
    text(
      "apiVersion",
      "API version",
      "API 版本",
      "Graph API version segment, such as v21.0.",
      "Graph API 版本，例如 v21.0。",
    ),
    lines(
      "allowedSenders",
      "Allowed senders",
      "允许的发送者",
      "Sender phone-number allowlist.",
      "发送者电话号码白名单。",
    ),
  ],
};

export const PLATFORM_BY_ID: Record<PlatformId, PlatformDefinition> = {
  feishu,
  weixin,
  dingtalk,
  wecom,
  qq,
  slack,
  telegram,
  discord,
  whatsapp,
};

export const PLATFORM_CATALOG: readonly PlatformDefinition[] = PLATFORM_IDS.map(
  (id) => PLATFORM_BY_ID[id],
);

export function textOf(copy: LocalizedText, locale: "en" | "zh"): string {
  return locale === "zh" ? copy.zh : copy.en;
}

export function fieldIsVisible(
  platformId: PlatformId,
  platformField: PlatformField,
  record: PlatformRecord | undefined,
): boolean {
  if (platformField.modes === undefined) return true;
  return platformField.modes.includes(visibleMode(platformId, record));
}

function storedChoice(record: PlatformRecord, key: string): string {
  const current = getPath(record, key);
  return typeof current === "string" ? current.trim() : "";
}

function defaultWouldDropStoredFields(
  platformId: PlatformId,
  record: PlatformRecord,
  choice: string,
): boolean {
  for (const field of PLATFORM_BY_ID[platformId].fields) {
    if (field.modes === undefined || field.modes.includes(choice)) continue;
    if (getPath(record, field.key) !== undefined) return true;
  }
  return false;
}

function recordWithDisplayedDefaults(
  platformId: PlatformId,
  record: PlatformRecord,
): PlatformRecord {
  let next = record;
  for (const field of PLATFORM_BY_ID[platformId].fields) {
    if (field.kind !== "enum" || field.defaultChoice === undefined) continue;
    if (storedChoice(next, field.key).length > 0) continue;
    if (
      field.key === "mode" &&
      defaultWouldDropStoredFields(platformId, next, field.defaultChoice)
    ) {
      continue;
    }
    next = setPath(next, field.key, field.defaultChoice);
  }
  return next;
}

/** Writes each visible enum default into a record that does not already store another form. */
export function platformsWithDisplayedDefaults(platforms: PlatformsConfig): PlatformsConfig {
  const next: PlatformsConfig = {};
  for (const id of PLATFORM_IDS) {
    const record = platforms[id];
    if (!isRecord(record)) continue;
    next[id] = recordWithDisplayedDefaults(id, record);
  }
  return next;
}

function visibleMode(platformId: PlatformId, record: PlatformRecord | undefined): string {
  const rawMode = record?.mode;
  if (typeof rawMode === "string" && rawMode.trim() !== "") return rawMode.trim();
  const modeField = PLATFORM_BY_ID[platformId].fields.find((field) => field.key === "mode");
  if (modeField?.defaultChoice !== undefined) return modeField.defaultChoice;
  return platformId === "weixin" ? "official-account" : "";
}
