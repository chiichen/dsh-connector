/**
 * Official Discord API v10 protocol constants, bitmasks, opcodes, and limits.
 *
 * @see https://discord.com/developers/docs/reference
 * @see https://discord.com/developers/docs/events/gateway
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes
 * @see https://discord.com/developers/docs/interactions/overview
 * @see https://discord.com/developers/docs/resources/message
 * @see https://discord.com/developers/docs/resources/channel
 */

export const DISCORD_CONNECTOR_DEFAULT_NAME = "discord" as const;
export const DISCORD_CONNECTOR_VERSION = "0.1.0" as const;

/**
 * Discord API v10 version & base URL.
 * @see https://discord.com/developers/docs/reference#api-versioning
 */
export const DISCORD_API_VERSION = 10 as const;
export const DISCORD_API_VERSION_STRING = "10" as const;
export const DISCORD_DEFAULT_API_BASE_URL = "https://discord.com/api/v10/" as const;

/**
 * Required Discord Bot HTTP User-Agent format: `DiscordBot ($url, $versionNumber)`.
 * @see https://discord.com/developers/docs/reference#user-agent
 */
export const DISCORD_DEFAULT_USER_AGENT =
  `DiscordBot (https://github.com/chiichen/dsh-connector, ${DISCORD_CONNECTOR_VERSION})` as const;

/**
 * Gateway connection query parameters and library property identifier.
 * @see https://discord.com/developers/docs/events/gateway#connecting
 * @see https://discord.com/developers/docs/events/gateway-events#identify-identify-connection-properties
 */
export const DISCORD_GATEWAY_ENCODING_JSON = "json" as const;
export const DISCORD_GATEWAY_LIBRARY_NAME = "@dsh-connector/connector-discord" as const;
export const DISCORD_WSS_PROTOCOL = "wss:" as const;

/**
 * Maximum `content` length per Discord message (`POST /channels/{channel.id}/messages`).
 * @see https://discord.com/developers/docs/resources/message#create-message-jsonform-params
 */
export const DISCORD_MAX_MESSAGE_LENGTH = 2000 as const;

/**
 * Thread channel `name` length bounds (`POST /channels/{channel.id}/messages/{message.id}/threads`).
 * @see https://discord.com/developers/docs/resources/channel#start-thread-from-message-json-params
 */
export const DISCORD_MAX_THREAD_NAME_LENGTH = 100 as const;
export const DISCORD_DEFAULT_THREAD_NAME = "DeepSeek Harness" as const;

/**
 * Snowflake decimal string length bounds (uint64 decimal representation).
 * @see https://discord.com/developers/docs/reference#snowflakes
 */
export const DISCORD_MIN_SNOWFLAKE_LENGTH = 1 as const;
export const DISCORD_MAX_SNOWFLAKE_LENGTH = 30 as const;

/**
 * Default HTTP & Gateway timeouts and rate-limit / reconnect bounds.
 */
export const DISCORD_DEFAULT_HTTP_TIMEOUT_MS = 15_000 as const;
export const DISCORD_DEFAULT_GATEWAY_CONNECT_TIMEOUT_MS = 20_000 as const;
export const DISCORD_MIN_HEARTBEAT_INTERVAL_MS = 1_000 as const;
export const DISCORD_MIN_RATE_LIMIT_DELAY_MS = 50 as const;
export const DISCORD_MAX_RATE_LIMIT_DELAY_MS = 10_000 as const;
export const DISCORD_DEFAULT_RATE_LIMIT_DELAY_MS = 1_000 as const;
export const DISCORD_SECONDS_TO_MS = 1_000 as const;
export const DISCORD_GATEWAY_RECONNECT_DELAYS_MS: readonly number[] = Object.freeze([
  1_000, 3_000, 5_000, 10_000, 30_000,
]);

/**
 * Typing indicator expiry and recommended keepalive interval (`POST /channels/{channel.id}/typing`).
 * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
 */
export const DISCORD_TYPING_INDICATOR_TTL_MS = 10_000 as const;
export const DISCORD_DEFAULT_TYPING_KEEPALIVE_MS = 8_000 as const;
export const DISCORD_DEFAULT_STREAM_EDIT_THROTTLE_MS = 1_000 as const;

/**
 * Gateway v10 opcodes.
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-opcodes
 */
export const DISCORD_GATEWAY_OPCODES = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const);

/**
 * Gateway Dispatch (`op: 0`) event names handled by the connector.
 * @see https://discord.com/developers/docs/events/gateway-events#receive-events
 */
export const DISCORD_GATEWAY_EVENTS = Object.freeze({
  READY: "READY",
  RESUMED: "RESUMED",
  GUILD_CREATE: "GUILD_CREATE",
  CHANNEL_CREATE: "CHANNEL_CREATE",
  CHANNEL_UPDATE: "CHANNEL_UPDATE",
  CHANNEL_DELETE: "CHANNEL_DELETE",
  THREAD_CREATE: "THREAD_CREATE",
  THREAD_UPDATE: "THREAD_UPDATE",
  THREAD_DELETE: "THREAD_DELETE",
  THREAD_LIST_SYNC: "THREAD_LIST_SYNC",
  MESSAGE_CREATE: "MESSAGE_CREATE",
} as const);

/**
 * Gateway Intents bitflags.
 * @see https://discord.com/developers/docs/events/gateway#list-of-intents
 */
export const DISCORD_GATEWAY_INTENTS = Object.freeze({
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EXPRESSIONS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16,
  AUTO_MODERATION_CONFIGURATION: 1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21,
  GUILD_MESSAGE_POLLS: 1 << 24,
  DIRECT_MESSAGE_POLLS: 1 << 25,
} as const);

/**
 * Default Intents bitmask enabling guild channel metadata, guild messages, direct messages,
 * and message content (`GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT`).
 * @see https://discord.com/developers/docs/events/gateway#gateway-intents
 */
export const DISCORD_DEFAULT_INTENTS: number =
  DISCORD_GATEWAY_INTENTS.GUILDS |
  DISCORD_GATEWAY_INTENTS.GUILD_MESSAGES |
  DISCORD_GATEWAY_INTENTS.DIRECT_MESSAGES |
  DISCORD_GATEWAY_INTENTS.MESSAGE_CONTENT;

/**
 * WebSocket & Discord Gateway close event codes.
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes
 */
export const DISCORD_WS_NORMAL_CLOSE_CODE = 1000 as const;
export const DISCORD_WS_RESUMABLE_RESTART_CLOSE_CODE = 4000 as const;

export const DISCORD_GATEWAY_CLOSE_CODES = Object.freeze({
  UNKNOWN_ERROR: 4000,
  UNKNOWN_OPCODE: 4001,
  DECODE_ERROR: 4002,
  NOT_AUTHENTICATED: 4003,
  AUTHENTICATION_FAILED: 4004,
  ALREADY_AUTHENTICATED: 4005,
  INVALID_SEQ: 4007,
  RATE_LIMITED: 4008,
  SESSION_TIMED_OUT: 4009,
  INVALID_SHARD: 4010,
  SHARDING_REQUIRED: 4011,
  INVALID_API_VERSION: 4012,
  INVALID_INTENTS: 4013,
  DISALLOWED_INTENTS: 4014,
} as const);

/**
 * Close codes where Discord explicitly specifies `Reconnect: false`.
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes
 */
export const DISCORD_FATAL_CLOSE_CODES: ReadonlySet<number> = new Set<number>([
  DISCORD_GATEWAY_CLOSE_CODES.AUTHENTICATION_FAILED,
  DISCORD_GATEWAY_CLOSE_CODES.INVALID_SHARD,
  DISCORD_GATEWAY_CLOSE_CODES.SHARDING_REQUIRED,
  DISCORD_GATEWAY_CLOSE_CODES.INVALID_API_VERSION,
  DISCORD_GATEWAY_CLOSE_CODES.INVALID_INTENTS,
  DISCORD_GATEWAY_CLOSE_CODES.DISALLOWED_INTENTS,
]);

/**
 * Close codes where reconnection is allowed, but the previous Gateway session cannot be resumed.
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes
 */
export const DISCORD_SESSION_RESET_CLOSE_CODES: ReadonlySet<number> = new Set<number>([
  DISCORD_GATEWAY_CLOSE_CODES.NOT_AUTHENTICATED,
  DISCORD_GATEWAY_CLOSE_CODES.INVALID_SEQ,
  DISCORD_GATEWAY_CLOSE_CODES.SESSION_TIMED_OUT,
]);

/**
 * Discord Channel Types.
 * @see https://discord.com/developers/docs/resources/channel#channel-object-channel-types
 */
export const DISCORD_CHANNEL_TYPES = Object.freeze({
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_DIRECTORY: 14,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const);

export const DISCORD_DIRECT_CHANNEL_TYPES: ReadonlySet<number> = new Set<number>([
  DISCORD_CHANNEL_TYPES.DM,
  DISCORD_CHANNEL_TYPES.GROUP_DM,
]);

export const DISCORD_THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set<number>([
  DISCORD_CHANNEL_TYPES.ANNOUNCEMENT_THREAD,
  DISCORD_CHANNEL_TYPES.PUBLIC_THREAD,
  DISCORD_CHANNEL_TYPES.PRIVATE_THREAD,
]);

export const DISCORD_THREAD_STARTABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set<number>([
  DISCORD_CHANNEL_TYPES.GUILD_TEXT,
  DISCORD_CHANNEL_TYPES.GUILD_ANNOUNCEMENT,
]);

/**
 * Discord Message Types accepted as user-authored inbound messages.
 * @see https://discord.com/developers/docs/resources/message#message-object-message-types
 */
export const DISCORD_MESSAGE_TYPES = Object.freeze({
  DEFAULT: 0,
  THREAD_CREATED: 18,
  REPLY: 19,
  CHAT_INPUT_COMMAND: 20,
  THREAD_STARTER_MESSAGE: 21,
  CONTEXT_MENU_COMMAND: 23,
} as const);

export const DISCORD_USER_MESSAGE_TYPES: ReadonlySet<number> = new Set<number>([
  DISCORD_MESSAGE_TYPES.DEFAULT,
  DISCORD_MESSAGE_TYPES.REPLY,
  DISCORD_MESSAGE_TYPES.CHAT_INPUT_COMMAND,
  DISCORD_MESSAGE_TYPES.CONTEXT_MENU_COMMAND,
]);

/**
 * Discord Interactions HTTP Webhook headers, types, callback types, and Ed25519 key/signature sizes.
 * @see https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding
 */
export const DISCORD_SIGNATURE_HEADER = "x-signature-ed25519" as const;
export const DISCORD_TIMESTAMP_HEADER = "x-signature-timestamp" as const;
export const DISCORD_ED25519_PUBLIC_KEY_HEX_LENGTH = 64 as const;
export const DISCORD_ED25519_SIGNATURE_HEX_LENGTH = 128 as const;

export const DISCORD_INTERACTION_TYPES = Object.freeze({
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const);

export const DISCORD_INTERACTION_CALLBACK_TYPES = Object.freeze({
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const);

/**
 * HTTP status codes and JSON error codes used by Discord REST & Interactions endpoints.
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#http
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
 */
export const HTTP_STATUS_OK = 200 as const;
export const HTTP_STATUS_ACCEPTED = 202 as const;
export const HTTP_STATUS_NO_CONTENT = 204 as const;
export const HTTP_STATUS_BAD_REQUEST = 400 as const;
export const HTTP_STATUS_UNAUTHORIZED = 401 as const;
export const HTTP_STATUS_FORBIDDEN = 403 as const;
export const HTTP_STATUS_NOT_FOUND = 404 as const;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429 as const;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500 as const;

export const DISCORD_CHANNEL_CACHE_MAX_SIZE = 2048 as const;

export const DISCORD_GATEWAY_IDENTIFY_PROPERTIES = Object.freeze({
  os: "linux",
  browser: DISCORD_GATEWAY_LIBRARY_NAME,
  device: DISCORD_GATEWAY_LIBRARY_NAME,
} as const);

export const DISCORD_JSON_AUTH_ERROR_CODES: ReadonlySet<number> = new Set<number>([
  40001, // Unauthorized. Provide a valid token and try again
  50014, // Invalid authentication token provided
]);

/**
 * Structured `ConnectorContextId` prefixes and idempotency key prefixes.
 */
export const DISCORD_CONTEXT_PREFIX_DM = "dm" as const;
export const DISCORD_CONTEXT_PREFIX_USER = "user" as const;
export const DISCORD_CONTEXT_PREFIX_CHANNEL = "channel" as const;
export const DISCORD_CONTEXT_PREFIX_THREAD = "thread" as const;
export const DISCORD_IDEMPOTENCY_PREFIX_MESSAGE = "discord:msg:" as const;
export const DISCORD_IDEMPOTENCY_PREFIX_INTERACTION = "discord:interaction:" as const;

/**
 * WebSocket readyState numeric constants per WHATWG / RFC 6455.
 */
export const WS_READY_STATE_CONNECTING = 0 as const;
export const WS_READY_STATE_OPEN = 1 as const;
export const WS_READY_STATE_CLOSING = 2 as const;
export const WS_READY_STATE_CLOSED = 3 as const;
