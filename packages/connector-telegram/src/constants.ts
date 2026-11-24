/**
 * Telegram Bot API protocol constants and connector defaults.
 *
 * @see https://core.telegram.org/bots/api
 */

export const DEFAULT_TELEGRAM_CONNECTOR_NAME = "telegram" as const;

/**
 * Long-polling observations written through the host `ConnectorLogger`.
 *
 * @see https://core.telegram.org/bots/api#getting-updates
 */
export const TELEGRAM_LOG_HANDSHAKE_FAILED = "Telegram getUpdates handshake failed" as const;
export const DEFAULT_TELEGRAM_DISPLAY_NAME = "Telegram" as const;
export const DEFAULT_TELEGRAM_DESCRIPTION =
  "Send and receive Telegram messages via the official Telegram Bot API." as const;

/**
 * Default Telegram Bot API HTTPS base URL (`https://api.telegram.org/bot<token>/<method>`).
 *
 * @see https://core.telegram.org/bots/api#making-requests
 */
export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org" as const;

/**
 * Lowercase HTTP header carrying the secret token configured via `setWebhook(secret_token)`.
 *
 * @see https://core.telegram.org/bots/api#setwebhook
 */
export const TELEGRAM_WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token" as const;

/**
 * Allowed length bounds for Telegram `setWebhook` `secret_token` (`1..256` chars, `[A-Za-z0-9_-]`).
 *
 * @see https://core.telegram.org/bots/api#setwebhook
 */
export const TELEGRAM_SECRET_TOKEN_MIN_LENGTH = 1 as const;
export const TELEGRAM_SECRET_TOKEN_MAX_LENGTH = 256 as const;
export const TELEGRAM_SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Maximum UTF-16 code-unit length accepted by Telegram `sendMessage`, `editMessageText`,
 * and `sendMessageDraft` (`1..4096` for messages, `0..4096` for drafts).
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 * @see https://core.telegram.org/bots/api#editmessagetext
 * @see https://core.telegram.org/bots/api#sendmessagedraft
 */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096 as const;

/**
 * Default HTTP timeout for standard Telegram Bot API calls (`15s`).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000 as const;

/**
 * Default `getUpdates` long-polling timeout in seconds (`25s`) and batch limit (`100`).
 *
 * @see https://core.telegram.org/bots/api#getupdates
 */
export const DEFAULT_POLL_TIMEOUT_SECONDS = 25 as const;
export const DEFAULT_POLL_LIMIT = 100 as const;
export const MIN_POLL_LIMIT = 1 as const;
export const MAX_POLL_LIMIT = 100 as const;
export const POLL_HTTP_TIMEOUT_BUFFER_MS = 10_000 as const;
export const MIN_POLL_HTTP_TIMEOUT_MS = 10_000 as const;

/**
 * Backoff and retry bounds for `getUpdates` polling and `429 Too Many Requests` `retry_after`.
 *
 * @see https://core.telegram.org/bots/api#responseparameters
 */
export const DEFAULT_POLL_RETRY_BASE_MS = 1_000 as const;
export const DEFAULT_POLL_RETRY_MAX_MS = 30_000 as const;
export const DEFAULT_MAX_SEND_RETRIES = 3 as const;
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000 as const;
export const MS_PER_SECOND = 1_000 as const;

/**
 * Default `allowed_updates` subscribed during `getUpdates` long polling.
 *
 * @see https://core.telegram.org/bots/api#update
 * @see https://core.telegram.org/bots/api#getupdates
 */
export const DEFAULT_ALLOWED_UPDATES = ["message"] as const;

/**
 * Structured `ConnectorContextId` prefixes for Telegram conversation topologies.
 */
export const TELEGRAM_CONTEXT_PREFIX_P2P = "p2p" as const;
export const TELEGRAM_CONTEXT_PREFIX_DIRECT = "direct" as const;
export const TELEGRAM_CONTEXT_PREFIX_GROUP = "group" as const;
export const TELEGRAM_CONTEXT_PREFIX_SUPERGROUP = "supergroup" as const;
export const TELEGRAM_CONTEXT_PREFIX_CHANNEL = "channel" as const;
export const TELEGRAM_CONTEXT_SEGMENT_DELIMITER = ":" as const;

/**
 * Telegram public `@username` handle pattern (`@` + 4..64 `[A-Za-z0-9_]`, starting with a letter).
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 */
export const TELEGRAM_USERNAME_HANDLE_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{3,63}$/;
export const TELEGRAM_NUMERIC_ID_PATTERN = /^-?\d{1,20}$/;

/**
 * UTF-16 surrogate code-unit bounds used to avoid splitting surrogate pairs across chunks.
 */
export const UTF16_HIGH_SURROGATE_MIN = 0xd800 as const;
export const UTF16_HIGH_SURROGATE_MAX = 0xdbff as const;
export const UTF16_LOW_SURROGATE_MIN = 0xdc00 as const;
export const UTF16_LOW_SURROGATE_MAX = 0xdfff as const;

/**
 * HTTP status codes and headers used by the webhook receiver and API client.
 */
export const HTTP_STATUS_OK = 200 as const;
export const HTTP_STATUS_BAD_REQUEST = 400 as const;
export const HTTP_STATUS_UNAUTHORIZED = 401 as const;
export const HTTP_STATUS_FORBIDDEN = 403 as const;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429 as const;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500 as const;

export const CONTENT_TYPE_APPLICATION_JSON = "application/json; charset=utf-8" as const;
export const HEADER_CONTENT_TYPE = "content-type" as const;
export const HEADER_ALLOW = "allow" as const;
