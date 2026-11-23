export const WHATSAPP_CONNECTOR_PACKAGE_NAME = "@dsh-connector/connector-whatsapp" as const;

export { splitWhatsAppText } from "./chunker";

export { createWhatsAppConnector, WhatsAppConnector } from "./connector";

export {
  CONTENT_TYPE_JSON,
  CONTENT_TYPE_TEXT_PLAIN,
  DEFAULT_OUTBOUND_ECHO_CACHE_SIZE,
  DEFAULT_WHATSAPP_API_VERSION,
  DEFAULT_WHATSAPP_CONNECTOR_NAME,
  DEFAULT_WHATSAPP_DESCRIPTION,
  DEFAULT_WHATSAPP_DISPLAY_NAME,
  DEFAULT_WHATSAPP_REQUEST_TIMEOUT_MS,
  DEFAULT_WHATSAPP_SENDER_DESCRIPTION,
  DEFAULT_WHATSAPP_STATUS_REACTIONS,
  DEFAULT_WHATSAPP_TYPING_KEEPALIVE_MS,
  DIRECT_CONTEXT_PREFIX,
  GRAPH_AUTH_ERROR_CODES,
  GRAPH_RATE_LIMIT_ERROR_CODES,
  GROUP_CONTEXT_PREFIX,
  HUB_CHALLENGE_QUERY_PARAM,
  HUB_MODE_QUERY_PARAM,
  HUB_SUBSCRIBE_MODE,
  HUB_VERIFY_TOKEN_QUERY_PARAM,
  P2P_CONTEXT_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
  WHATSAPP_CONNECTOR_VERSION,
  WHATSAPP_GRAPH_API_BASE_URL,
  WHATSAPP_MAX_TEXT_LENGTH,
  WHATSAPP_MESSAGING_PRODUCT,
  WHATSAPP_READ_STATUS,
  WHATSAPP_TYPING_INDICATOR_TYPE,
  WHATSAPP_TYPING_MAX_TTL_MS,
  WHATSAPP_WEBHOOK_MESSAGES_FIELD,
  WHATSAPP_WEBHOOK_OBJECT,
} from "./constants";

export {
  formatWhatsAppContextId,
  normalizeWhatsAppPhoneDigits,
  parseWhatsAppTargetFromContextId,
  SentMessageTracker,
} from "./context-id";

export {
  createWhatsAppReceiver,
  type WhatsAppReceiverConfig,
  type WhatsAppWebhookChange,
  type WhatsAppWebhookChangeValue,
  type WhatsAppWebhookContact,
  type WhatsAppWebhookEntry,
  type WhatsAppWebhookEnvelope,
  type WhatsAppWebhookIncomingMessage,
  type WhatsAppWebhookMessageContext,
  type WhatsAppWebhookStatusReceipt,
} from "./receiver";

export { createWhatsAppSender, type WhatsAppSenderConfig } from "./sender";

export {
  computeWhatsAppSignature,
  getHeaderCaseInsensitive,
  verifyHubVerifyToken,
  verifyWhatsAppSignature,
} from "./signature";

export {
  buildMarkReadPayload,
  buildReactionPayload,
  buildTypingIndicatorPayload,
  resolveStatusReactionEmoji,
  type WhatsAppMarkReadPayload,
  type WhatsAppReactionMessagePayload,
  type WhatsAppStatusActionResponse,
  type WhatsAppStatusReactionEmojiMap,
  type WhatsAppStatusReactionPhase,
  type WhatsAppStreamAbortReason,
  type WhatsAppStreamCompletion,
  type WhatsAppStreamHandle,
  type WhatsAppStreamingAdapter,
  type WhatsAppStreamingOptions,
  type WhatsAppStreamTarget,
  type WhatsAppStreamUpdate,
  type WhatsAppTypingIndicatorType,
} from "./streaming";

export {
  whatsappInboundMessageTypeSchema,
  whatsappReceiveSchema,
  whatsappRecipientTypeSchema,
  whatsappSendSchema,
  type WhatsAppAccessTokenProvider,
  type WhatsAppCloudContactItem,
  type WhatsAppCloudMessageItem,
  type WhatsAppCloudSendMessageResponse,
  type WhatsAppCloudSendTextRequest,
  type WhatsAppConnectorOptions,
  type WhatsAppGraphErrorEnvelope,
  type WhatsAppInboundMessageType,
  type WhatsAppReceivePayload,
  type WhatsAppRecipientType,
  type WhatsAppSendInput,
  type WhatsAppSendParams,
  type WhatsAppSendResult,
  type WhatsAppTarget,
} from "./types";
