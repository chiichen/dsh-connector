/**
 * Package version and protocol constants for `@dsh-connector/connector-dingtalk`.
 *
 * @see https://open.dingtalk.com/document/development/server-api-calling-guide.md
 * @see https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
 */
export const CONNECTOR_DINGTALK_VERSION = "0.1.0" as const;

export const DEFAULT_DINGTALK_CONNECTOR_NAME = "dingtalk" as const;
export const DEFAULT_DINGTALK_DISPLAY_NAME = "DingTalk" as const;
export const DEFAULT_DINGTALK_DESCRIPTION =
  "Send messages to DingTalk chats and receive robot messages via Stream WebSocket or HTTP Outgoing webhook." as const;

/**
 * DingTalk OpenAPI v1.0 base URL.
 *
 * @see https://open.dingtalk.com/document/development/server-api-calling-guide.md
 */
export const DINGTALK_API_BASE_URL = "https://api.dingtalk.com" as const;

/**
 * Trusted DingTalk domain suffix for `sessionWebhook` validation.
 *
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 */
export const DINGTALK_TRUSTED_DOMAIN = "dingtalk.com" as const;
export const DINGTALK_TRUSTED_SUBDOMAIN_SUFFIX = ".dingtalk.com" as const;
export const HTTPS_PROTOCOL = "https:" as const;
export const HTTPS_DEFAULT_PORT = "443" as const;

/**
 * Enterprise internal app OAuth2 accessToken endpoint (`POST`).
 *
 * @see https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app.md
 * @see https://open.dingtalk.com/document/orgapp-server/obtain-the-access_token-of-an-internal-app.md
 */
export const DINGTALK_OAUTH_TOKEN_PATH = "/v1.0/oauth2/accessToken" as const;
export const DINGTALK_ACCESS_TOKEN_HEADER = "x-acs-dingtalk-access-token" as const;
export const DINGTALK_DEFAULT_TOKEN_EXPIRE_SECONDS = 7_200 as const;
export const DINGTALK_TOKEN_REFRESH_BUFFER_SECONDS = 60 as const;
export const DINGTALK_MIN_TOKEN_TTL_MS = 1_000 as const;

/**
 * Stream mode gateway ticket registration endpoint (`POST`).
 *
 * @see https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
 * @see https://open.dingtalk.com/document/orgapp/develop-stream-mode-push-server.md
 */
export const DINGTALK_GATEWAY_OPEN_PATH = "/v1.0/gateway/connections/open" as const;
export const DINGTALK_STREAM_CONNECT_PATH = "/connect" as const;
export const DINGTALK_STREAM_TICKET_PARAM = "ticket" as const;
export const DINGTALK_STREAM_USER_AGENT =
  `dsh-connector-dingtalk/${CONNECTOR_DINGTALK_VERSION}` as const;

export const DINGTALK_STREAM_SUBSCRIPTION_CALLBACK = "CALLBACK" as const;
export const DINGTALK_STREAM_SUBSCRIPTION_EVENT = "EVENT" as const;
export const DINGTALK_STREAM_TOPIC_ROBOT = "/v1.0/im/bot/messages/get" as const;
export const DINGTALK_STREAM_TOPIC_CARD_CALLBACK = "/v1.0/card/instances/callback" as const;
export const DINGTALK_STREAM_TOPIC_WILDCARD = "*" as const;

export const DINGTALK_STREAM_FRAME_SYSTEM = "SYSTEM" as const;
export const DINGTALK_STREAM_FRAME_CALLBACK = "CALLBACK" as const;
export const DINGTALK_STREAM_FRAME_EVENT = "EVENT" as const;
export const DINGTALK_STREAM_SYSTEM_PING = "ping" as const;
export const DINGTALK_STREAM_SYSTEM_DISCONNECT = "disconnect" as const;

export const DINGTALK_STREAM_ACK_STATUS_OK = 200 as const;
export const DINGTALK_STREAM_ACK_MESSAGE_OK = "OK" as const;
export const DINGTALK_STREAM_CONTENT_TYPE_JSON = "application/json" as const;
export const DINGTALK_STREAM_EVENT_STATUS_SUCCESS = "SUCCESS" as const;
export const DINGTALK_STREAM_EVENT_STATUS_LATER = "LATER" as const;

/**
 * Proactive robot outbound messaging endpoints (`POST`).
 *
 * @see https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches.md
 * @see https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message.md
 * @see https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots.md
 */
export const DINGTALK_OTO_BATCH_SEND_PATH = "/v1.0/robot/oToMessages/batchSend" as const;
export const DINGTALK_GROUP_MESSAGE_SEND_PATH = "/v1.0/robot/groupMessages/send" as const;
export const DINGTALK_MAX_OTO_BATCH_USERS = 20 as const;
export const DINGTALK_MSG_KEY_TEXT = "sampleText" as const;
export const DINGTALK_MSG_KEY_MARKDOWN = "sampleMarkdown" as const;
export const DINGTALK_WEBHOOK_MSGTYPE_TEXT = "text" as const;
export const DINGTALK_WEBHOOK_MSGTYPE_MARKDOWN = "markdown" as const;
export const DINGTALK_DEFAULT_MARKDOWN_TITLE = "Message" as const;
export const DINGTALK_MARKDOWN_TITLE_MAX_LEN = 64 as const;

/**
 * Interactive Card / AI Card OpenAPI v1.0 endpoints (reserved for streaming extension seam).
 *
 * @see https://open.dingtalk.com/document/development/interface-for-creating-a-card-instance.md
 * @see https://open.dingtalk.com/document/development/create-and-deliver-cards.md
 * @see https://open.dingtalk.com/document/orgapp/delivery-card-interface.md
 * @see https://open.dingtalk.com/document/development/api-streamingupdate.md
 */
export const DINGTALK_CARD_INSTANCES_PATH = "/v1.0/card/instances" as const;
export const DINGTALK_CARD_CREATE_AND_DELIVER_PATH =
  "/v1.0/card/instances/createAndDeliver" as const;
export const DINGTALK_CARD_DELIVER_PATH = "/v1.0/card/instances/deliver" as const;
export const DINGTALK_CARD_STREAMING_PATH = "/v1.0/card/streaming" as const;
export const DINGTALK_CARD_OPEN_SPACE_PREFIX = "dtv1.card//" as const;
export const DINGTALK_CARD_SPACE_IM_GROUP = "IM_GROUP" as const;
export const DINGTALK_CARD_SPACE_IM_ROBOT = "IM_ROBOT" as const;
export const DINGTALK_CARD_SPACE_IM_SINGLE = "IM_SINGLE" as const;
export const DINGTALK_CARD_SPACE_ONE_BOX = "ONE_BOX" as const;

/**
 * HTTP Outgoing robot callback verification constants.
 * Official policy rejects timestamps differing from server time by more than 1 hour (3,600,000 ms).
 *
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 * @see https://open.dingtalk.com/document/group/process-of-signing-a-message-with-a-custom-chatbot
 * @see https://open.dingtalk.com/document/isvapp/custom-bot-access-send-message.md
 */
export const DINGTALK_WEBHOOK_TIMESTAMP_HEADER = "timestamp" as const;
export const DINGTALK_WEBHOOK_SIGN_HEADER = "sign" as const;
export const DINGTALK_WEBHOOK_TOKEN_HEADER = "token" as const;
export const DINGTALK_WEBHOOK_MAX_SKEW_MS = 3_600_000 as const;
export const DINGTALK_HMAC_ALGORITHM = "sha256" as const;

/**
 * Inbound conversation types & context ID prefixes.
 *
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 */
export const DINGTALK_CONVERSATION_SINGLE = "1" as const;
export const DINGTALK_CONVERSATION_GROUP = "2" as const;
export const DINGTALK_CONTEXT_P2P_PREFIX = "p2p:" as const;
export const DINGTALK_CONTEXT_ENCRYPTED_P2P_PREFIX = "p2p-id:" as const;
export const DINGTALK_CONTEXT_GROUP_PREFIX = "group:" as const;

/**
 * Default transport timeouts, reconnect backoff, and sessionWebhook cache limits.
 */
export const DINGTALK_DEFAULT_HTTP_TIMEOUT_MS = 15_000 as const;
export const DINGTALK_DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 15_000 as const;
export const DINGTALK_DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000 as const;
export const DINGTALK_DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000 as const;
export const DINGTALK_RECONNECT_BACKOFF_FACTOR = 2 as const;
export const DINGTALK_DEFAULT_SESSION_WEBHOOK_TTL_MS = 5_400_000 as const;
export const DINGTALK_MAX_CACHED_SESSION_WEBHOOKS = 500 as const;

export const HTTP_STATUS_OK = 200 as const;
export const HTTP_STATUS_BAD_REQUEST = 400 as const;
export const HTTP_STATUS_UNAUTHORIZED = 401 as const;
export const HTTP_STATUS_FORBIDDEN = 403 as const;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429 as const;
export const HTTP_STATUS_SERVER_ERROR_MIN = 500 as const;
