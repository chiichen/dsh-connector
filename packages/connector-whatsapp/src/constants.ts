/**
 * Protocol constants and defaults for the Meta WhatsApp Business Cloud API connector.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */

export const WHATSAPP_CONNECTOR_VERSION = "0.1.0" as const;

export const DEFAULT_WHATSAPP_CONNECTOR_NAME = "whatsapp" as const;
export const DEFAULT_WHATSAPP_DISPLAY_NAME = "WhatsApp Business Cloud API" as const;
export const DEFAULT_WHATSAPP_DESCRIPTION =
  "Send and receive WhatsApp messages via Meta WhatsApp Business Cloud API" as const;
export const DEFAULT_WHATSAPP_SENDER_DESCRIPTION =
  "Send a WhatsApp text message or contextual reply via Meta WhatsApp Business Cloud API" as const;

export const WHATSAPP_GRAPH_API_BASE_URL = "https://graph.facebook.com" as const;
export const DEFAULT_WHATSAPP_API_VERSION = "v25.0" as const;
export const WHATSAPP_MESSAGING_PRODUCT = "whatsapp" as const;

/**
 * Maximum body length (in characters) accepted by Cloud API `text.body`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
 */
export const WHATSAPP_MAX_TEXT_LENGTH = 4096 as const;

export const DEFAULT_WHATSAPP_REQUEST_TIMEOUT_MS = 15_000 as const;
export const DEFAULT_OUTBOUND_ECHO_CACHE_SIZE = 2_000 as const;

/**
 * Maximum duration (25 seconds) before a WhatsApp Cloud API typing indicator auto-dismisses.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 */
export const WHATSAPP_TYPING_MAX_TTL_MS = 25_000 as const;
export const DEFAULT_WHATSAPP_TYPING_KEEPALIVE_MS = 20_000 as const;
export const WHATSAPP_READ_STATUS = "read" as const;
export const WHATSAPP_TYPING_INDICATOR_TYPE = "text" as const;

export const DEFAULT_WHATSAPP_STATUS_REACTIONS = Object.freeze({
  processing: "👀",
  success: "✅",
  error: "❌",
} as const);

/**
 * Meta Graph API Webhooks GET verification query parameters and expected mode.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export const HUB_MODE_QUERY_PARAM = "hub.mode" as const;
export const HUB_VERIFY_TOKEN_QUERY_PARAM = "hub.verify_token" as const;
export const HUB_CHALLENGE_QUERY_PARAM = "hub.challenge" as const;
export const HUB_SUBSCRIBE_MODE = "subscribe" as const;

/**
 * Meta Graph API Webhooks POST HMAC-SHA256 signature header and prefix.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
 */
export const WEBHOOK_SIGNATURE_HEADER = "x-hub-signature-256" as const;
export const WEBHOOK_SIGNATURE_PREFIX = "sha256=" as const;
export const SHA256_HEX_LENGTH = 64 as const;

/**
 * WhatsApp Business Account Webhook envelope discriminators.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */
export const WHATSAPP_WEBHOOK_OBJECT = "whatsapp_business_account" as const;
export const WHATSAPP_WEBHOOK_MESSAGES_FIELD = "messages" as const;

/**
 * Structured `ConnectorContextId` prefixes for conversation routing.
 */
export const DIRECT_CONTEXT_PREFIX = "direct:" as const;
export const P2P_CONTEXT_PREFIX = "p2p:" as const;
export const GROUP_CONTEXT_PREFIX = "group:" as const;

/**
 * Meta Graph API / Cloud API error codes mapped to authentication or retryable rate-limit errors.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export const GRAPH_AUTH_ERROR_CODES: ReadonlySet<number> = new Set([102, 190]);
export const GRAPH_RATE_LIMIT_ERROR_CODES: ReadonlySet<number> = new Set([
  4, 80007, 130429, 131048, 131056,
]);

export const HTTP_STATUS_OK = 200 as const;
export const HTTP_STATUS_BAD_REQUEST = 400 as const;
export const HTTP_STATUS_UNAUTHORIZED = 401 as const;
export const HTTP_STATUS_FORBIDDEN = 403 as const;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429 as const;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500 as const;

export const CONTENT_TYPE_JSON = "application/json; charset=utf-8" as const;
export const CONTENT_TYPE_TEXT_PLAIN = "text/plain; charset=utf-8" as const;
export const MILLISECONDS_PER_SECOND = 1_000 as const;
