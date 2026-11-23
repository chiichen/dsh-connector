/**
 * Official QQ Bot Open Platform protocol constants.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/opcode.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 */

export const QQ_CONNECTOR_VERSION = "0.1.0" as const;

export const QQ_DEFAULT_CONNECTOR_NAME = "qq" as const;
export const QQ_DEFAULT_DISPLAY_NAME = "QQ Official Bot" as const;
export const QQ_DEFAULT_DESCRIPTION =
  "Send and receive QQ C2C, group, and guild channel messages via the official QQ Bot Open Platform" as const;

/**
 * Dynamic access token endpoint (`POST`, JSON `{ appId, clientSecret }`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 */
export const QQ_DEFAULT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken" as const;

/**
 * Unified 2026 domain access token endpoint (`POST`, JSON `{ appId, clientSecret }`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 */
export const QQ_UNIFIED_TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken" as const;

/**
 * Official OpenAPI production base URL (`api.sgroup.qq.com`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
 */
export const QQ_DEFAULT_API_BASE_URL = "https://api.sgroup.qq.com" as const;

/**
 * Official OpenAPI sandbox base URL (`sandbox.api.sgroup.qq.com`).
 */
export const QQ_SANDBOX_API_BASE_URL = "https://sandbox.api.sgroup.qq.com" as const;

/**
 * Unified 2026 OpenAPI base URL (`api.bot.qq.com`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
 */
export const QQ_UNIFIED_API_BASE_URL = "https://api.bot.qq.com" as const;

/**
 * Authorization header scheme (`Authorization: QQBot <access_token>`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 */
export const QQ_AUTH_SCHEME = "QQBot" as const;

/**
 * Gateway endpoint discovery route (`GET /gateway`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 */
export const QQ_GATEWAY_PATH = "/gateway" as const;

/**
 * Token refresh lead buffer (60 seconds before expiry, per official documentation).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 */
export const QQ_TOKEN_REFRESH_BUFFER_MS = 60_000 as const;

/**
 * Default token TTL fallback in seconds when `expires_in` is omitted (7200s = 2 hours).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 */
export const QQ_DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 7_200 as const;

export const QQ_MS_PER_SECOND = 1_000 as const;
export const QQ_DEFAULT_REQUEST_TIMEOUT_MS = 15_000 as const;

/**
 * Gateway & Webhook OpCodes.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/opcode.html
 */
export const QQ_OPCODE_DISPATCH = 0 as const;
export const QQ_OPCODE_HEARTBEAT = 1 as const;
export const QQ_OPCODE_IDENTIFY = 2 as const;
export const QQ_OPCODE_RESUME = 6 as const;
export const QQ_OPCODE_RECONNECT = 7 as const;
export const QQ_OPCODE_INVALID_SESSION = 9 as const;
export const QQ_OPCODE_HELLO = 10 as const;
export const QQ_OPCODE_HEARTBEAT_ACK = 11 as const;
export const QQ_OPCODE_HTTP_CALLBACK_ACK = 12 as const;
export const QQ_OPCODE_CALLBACK_VALIDATION = 13 as const;

/**
 * Gateway Intents bitmasks.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 */
export const QQ_INTENT_GUILDS = 1 << 0;
export const QQ_INTENT_GUILD_MEMBERS = 1 << 1;
export const QQ_INTENT_GUILD_MESSAGES = 1 << 9;
export const QQ_INTENT_DIRECT_MESSAGE = 1 << 12;
export const QQ_INTENT_GROUP_AND_C2C_EVENT = 1 << 25;
export const QQ_INTENT_INTERACTION = 1 << 26;
export const QQ_INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;

/**
 * Default subscribed intents covering C2C + Group @bot + Public Guild @bot messages.
 */
export const QQ_DEFAULT_INTENTS = QQ_INTENT_GROUP_AND_C2C_EVENT | QQ_INTENT_PUBLIC_GUILD_MESSAGES;

export const QQ_DEFAULT_SHARD: readonly [number, number] = [0, 1] as const;

/**
 * Gateway & Webhook event names.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/event.html
 */
export const QQ_EVENT_READY = "READY" as const;
export const QQ_EVENT_RESUMED = "RESUMED" as const;
export const QQ_EVENT_C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE" as const;
export const QQ_EVENT_GROUP_AT_MESSAGE_CREATE = "GROUP_AT_MESSAGE_CREATE" as const;
export const QQ_EVENT_AT_MESSAGE_CREATE = "AT_MESSAGE_CREATE" as const;

/**
 * Outbound v2 `msg_type` values.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
 */
export const QQ_MSG_TYPE_TEXT = 0 as const;
export const QQ_MSG_TYPE_MARKDOWN = 2 as const;
export const QQ_MSG_TYPE_INPUT_NOTIFY = 6 as const;
export const QQ_MSG_TYPE_RICH_MEDIA = 7 as const;
export const QQ_MSG_TYPE_CARD = 8 as const;

/**
 * Inbound `message_type` values.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
 */
export const QQ_INBOUND_MESSAGE_TYPE_QUOTE = 103 as const;

/**
 * Rich media `file_type` values.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
 */
export const QQ_FILE_TYPE_IMAGE = 1 as const;
export const QQ_FILE_TYPE_VIDEO = 2 as const;
export const QQ_FILE_TYPE_VOICE = 3 as const;
export const QQ_FILE_TYPE_FILE = 4 as const;

/**
 * C2C streaming `input_state` values (`POST /v2/users/{user_openid}/stream_messages`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
 */
export const QQ_STREAM_INPUT_STATE_GENERATING = 1 as const;
export const QQ_STREAM_INPUT_STATE_COMPLETED = 10 as const;

/**
 * Passive reply window and per-`msg_id` limits from official documentation.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 */
export const QQ_C2C_PASSIVE_TTL_MS = 60 * 60 * 1_000;
export const QQ_GROUP_PASSIVE_TTL_MS = 60 * 60 * 1_000;
export const QQ_CHANNEL_PASSIVE_TTL_MS = 5 * 60 * 1_000;
export const QQ_C2C_PASSIVE_MAX_REPLIES = 4 as const;
export const QQ_GROUP_PASSIVE_MAX_REPLIES = 5 as const;
export const QQ_INITIAL_MSG_SEQ = 1 as const;
export const QQ_MAX_TRACKED_PASSIVE_TARGETS = 1_024 as const;
export const QQ_MAX_TRACKED_MSG_SEQS = 2_048 as const;

/**
 * Business error codes documented by QQ Bot Open Platform.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 */
export const QQ_ERR_CODE_RATE_LIMITED = 100_001 as const;
export const QQ_ERR_CODE_BOT_NOT_FOUND = 10_004 as const;
export const QQ_ERR_CODE_APPID_INVALID = 100_007 as const;
export const QQ_ERR_CODE_INVALID_SECRET = 100_016 as const;
export const QQ_ERR_CODE_MARKDOWN_NOT_ALLOWED = 40_034_090 as const;
export const QQ_ERR_CODE_DUPLICATE_MSG_SEQ = 40_054_005 as const;
export const QQ_ERR_CODE_AUDIT_PENDING_PUSH = 304_023 as const;
export const QQ_ERR_CODE_AUDIT_PENDING_REPLY = 304_024 as const;

/**
 * HTTP status code constants.
 */
export const HTTP_STATUS_OK = 200 as const;
export const HTTP_STATUS_BAD_REQUEST = 400 as const;
export const HTTP_STATUS_UNAUTHORIZED = 401 as const;
export const HTTP_STATUS_FORBIDDEN = 403 as const;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429 as const;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500 as const;

/**
 * Webhook Ed25519 signature headers & DER constants.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html
 */
export const QQ_HEADER_SIGNATURE_ED25519 = "x-signature-ed25519" as const;
export const QQ_HEADER_SIGNATURE_TIMESTAMP = "x-signature-timestamp" as const;
export const QQ_HEADER_BOT_APPID = "x-bot-appid" as const;
export const ED25519_SEED_BYTE_LENGTH = 32 as const;
export const ED25519_SIGNATURE_BYTE_LENGTH = 64 as const;
export const ED25519_HIGH_BITS_MASK = 0xe0 as const;
export const ED25519_PKCS8_DER_PREFIX_HEX = "302e020100300506032b657004220420" as const;

/**
 * WebSocket Gateway close codes & reconnect defaults.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 */
export const QQ_WS_CLOSE_NORMAL = 1000 as const;
export const QQ_WS_CLOSE_AUTH_FAILED = 4004 as const;
export const QQ_WS_CLOSE_INVALID_SESSION = 4006 as const;
export const QQ_WS_CLOSE_INVALID_SEQ = 4007 as const;
export const QQ_WS_CLOSE_RATE_LIMITED = 4008 as const;
export const QQ_WS_CLOSE_SESSION_EXPIRED = 4009 as const;
export const QQ_WS_CLOSE_INVALID_SHARD = 4010 as const;
export const QQ_WS_CLOSE_SHARDING_REQUIRED = 4011 as const;
export const QQ_WS_CLOSE_INVALID_VERSION = 4012 as const;
export const QQ_WS_CLOSE_INVALID_INTENTS = 4013 as const;
export const QQ_WS_CLOSE_DISALLOWED_INTENTS = 4014 as const;
export const QQ_WS_CLOSE_BOT_OFFLINE_SANDBOX_ONLY = 4914 as const;
export const QQ_WS_CLOSE_BOT_BANNED = 4915 as const;

export const QQ_WS_FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4001,
  4002,
  QQ_WS_CLOSE_AUTH_FAILED,
  QQ_WS_CLOSE_INVALID_SHARD,
  QQ_WS_CLOSE_SHARDING_REQUIRED,
  QQ_WS_CLOSE_INVALID_VERSION,
  QQ_WS_CLOSE_INVALID_INTENTS,
  QQ_WS_CLOSE_DISALLOWED_INTENTS,
  QQ_WS_CLOSE_BOT_OFFLINE_SANDBOX_ONLY,
  QQ_WS_CLOSE_BOT_BANNED,
]);

export const QQ_DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
] as const;

export const QQ_CONTEXT_PREFIX_C2C = "c2c:" as const;
export const QQ_CONTEXT_PREFIX_GROUP = "group:" as const;
export const QQ_CONTEXT_PREFIX_CHANNEL = "channel:" as const;
