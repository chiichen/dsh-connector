/**
 * Enterprise WeChat (WeCom) official protocol constants.
 *
 * @see https://developer.work.weixin.qq.com/document/path/90930 Callback configuration
 * @see https://developer.work.weixin.qq.com/document/path/91144 Message encryption/decryption specification
 * @see https://developer.work.weixin.qq.com/document/path/91039 Access token acquisition (`gettoken`)
 * @see https://developer.work.weixin.qq.com/document/path/96458 Self-built app message sending (`cgi-bin/message/send`)
 * @see https://developer.work.weixin.qq.com/document/path/90248 App group chat message sending (`cgi-bin/appchat/send`)
 * @see https://developer.work.weixin.qq.com/document/path/99110 Group webhook bot message sending (`cgi-bin/webhook/send`)
 * @see https://developer.work.weixin.qq.com/document/path/100719 Intelligent bot HTTP callback message format
 * @see https://developer.work.weixin.qq.com/document/path/101031 Intelligent bot passive reply (`msgtype: "stream"`)
 * @see https://developer.work.weixin.qq.com/document/path/101138 Intelligent bot active reply (`response_url`)
 * @see https://developer.work.weixin.qq.com/document/path/101463 Intelligent bot WebSocket long connection
 */

export const DEFAULT_WECOM_CONNECTOR_NAME = "wecom" as const;
export const DEFAULT_WECOM_DISPLAY_NAME = "Enterprise WeChat (WeCom)" as const;
export const DEFAULT_WECOM_DESCRIPTION =
  "Send and receive Enterprise WeChat (WeCom) messages across self-built apps, group webhooks, and intelligent bots." as const;

export const DEFAULT_WECOM_API_BASE_URL = "https://qyapi.weixin.qq.com" as const;
export const DEFAULT_WECOM_AIBOT_WS_URL = "wss://openws.work.weixin.qq.com" as const;

export const WECOM_GETTOKEN_PATH = "/cgi-bin/gettoken" as const;
export const WECOM_APP_MESSAGE_SEND_PATH = "/cgi-bin/message/send" as const;
export const WECOM_APPCHAT_SEND_PATH = "/cgi-bin/appchat/send" as const;
export const WECOM_WEBHOOK_SEND_PATH = "/cgi-bin/webhook/send" as const;

/**
 * EncodingAESKey length fixed by WeCom specification (43 Base64 alphanumeric chars without `=`).
 * Decodes with trailing `=` into a 32-byte AES-256 key; IV is the first 16 bytes of AESKey.
 *
 * @see https://developer.work.weixin.qq.com/document/path/91144
 */
export const WECOM_ENCODING_AES_KEY_LENGTH = 43 as const;
export const WECOM_AES_KEY_BYTE_LENGTH = 32 as const;
export const WECOM_AES_IV_BYTE_LENGTH = 16 as const;
export const WECOM_AES_CIPHER_BLOCK_BYTE_LENGTH = 16 as const;
export const WECOM_PKCS7_BLOCK_BYTE_LENGTH = 32 as const;
export const WECOM_RANDOM_PREFIX_BYTE_LENGTH = 16 as const;
export const WECOM_MSG_LEN_HEADER_BYTE_LENGTH = 4 as const;
export const WECOM_ENVELOPE_HEADER_BYTE_LENGTH = 20 as const;
export const WECOM_AES_ALGORITHM = "aes-256-cbc" as const;
export const WECOM_SIGNATURE_ALGORITHM = "sha1" as const;

/**
 * UTF-8 payload byte ceilings enforced by official WeCom endpoints:
 * - Self-built app `text` / `markdown` & `appchat` `text` / `markdown`: 2048 bytes
 * - Group webhook `text`: 2048 bytes; `markdown` / `markdown_v2`: 4096 bytes
 * - Intelligent bot `markdown` / `stream.content`: 20480 bytes
 *
 * @see https://developer.work.weixin.qq.com/document/path/96458
 * @see https://developer.work.weixin.qq.com/document/path/99110
 * @see https://developer.work.weixin.qq.com/document/path/101031
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export const WECOM_APP_TEXT_MAX_BYTES = 2048 as const;
export const WECOM_WEBHOOK_TEXT_MAX_BYTES = 2048 as const;
export const WECOM_WEBHOOK_MARKDOWN_MAX_BYTES = 4096 as const;
export const WECOM_AIBOT_MARKDOWN_MAX_BYTES = 20480 as const;
export const MIN_UTF8_SPLIT_MAX_BYTES = 4 as const;

/**
 * Official WeCom access_token invalidation / expiration error codes that warrant a single refresh retry:
 * - `40001`: invalid credential / secret or invalidated access_token
 * - `40014`: invalid access_token
 * - `42001`: access_token expired
 *
 * @see https://developer.work.weixin.qq.com/document/path/91039
 * @see https://developer.work.weixin.qq.com/document/path/90930
 */
export const WECOM_ERRCODE_OK = 0 as const;
export const WECOM_ERRCODE_INVALID_CREDENTIAL = 40001 as const;
export const WECOM_ERRCODE_INVALID_TOKEN = 40014 as const;
export const WECOM_ERRCODE_EXPIRED_TOKEN = 42001 as const;
export const WECOM_TOKEN_INVALID_ERRCODES: ReadonlySet<number> = new Set([
  WECOM_ERRCODE_INVALID_CREDENTIAL,
  WECOM_ERRCODE_INVALID_TOKEN,
  WECOM_ERRCODE_EXPIRED_TOKEN,
]);

export const DEFAULT_WECOM_HTTP_TIMEOUT_MS = 15_000 as const;
export const DEFAULT_WECOM_TOKEN_REFRESH_BUFFER_SECONDS = 300 as const;
export const DEFAULT_WECOM_TOKEN_FALLBACK_TTL_SECONDS = 7200 as const;
export const SECONDS_TO_MS = 1000 as const;

/**
 * Intelligent Bot WebSocket long-connection commands and timing defaults.
 * - Heartbeat recommended interval: 30 seconds (`ping`)
 * - HTTP callback passive stream polling window: 6 minutes (`360_000` ms)
 * - WebSocket active stream update window: 10 minutes (`600_000` ms)
 * - `response_url` validity window: 1 hour (`3_600_000` ms)
 *
 * @see https://developer.work.weixin.qq.com/document/path/100719
 * @see https://developer.work.weixin.qq.com/document/path/101138
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export const WECOM_AIBOT_CMD_SUBSCRIBE = "aibot_subscribe" as const;
export const WECOM_AIBOT_CMD_PING = "ping" as const;
export const WECOM_AIBOT_CMD_MSG_CALLBACK = "aibot_msg_callback" as const;
export const WECOM_AIBOT_CMD_EVENT_CALLBACK = "aibot_event_callback" as const;
export const WECOM_AIBOT_CMD_RESPOND_WELCOME = "aibot_respond_welcome_msg" as const;
export const WECOM_AIBOT_CMD_RESPOND_MSG = "aibot_respond_msg" as const;
export const WECOM_AIBOT_CMD_RESPOND_UPDATE = "aibot_respond_update_msg" as const;
export const WECOM_AIBOT_CMD_SEND_MSG = "aibot_send_msg" as const;
export const WECOM_AIBOT_EVENT_DISCONNECTED = "disconnected_event" as const;

export const WECOM_AIBOT_CHAT_TYPE_SINGLE = 1 as const;
export const WECOM_AIBOT_CHAT_TYPE_GROUP = 2 as const;

export const DEFAULT_WECOM_WS_HEARTBEAT_INTERVAL_MS = 30_000 as const;
export const DEFAULT_WECOM_WS_REQUEST_TIMEOUT_MS = 10_000 as const;
export const DEFAULT_WECOM_WS_RECONNECT_INITIAL_DELAY_MS = 1_000 as const;
export const DEFAULT_WECOM_WS_RECONNECT_MAX_DELAY_MS = 30_000 as const;
export const WECOM_WS_RECONNECT_BACKOFF_FACTOR = 2 as const;

export const WECOM_HTTP_STREAM_WINDOW_MS = 360_000 as const;
export const WECOM_WS_STREAM_WINDOW_MS = 600_000 as const;
export const WECOM_RESPONSE_URL_TTL_MS = 3_600_000 as const;
export const DEFAULT_WECOM_RESPONSE_URL_CACHE_LIMIT = 256 as const;

export const WECOM_CONTEXT_PREFIX_APP_P2P = "app:p2p:" as const;
export const WECOM_CONTEXT_PREFIX_APP_GROUP = "app:group:" as const;
export const WECOM_CONTEXT_PREFIX_AIBOT_P2P = "aibot:p2p:" as const;
export const WECOM_CONTEXT_PREFIX_AIBOT_GROUP = "aibot:group:" as const;
export const WECOM_CONTEXT_PREFIX_WEBHOOK = "webhook:" as const;
export const GENERIC_CONTEXT_PREFIX_P2P = "p2p:" as const;
export const GENERIC_CONTEXT_PREFIX_GROUP = "group:" as const;

export const HTTP_STATUS_OK = 200 as const;
export const HTTP_STATUS_BAD_REQUEST = 400 as const;
export const HTTP_STATUS_UNAUTHORIZED = 401 as const;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503 as const;

export const CONTENT_TYPE_TEXT_PLAIN_UTF8 = "text/plain; charset=utf-8" as const;
export const CONTENT_TYPE_JSON_UTF8 = "application/json; charset=utf-8" as const;
export const CONTENT_TYPE_XML_UTF8 = "application/xml; charset=utf-8" as const;
