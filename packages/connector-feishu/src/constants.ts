/**
 * Named protocol and runtime constants for `@dsh-connector/connector-feishu`.
 *
 * @see https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 */

export const FEISHU_CONNECTOR_VERSION = "0.1.0" as const;

export const DEFAULT_FEISHU_CONNECTOR_NAME = "feishu" as const;
export const DEFAULT_FEISHU_DISPLAY_NAME = "Feishu / Lark" as const;
export const DEFAULT_FEISHU_DESCRIPTION =
  "Bidirectional Feishu (Lark) IM bot connector supporting HTTP Webhook v2.0, WebSocket long connection, and OpenAPI v1 messaging" as const;
export const DEFAULT_FEISHU_SEND_DESCRIPTION =
  "Send or reply to a Feishu (Lark) direct chat or group chat message via OpenAPI im/v1/messages" as const;

/**
 * Official Feishu (China) and Lark (International) OpenAPI base URLs.
 *
 * @see https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-
 */
export const FEISHU_OPEN_API_BASE_URL = "https://open.feishu.cn" as const;
export const LARK_OPEN_API_BASE_URL = "https://open.larksuite.com" as const;

/**
 * Official Feishu OpenAPI endpoint paths.
 *
 * @see https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 * @see https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/reply
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/get
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
 * @see https://open.feishu.cn/document/cardkit-v1/card/create
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 */
export const FEISHU_TENANT_ACCESS_TOKEN_PATH =
  "/open-apis/auth/v3/tenant_access_token/internal" as const;
export const FEISHU_BOT_INFO_PATH = "/open-apis/bot/v3/info" as const;
export const FEISHU_MESSAGES_PATH = "/open-apis/im/v1/messages" as const;
export const FEISHU_CARDKIT_CARDS_PATH = "/open-apis/cardkit/v1/cards" as const;
export const FEISHU_WS_ENDPOINT_PATH = "/callback/ws/endpoint" as const;

export const DEFAULT_TOKEN_EXPIRE_SECONDS = 7200 as const;
export const DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS = 180 as const;
export const MIN_TOKEN_CACHE_TTL_MS = 1_000 as const;
export const MS_PER_SECOND = 1_000 as const;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000 as const;
export const FEISHU_MAX_DEDUP_UUID_LEN = 50 as const;

/**
 * Feishu OpenAPI response codes.
 *
 * @see https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
 */
export const FEISHU_API_SUCCESS_CODE = 0 as const;
export const FEISHU_RATE_LIMIT_ERROR_CODES = [230020, 99991400] as const;
export const FEISHU_TOKEN_INVALID_ERROR_CODES = [
  99991661, 99991663, 99991664, 99991665, 99991668,
] as const;
export const FEISHU_APP_AUTH_ERROR_CODES = [10003, 10014, 99991661, 99991663, 99991664] as const;

export const HTTP_STATUS_OK = 200 as const;
export const HTTP_STATUS_ACCEPTED = 202 as const;
export const HTTP_STATUS_BAD_REQUEST = 400 as const;
export const HTTP_STATUS_UNAUTHORIZED = 401 as const;
export const HTTP_STATUS_FORBIDDEN = 403 as const;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429 as const;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500 as const;

/**
 * Feishu Webhook v2.0 HTTP headers, encryption constants, and event names.
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 * @see https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/send-callbacks-to-developers-server
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 */
export const FEISHU_SIGNATURE_HEADER = "x-lark-signature" as const;
export const FEISHU_TIMESTAMP_HEADER = "x-lark-request-timestamp" as const;
export const FEISHU_NONCE_HEADER = "x-lark-request-nonce" as const;
export const FEISHU_AES_BLOCK_BYTES = 16 as const;
export const FEISHU_AES_MIN_CIPHERTEXT_BYTES = 32 as const;
export const FEISHU_AES_ALGORITHM = "aes-256-cbc" as const;
export const FEISHU_HASH_ALGORITHM = "sha256" as const;

export const FEISHU_EVENT_SCHEMA_V2 = "2.0" as const;
export const FEISHU_URL_VERIFICATION_TYPE = "url_verification" as const;
export const FEISHU_MESSAGE_RECEIVE_EVENT_TYPE = "im.message.receive_v1" as const;
export const FEISHU_CARD_ACTION_EVENT_TYPE = "card.action.trigger" as const;
export const FEISHU_AT_ALL_MENTION_KEY = "@_all" as const;

/**
 * Structured conversation context ID prefixes and Feishu ID prefixes.
 */
export const FEISHU_P2P_CONTEXT_PREFIX = "p2p:" as const;
export const FEISHU_P2P_USER_CONTEXT_PREFIX = "p2p:user:" as const;
export const FEISHU_GROUP_CONTEXT_PREFIX = "group:" as const;
export const FEISHU_TOPIC_CONTEXT_INFIX = ":topic:" as const;
export const FEISHU_THREAD_CONTEXT_INFIX = ":thread:" as const;

export const FEISHU_CHAT_ID_PREFIX = "oc_" as const;
export const FEISHU_OPEN_ID_PREFIX = "ou_" as const;
export const FEISHU_UNION_ID_PREFIX = "on_" as const;
export const FEISHU_MESSAGE_ID_PREFIX = "om_" as const;

export const FEISHU_TARGET_REQUIRED_FIELD_HINT =
  "chatId | openId | receiveId | replyToMessageId" as const;

/**
 * Feishu Card JSON 2.0 schema version & CardKit v1 sequence bounds.
 *
 * @see https://open.feishu.cn/document/cardkit-v1/card-element/content
 */
export const FEISHU_CARD_SCHEMA_V2 = "2.0" as const;
export const CARDKIT_MIN_SEQUENCE = 1 as const;
export const CARDKIT_MAX_INT32_SEQUENCE = 2_147_483_647 as const;
export const DEFAULT_CARDKIT_STREAM_ELEMENT_ID = "markdown_stream_1" as const;

/**
 * Feishu WebSocket long-connection (`pbbp2.Frame`) protocol constants.
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 * @see https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events
 */
export const PBBP2_WIRE_TYPE_VARINT = 0 as const;
export const PBBP2_WIRE_TYPE_64BIT = 1 as const;
export const PBBP2_WIRE_TYPE_LEN_DELIMITED = 2 as const;
export const PBBP2_WIRE_TYPE_32BIT = 5 as const;
export const PBBP2_FIXED_64_BYTES = 8 as const;
export const PBBP2_FIXED_32_BYTES = 4 as const;
export const PBBP2_MAX_VARINT_SHIFT = 64 as const;

export const PBBP2_FIELD_SEQ_ID = 1 as const;
export const PBBP2_FIELD_LOG_ID = 2 as const;
export const PBBP2_FIELD_SERVICE = 3 as const;
export const PBBP2_FIELD_METHOD = 4 as const;
export const PBBP2_FIELD_HEADERS = 5 as const;
export const PBBP2_FIELD_PAYLOAD_ENCODING = 6 as const;
export const PBBP2_FIELD_PAYLOAD_TYPE = 7 as const;
export const PBBP2_FIELD_PAYLOAD = 8 as const;
export const PBBP2_FIELD_LOG_ID_NEW = 9 as const;

export const PBBP2_HEADER_FIELD_KEY = 1 as const;
export const PBBP2_HEADER_FIELD_VALUE = 2 as const;

export const PBBP2_FRAME_METHOD_CONTROL = 0 as const;
export const PBBP2_FRAME_METHOD_DATA = 1 as const;

export const PBBP2_HEADER_TYPE = "type" as const;
export const PBBP2_HEADER_MESSAGE_ID = "message_id" as const;
export const PBBP2_HEADER_SUM = "sum" as const;
export const PBBP2_HEADER_SEQ = "seq" as const;
export const PBBP2_HEADER_TRACE_ID = "trace_id" as const;
export const PBBP2_HEADER_BIZ_RT = "biz_rt" as const;

export const PBBP2_MESSAGE_TYPE_PING = "ping" as const;
export const PBBP2_MESSAGE_TYPE_PONG = "pong" as const;
export const PBBP2_MESSAGE_TYPE_EVENT = "event" as const;
export const PBBP2_MESSAGE_TYPE_CARD = "card" as const;

export const DEFAULT_WS_PING_INTERVAL_MS = 120_000 as const;
export const DEFAULT_WS_RECONNECT_INTERVAL_MS = 120_000 as const;
export const DEFAULT_WS_RECONNECT_NONCE_MS = 30_000 as const;
export const DEFAULT_WS_RECONNECT_COUNT = -1 as const;
export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 15_000 as const;
export const DEFAULT_WS_FRAGMENT_TTL_MS = 10_000 as const;
export const WS_ENDPOINT_INTERNAL_ERROR_CODE = 1_000_040_343 as const;
export const WS_ENDPOINT_SYSTEM_BUSY_CODE = 1 as const;
export const WS_LOCALE_HEADER_VALUE = "zh" as const;
