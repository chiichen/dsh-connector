/**
 * Named protocol constants for `@dsh-connector/connector-weixin`.
 *
 * @see https://developers.weixin.qq.com/doc/service/api/
 * @see https://developers.weixin.qq.com/doc/service/guide/dev/push/
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */

export const WEIXIN_CONNECTOR_VERSION = "0.1.0" as const;

export const DEFAULT_WEIXIN_CONNECTOR_NAME = "weixin" as const;
export const DEFAULT_WEIXIN_DISPLAY_NAME = "Weixin" as const;
export const DEFAULT_WEIXIN_DESCRIPTION =
  "Send and receive WeChat messages via Official Account / Customer Service API or iLink Bot protocol" as const;

export const WEIXIN_P2P_CONTEXT_PREFIX = "p2p:" as const;

/**
 * Official WeChat Official Account / Service Account API endpoints.
 *
 * @see https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html
 * @see https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken.html
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 * @see https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html
 */
export const WEIXIN_OFFICIAL_API_BASE_URL = "https://api.weixin.qq.com" as const;
export const WEIXIN_STABLE_TOKEN_PATH = "/cgi-bin/stable_token" as const;
export const WEIXIN_CLASSIC_TOKEN_PATH = "/cgi-bin/token" as const;
export const WEIXIN_CUSTOM_SEND_PATH = "/cgi-bin/message/custom/send" as const;
export const WEIXIN_CUSTOM_TYPING_PATH = "/cgi-bin/message/custom/typing" as const;
export const WEIXIN_GRANT_TYPE_CLIENT_CREDENTIAL = "client_credential" as const;

/**
 * WeChat iLink Bot long-polling protocol endpoints & headers.
 */
export const WEIXIN_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com/" as const;
export const WEIXIN_ILINK_NOTIFY_START_PATH = "ilink/bot/msg/notifystart" as const;
export const WEIXIN_ILINK_NOTIFY_STOP_PATH = "ilink/bot/msg/notifystop" as const;
export const WEIXIN_ILINK_GET_UPDATES_PATH = "ilink/bot/getupdates" as const;
export const WEIXIN_ILINK_SEND_MESSAGE_PATH = "ilink/bot/sendmessage" as const;
export const WEIXIN_ILINK_GET_CONFIG_PATH = "ilink/bot/getconfig" as const;
export const WEIXIN_ILINK_SEND_TYPING_PATH = "ilink/bot/sendtyping" as const;
export const WEIXIN_ILINK_PROTOCOL_VERSION = "2.4.6" as const;
export const WEIXIN_ILINK_APP_ID = "bot" as const;
export const WEIXIN_ILINK_CLIENT_VERSION = 132_102 as const; // (2 << 16) | (4 << 8) | 6
export const WEIXIN_ILINK_AUTH_TYPE = "ilink_bot_token" as const;
export const WEIXIN_ILINK_BOT_AGENT = "dsh-connector-weixin/0.1.0" as const;
export const WEIXIN_ILINK_CLIENT_ID_PREFIX = "dsh-weixin-" as const;

export const ILINK_MESSAGE_TYPE_USER = 1 as const;
export const ILINK_MESSAGE_TYPE_BOT = 2 as const;
export const ILINK_MESSAGE_STATE_DONE = 2 as const;
export const ILINK_ITEM_TYPE_TEXT = 1 as const;
export const ILINK_ITEM_TYPE_VOICE = 3 as const;
export const ILINK_TYPING_STATUS_ACTIVE = 1 as const;
export const ILINK_TYPING_STATUS_CANCEL = 2 as const;

/**
 * Cryptographic & signature constants per official WeChat WXBizMsgCrypt specification.
 *
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */
export const WEIXIN_ENCODING_AES_KEY_LEN = 43 as const;
export const WEIXIN_AES_KEY_BYTES = 32 as const;
export const WEIXIN_AES_IV_BYTES = 16 as const;
export const WEIXIN_PKCS7_BLOCK_SIZE = 32 as const;
export const WEIXIN_FALLBACK_PKCS7_BLOCK_SIZE = 16 as const;
export const WEIXIN_RANDOM_PREFIX_BYTES = 16 as const;
export const WEIXIN_MSG_LEN_BYTES = 4 as const;
export const WEIXIN_AES_ALGORITHM = "aes-256-cbc" as const;
export const WEIXIN_SHA1_HEX_LEN = 40 as const;
export const WEIXIN_ENCRYPT_TYPE_AES = "aes" as const;
export const WEIXIN_UIN_RANDOM_BYTES = 4 as const;
export const MAX_UNICODE_CODE_POINT = 0x10ffff as const;

/**
 * Webhook & HTTP transport constants.
 */
export const HTTP_STATUS_OK = 200 as const;
export const HTTP_STATUS_BAD_REQUEST = 400 as const;
export const HTTP_STATUS_UNAUTHORIZED = 401 as const;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429 as const;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;
export const HTTP_STATUS_SERVER_ERROR_MIN = 500 as const;

export const CONTENT_TYPE_TEXT_PLAIN_UTF8 = "text/plain; charset=utf-8" as const;
export const CONTENT_TYPE_APPLICATION_JSON = "application/json; charset=utf-8" as const;
export const CONTENT_TYPE_APPLICATION_XML = "application/xml; charset=utf-8" as const;

export const WEIXIN_WEBHOOK_ACK_BODY = "success" as const;

/**
 * Timeouts, caching, deduplication, and safe message chunking thresholds.
 *
 * Note: Official WeChat `message/custom/send` enforces a 2048-byte UTF-8 limit on `text.content`
 * (`errcode = 45002`, `content size out of limit`). Defaulting `DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES`
 * to 2000 UTF-8 bytes leaves safe headroom for multi-byte CJK characters and code fences.
 *
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/errCode/
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000 as const;
export const DEFAULT_ILINK_LONG_POLL_TIMEOUT_MS = 35_000 as const;
export const DEFAULT_POLL_RETRY_BASE_DELAY_MS = 1_000 as const;
export const DEFAULT_POLL_RETRY_MAX_DELAY_MS = 10_000 as const;
export const DEFAULT_TOKEN_REFRESH_MARGIN_MS = 300_000 as const;
export const DEFAULT_TOKEN_FALLBACK_TTL_SECONDS = 7_200 as const;
export const MILLISECONDS_PER_SECOND = 1_000 as const;

export const DEFAULT_MAX_MESSAGE_CHARS = 1_800 as const;
export const DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES = 2_000 as const;
export const MIN_CHUNK_CHARS = 4 as const;
export const MIN_CHUNK_UTF8_BYTES = 4 as const;
export const MIN_LINE_SPLIT_RATIO = 0.6 as const;
export const FENCE_CLOSE_MARKER = "\n```" as const;

export const DEFAULT_DEDUP_CACHE_SIZE = 2_000 as const;
export const DEFAULT_CONTEXT_TOKEN_CACHE_SIZE = 1_000 as const;

/**
 * Official WeChat API `errcode` constants.
 *
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/errCode/
 */
export const WEIXIN_ERRCODE_OK = 0 as const;
export const WEIXIN_ERRCODE_SYSTEM_BUSY = -1 as const;
export const WEIXIN_RATE_LIMIT_ERRCODE = 45009 as const;
export const WEIXIN_ILINK_STALE_TOKEN_CODE = -14 as const;

export const WEIXIN_TOKEN_EXPIRED_ERRCODES: readonly number[] = Object.freeze([
  40001, // invalid credential / access_token is invalid or not latest
  40014, // invalid access_token
  42001, // access_token expired
]);

export const WEIXIN_AUTH_ERRCODES: readonly number[] = Object.freeze([
  40001, // invalid credential
  40002, // invalid grant_type
  40013, // invalid appid
  40014, // invalid access_token
  40125, // invalid appsecret
  40164, // invalid ip not in whitelist
  40243, // AppSecret frozen
  41002, // appid missing
  41004, // appsecret missing
  42001, // access_token expired
  48001, // api unauthorized
  50004, // token api disabled
  50007, // account frozen
]);
