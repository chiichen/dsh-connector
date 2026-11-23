export {
  CONTENT_TYPE_APPLICATION_JSON,
  CONTENT_TYPE_APPLICATION_XML,
  CONTENT_TYPE_TEXT_PLAIN_UTF8,
  DEFAULT_CONTEXT_TOKEN_CACHE_SIZE,
  DEFAULT_DEDUP_CACHE_SIZE,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_ILINK_LONG_POLL_TIMEOUT_MS,
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES,
  DEFAULT_POLL_RETRY_BASE_DELAY_MS,
  DEFAULT_POLL_RETRY_MAX_DELAY_MS,
  DEFAULT_TOKEN_FALLBACK_TTL_SECONDS,
  DEFAULT_TOKEN_REFRESH_MARGIN_MS,
  DEFAULT_WEIXIN_CONNECTOR_NAME,
  DEFAULT_WEIXIN_DESCRIPTION,
  DEFAULT_WEIXIN_DISPLAY_NAME,
  WEIXIN_CLASSIC_TOKEN_PATH,
  WEIXIN_CONNECTOR_VERSION,
  WEIXIN_CUSTOM_SEND_PATH,
  WEIXIN_CUSTOM_TYPING_PATH,
  WEIXIN_ILINK_BASE_URL,
  WEIXIN_OFFICIAL_API_BASE_URL,
  WEIXIN_P2P_CONTEXT_PREFIX,
  WEIXIN_STABLE_TOKEN_PATH,
  WEIXIN_WEBHOOK_ACK_BODY,
} from "./constants";

export {
  WeixinApiClient,
  type IlinkGetUpdatesResult,
  type IlinkRawMessage,
  type IlinkRawMessageItem,
  type SendCustomTextRequest,
  type SendCustomTypingRequest,
  type SendTextChunkResponse,
  type WeixinApiClientOptions,
} from "./api-client";

export { splitWeixinText, type SplitWeixinTextOptions } from "./chunker";

export {
  formatWeixinP2pContextId,
  parseWeixinTargetFromContextId,
  resolveWeixinSendTarget,
} from "./context-target";

export {
  buildEncryptedWeixinReply,
  computeWeixinSignature,
  decodeEncodingAesKey,
  decryptWeixinCiphertext,
  encryptWeixinPlaintext,
  verifyWeixinMsgSignature,
  verifyWeixinSignature,
  type BuildEncryptedWeixinReplyOptions,
  type DecryptedWeixinPayload,
  type DecryptWeixinCiphertextOptions,
  type EncryptWeixinPlaintextOptions,
} from "./crypto";

export { BoundedIdSet } from "./dedup";

export type {
  WeixinAiMsgContext,
  WeixinCustomTypingPayload,
  WeixinStreamAbortReason,
  WeixinStreamCallOptions,
  WeixinStreamCompleteInput,
  WeixinStreamHandle,
  WeixinStreamingAdapter,
  WeixinStreamingOptions,
  WeixinStreamTarget,
  WeixinStreamUpdatePatch,
  WeixinTypingCommand,
} from "./streaming";

export { WeixinAccessTokenManager, type WeixinAccessTokenManagerOptions } from "./token-manager";

export {
  weixinReceiveSchema,
  weixinSendSchema,
  type WeixinAccessTokenProvider,
  type WeixinAccessTokenProviderOptions,
  type WeixinConnectorCommonOptions,
  type WeixinConnectorMode,
  type WeixinConnectorOptions,
  type WeixinIlinkOptions,
  type WeixinOfficialAccountOptions,
  type WeixinReceiveParams,
  type WeixinSendParams,
  type WeixinSendResult,
  type WeixinTokenStrategy,
} from "./types";

export { parseWeixinCallbackBody } from "./xml";
