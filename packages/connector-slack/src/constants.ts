/**
 * Slack protocol, Web API, Events API, and Socket Mode constants.
 *
 * @see https://docs.slack.dev/apis/web-api/
 * @see https://docs.slack.dev/apis/events-api/
 * @see https://docs.slack.dev/apis/events-api/using-socket-mode/
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack/
 */

export const SLACK_CONNECTOR_VERSION = "0.1.0" as const;

export const DEFAULT_SLACK_CONNECTOR_NAME = "slack" as const;

export const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api/" as const;

export const DEFAULT_SLACK_TIMEOUT_MS = 15_000 as const;

export const DEFAULT_SLACK_CONNECT_TIMEOUT_MS = 20_000 as const;

/**
 * Default replay-protection window (5 minutes = 300 seconds) recommended by Slack.
 *
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack/
 */
export const DEFAULT_SLACK_SIGNATURE_TOLERANCE_SEC = 300 as const;

export const SLACK_SIGNATURE_VERSION = "v0" as const;

export const SLACK_SIGNATURE_PREFIX = "v0=" as const;

export const SLACK_HEADER_SIGNATURE = "x-slack-signature" as const;

export const SLACK_HEADER_TIMESTAMP = "x-slack-request-timestamp" as const;

export const SLACK_HEADER_RETRY_NUM = "x-slack-retry-num" as const;

export const SLACK_HEADER_RETRY_REASON = "x-slack-retry-reason" as const;

export const SLACK_HEADER_RETRY_AFTER = "retry-after" as const;

export const SLACK_BOT_TOKEN_PREFIX = "xoxb-" as const;

export const SLACK_APP_TOKEN_PREFIX = "xapp-" as const;

export const SLACK_METHOD_AUTH_TEST = "auth.test" as const;

export const SLACK_METHOD_OPEN_CONNECTION = "apps.connections.open" as const;

export const SLACK_METHOD_POST_MESSAGE = "chat.postMessage" as const;

export const SLACK_METHOD_UPDATE_MESSAGE = "chat.update" as const;

export const SLACK_METHOD_SET_ASSISTANT_STATUS = "assistant.threads.setStatus" as const;

export const SLACK_METHOD_START_STREAM = "chat.startStream" as const;

export const SLACK_METHOD_APPEND_STREAM = "chat.appendStream" as const;

export const SLACK_METHOD_STOP_STREAM = "chat.stopStream" as const;

export const SLACK_WEBHOOK_TYPE_URL_VERIFICATION = "url_verification" as const;

export const SLACK_WEBHOOK_TYPE_EVENT_CALLBACK = "event_callback" as const;

export const SLACK_SOCKET_PACKET_HELLO = "hello" as const;

export const SLACK_SOCKET_PACKET_DISCONNECT = "disconnect" as const;

export const SLACK_SOCKET_PACKET_EVENTS_API = "events_api" as const;

export const SLACK_EVENT_MESSAGE = "message" as const;

export const SLACK_EVENT_APP_MENTION = "app_mention" as const;

export const SLACK_CHANNEL_TYPE_IM = "im" as const;

export const SLACK_CHANNEL_TYPE_MPIM = "mpim" as const;

export const SLACK_CHANNEL_TYPE_CHANNEL = "channel" as const;

export const SLACK_CHANNEL_TYPE_GROUP = "group" as const;

export const SLACK_ALLOWED_SUBTYPE_FILE_SHARE = "file_share" as const;

export const SLACK_CONTEXT_DM_KIND = "dm" as const;

export const SLACK_CONTEXT_CHANNEL_KIND = "channel" as const;

export const SLACK_CONTEXT_PART_SEPARATOR = ":" as const;

/**
 * Maximum `text` field length before Slack truncates (`message_truncated`).
 *
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export const SLACK_TEXT_MAX_LENGTH = 40_000 as const;

/**
 * Maximum `markdown_text` length accepted by Slack `chat.postMessage` and `chat.startStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 */
export const SLACK_MARKDOWN_TEXT_MAX_LENGTH = 12_000 as const;

export const SLACK_RECONNECT_DELAYS_MS = [1_000, 3_000, 5_000, 10_000, 30_000] as const;

export const SLACK_DEFAULT_RETRY_AFTER_SEC = 1 as const;

export const SLACK_MIN_RETRY_DELAY_MS = 100 as const;

export const SLACK_MAX_RETRY_DELAY_MS = 10_000 as const;

export const MILLISECONDS_PER_SECOND = 1_000 as const;

export const SLACK_WS_READY_STATE_OPEN = 1 as const;

export const SLACK_WS_READY_STATE_CLOSING = 2 as const;

export const SLACK_WS_CLOSE_NORMAL = 1_000 as const;

export const SLACK_WS_CLOSE_RECONNECT = 4_000 as const;

export const HTTP_STATUS_OK = 200 as const;

export const HTTP_STATUS_BAD_REQUEST = 400 as const;

export const HTTP_STATUS_UNAUTHORIZED = 401 as const;

export const HTTP_STATUS_FORBIDDEN = 403 as const;

export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405 as const;

export const HTTP_STATUS_TOO_MANY_REQUESTS = 429 as const;

export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500 as const;

export const SLACK_AUTH_ERROR_CODES = [
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "not_allowed_token_type",
] as const;

export const SLACK_RETRYABLE_ERROR_CODES = [
  "ratelimited",
  "rate_limited",
  "service_unavailable",
  "request_timeout",
  "internal_error",
] as const;
