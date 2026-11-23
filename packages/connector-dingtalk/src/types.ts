import { z } from "zod";
import {
  ConnectorValidationError,
  type ConnectorLogger,
  type ConnectorSendResult,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import {
  DEFAULT_DINGTALK_CONNECTOR_NAME,
  DINGTALK_CONTEXT_ENCRYPTED_P2P_PREFIX,
  DINGTALK_CONTEXT_GROUP_PREFIX,
  DINGTALK_CONTEXT_P2P_PREFIX,
  DINGTALK_MAX_OTO_BATCH_USERS,
  DINGTALK_STREAM_SUBSCRIPTION_CALLBACK,
  DINGTALK_STREAM_SUBSCRIPTION_EVENT,
} from "./constants";
import type { DingTalkStreamingAdapter, DingTalkStreamingOptions } from "./streaming";

/**
 * Outbound message schema for `DingTalkSender`.
 * Main text field is named `text` per `dsh-connector` IM conventions, and all target fields are optional
 * so 3-tier target resolution (`params` -> `context.contextId` -> `ConnectorTargetRequiredError`) works seamlessly.
 *
 * @see https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches.md
 * @see https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message.md
 * @see https://open.dingtalk.com/document/development/robot-message-type.md
 */
export const dingTalkSendSchema = z.object({
  text: z.string().min(1),
  format: z.enum(["text", "markdown"]).optional(),
  title: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  userIds: z.array(z.string().min(1)).min(1).max(DINGTALK_MAX_OTO_BATCH_USERS).optional(),
  openConversationId: z.string().min(1).optional(),
  sessionWebhook: z.url().optional(),
  robotCode: z.string().min(1).optional(),
  coolAppCode: z.string().min(1).optional(),
  atUserIds: z.array(z.string().min(1)).optional(),
  atMobiles: z.array(z.string().min(1)).optional(),
  isAtAll: z.boolean().optional(),
});

export type DingTalkSendParams = z.output<typeof dingTalkSendSchema>;
export type DingTalkSendInput = z.input<typeof dingTalkSendSchema>;

/**
 * Normalized inbound message schema validated by `ConnectorManager` on `onReceive`.
 *
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 */
export const dingTalkReceiveSchema = z.object({
  msgId: z.string().min(1),
  msgtype: z.string().min(1),
  text: z.string().min(1),
  quotedText: z.string().optional(),
  conversationId: z.string().min(1),
  conversationType: z.enum(["1", "2"]),
  conversationTitle: z.string().optional(),
  senderId: z.string().min(1),
  senderStaffId: z.string().optional(),
  senderNick: z.string().optional(),
  senderCorpId: z.string().optional(),
  chatbotUserId: z.string().optional(),
  robotCode: z.string().optional(),
  isInAtList: z.boolean().optional(),
  sessionWebhook: z.string().optional(),
  sessionWebhookExpiredTime: z.number().optional(),
  createAt: z.number().optional(),
});

export type DingTalkInboundMessage = z.output<typeof dingTalkReceiveSchema>;

/**
 * Raw DingTalk robot callback JSON payload delivered via HTTP Outgoing webhook or Stream `CALLBACK` frame.
 *
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 * @see https://open.dingtalk.com/document/dingstart/receive-message
 */
export interface DingTalkRobotCallbackPayload {
  readonly msgId?: string;
  readonly msgtype?: string;
  readonly text?: {
    readonly content?: string;
    readonly isReplyMsg?: boolean;
    readonly repliedMsg?: {
      readonly msgId?: string;
      readonly msgType?: string;
      readonly msgtype?: string;
      readonly senderId?: string;
      readonly senderStaffId?: string;
      readonly senderNick?: string;
      readonly content?: string | Readonly<Record<string, unknown>>;
    };
  };
  readonly content?:
    | string
    | {
        readonly richText?: ReadonlyArray<{
          readonly text?: string | { readonly content?: string };
          readonly content?: string;
          readonly type?: string;
          readonly downloadCode?: string;
          readonly pictureDownloadCode?: string;
        }>;
        readonly recognition?: string;
        readonly duration?: number;
        readonly downloadCode?: string;
        readonly fileName?: string;
      };
  readonly conversationId?: string;
  readonly conversationType?: string | number;
  readonly conversationTitle?: string;
  readonly senderId?: string;
  readonly senderStaffId?: string;
  readonly senderNick?: string;
  readonly senderCorpId?: string;
  readonly senderPlatform?: string;
  readonly chatbotCorpId?: string;
  readonly chatbotUserId?: string;
  readonly robotCode?: string;
  readonly isAdmin?: boolean;
  readonly isInAtList?: boolean;
  readonly atUsers?: ReadonlyArray<{
    readonly dingtalkId?: string;
    readonly staffId?: string;
    readonly unionId?: string;
  }>;
  readonly sessionWebhook?: string;
  readonly sessionWebhookExpiredTime?: number | string;
  readonly createAt?: number | string;
}

/**
 * Parsed structured target from `context.contextId`.
 */
export type DingTalkParsedContextTarget =
  | {
      readonly kind: "user";
      readonly userId: string;
    }
  | {
      readonly kind: "encryptedUser";
      readonly senderId: string;
    }
  | {
      readonly kind: "group";
      readonly openConversationId: string;
    };

/**
 * Formats a single-chat enterprise `staffId` / `userId` into a structured `contextId` (`p2p:<userId>`).
 */
export function formatDingTalkP2PContextId(userId: string): string {
  const trimmed = userId.trim();
  if (trimmed.length === 0) {
    throw new ConnectorValidationError("DingTalk userId must be a non-empty string.");
  }
  return `${DINGTALK_CONTEXT_P2P_PREFIX}${trimmed}`;
}

/**
 * Formats an encrypted single-chat `senderId` (when `senderStaffId` is absent) into `p2p-id:<senderId>`.
 */
export function formatDingTalkEncryptedP2PContextId(senderId: string): string {
  const trimmed = senderId.trim();
  if (trimmed.length === 0) {
    throw new ConnectorValidationError("DingTalk senderId must be a non-empty string.");
  }
  return `${DINGTALK_CONTEXT_ENCRYPTED_P2P_PREFIX}${trimmed}`;
}

/**
 * Formats a group `openConversationId` into a structured `contextId` (`group:<openConversationId>`).
 */
export function formatDingTalkGroupContextId(openConversationId: string): string {
  const trimmed = openConversationId.trim();
  if (trimmed.length === 0) {
    throw new ConnectorValidationError("DingTalk openConversationId must be a non-empty string.");
  }
  return `${DINGTALK_CONTEXT_GROUP_PREFIX}${trimmed}`;
}

/**
 * Extracts a structured DingTalk business target from `contextId`.
 * Returns `undefined` for pre-allocated UUIDs or unrecognized strings so they are never
 * mistakenly sent as DingTalk conversation or user IDs.
 */
export function parseDingTalkContextTarget(
  contextId: string,
): DingTalkParsedContextTarget | undefined {
  if (contextId.startsWith(DINGTALK_CONTEXT_P2P_PREFIX)) {
    const userId = contextId.slice(DINGTALK_CONTEXT_P2P_PREFIX.length).trim();
    return userId.length > 0 ? { kind: "user", userId } : undefined;
  }
  if (contextId.startsWith(DINGTALK_CONTEXT_ENCRYPTED_P2P_PREFIX)) {
    const senderId = contextId.slice(DINGTALK_CONTEXT_ENCRYPTED_P2P_PREFIX.length).trim();
    return senderId.length > 0 ? { kind: "encryptedUser", senderId } : undefined;
  }
  if (contextId.startsWith(DINGTALK_CONTEXT_GROUP_PREFIX)) {
    const openConversationId = contextId.slice(DINGTALK_CONTEXT_GROUP_PREFIX.length).trim();
    return openConversationId.length > 0 ? { kind: "group", openConversationId } : undefined;
  }
  return undefined;
}

/**
 * Concrete delivery target resolved by `DingTalkSender`.
 */
export type DingTalkResolvedTarget =
  | {
      readonly kind: "sessionWebhook";
      readonly sessionWebhook: string;
    }
  | {
      readonly kind: "user";
      readonly userIds: readonly string[];
      readonly robotCode: string;
    }
  | {
      readonly kind: "group";
      readonly openConversationId: string;
      readonly robotCode: string;
      readonly coolAppCode?: string;
    };

/**
 * Structured send result returned by `DingTalkSender.send`, preserving platform message/query handles
 * (`processQueryKey` / `target`) for future recall, read-receipt inspection, or AI Card updates.
 */
export interface DingTalkSendResult extends ConnectorSendResult {
  readonly messageId?: string;
  readonly channel: "sessionWebhook" | "oToMessages" | "groupMessages";
  readonly target: DingTalkResolvedTarget;
  readonly raw: unknown;
}

/**
 * Cached `sessionWebhook` entry recorded from inbound robot callbacks.
 */
export interface DingTalkSessionWebhookRecord {
  readonly sessionWebhook: string;
  readonly expiresAt: number;
}

/**
 * Stream subscription item for `POST /v1.0/gateway/connections/open`.
 *
 * @see https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
 */
export interface DingTalkStreamSubscription {
  readonly type:
    | typeof DINGTALK_STREAM_SUBSCRIPTION_CALLBACK
    | typeof DINGTALK_STREAM_SUBSCRIPTION_EVENT;
  readonly topic: string;
}

/**
 * Minimal WebSocket client contract aligned with Node.js 24 native global `WebSocket`,
 * enabling deterministic unit testing without network sockets.
 */
export interface DingTalkMessageEventLike {
  readonly data: unknown;
}

export interface DingTalkCloseEventLike {
  readonly code?: number;
  readonly reason?: string;
}

export interface DingTalkWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: DingTalkMessageEventLike & DingTalkCloseEventLike) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: DingTalkMessageEventLike & DingTalkCloseEventLike) => void,
  ): void;
}

export type DingTalkCreateWebSocketFn = (url: string) => DingTalkWebSocketLike;

export type DingTalkInboundMode = "stream" | "webhook" | "both" | "none";

/**
 * Configuration options for `DingTalkConnector` / `createDingTalkConnector`.
 *
 * @see https://open.dingtalk.com/document/development/server-api-calling-guide.md
 * @see https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 */
export interface DingTalkConnectorOptions<
  TName extends string = typeof DEFAULT_DINGTALK_CONNECTOR_NAME,
> {
  readonly name?: TName;
  readonly displayName?: string;
  readonly description?: string;

  /**
   * DingTalk internal app `Client ID` (`AppKey`) or third-party `SuiteKey`.
   * Required for OAuth2 `accessToken`, Stream mode, and proactive OpenAPI messaging.
   */
  readonly clientId?: string;
  /**
   * DingTalk internal app `Client Secret` (`AppSecret`) or third-party `SuiteSecret`.
   */
  readonly clientSecret?: string;
  /**
   * Enterprise robot `robotCode` (defaults to `clientId` when omitted).
   */
  readonly robotCode?: string;
  /**
   * Optional default `coolAppCode` for group CoolApp robot messages.
   */
  readonly coolAppCode?: string;

  /**
   * Optional secret override for HTTP Outgoing `timestamp` + `sign` HMAC-SHA256 verification.
   * Defaults to `clientSecret` when omitted.
   */
  readonly webhookSigningSecret?: string;
  /**
   * Optional token for Custom Robot Outgoing `token` header verification.
   */
  readonly outgoingToken?: string;
  /**
   * Maximum allowed clock skew in milliseconds for Outgoing `timestamp` header (defaults to 3,600,000ms = 1h).
   */
  readonly maxWebhookSkewMs?: number;

  /**
   * Inbound transport mode:
   * - `"stream"`: connect via DingTalk Stream WebSocket in `start()` (`handleWebhook` still works if secret/token present)
   * - `"webhook"`: HTTP Outgoing webhook only (`start()` does not open Stream WebSocket)
   * - `"both"`: enable both Stream WebSocket and HTTP Outgoing webhook
   * - `"none"`: outbound send only (`getReceiver()` returns `undefined`)
   * Defaults to `"stream"` when `clientId` & `clientSecret` are provided, or `"webhook"` otherwise.
   */
  readonly inboundMode?: DingTalkInboundMode;

  /**
   * Prefer replying via cached unexpired `sessionWebhook` before calling proactive OpenAPI endpoints.
   * Defaults to `false` when `clientId` & `clientSecret` are configured, or `true` in webhook-only mode.
   */
  readonly preferSessionWebhook?: boolean;

  /**
   * Default outbound format when `params.format` is omitted (`"text"` by default).
   */
  readonly defaultFormat?: "text" | "markdown";
  /**
   * Optional context marker prepended to outbound text (`false` by default for clean IM messages).
   */
  readonly contextMarker?: ContextMarkerStyle | false;

  /**
   * Optional bot `chatbotUserId` / `senderId` values to filter self-originated messages.
   */
  readonly botUserIds?: readonly string[];
  /**
   * Optional bot `staffId` values to filter self-originated messages.
   */
  readonly botStaffIds?: readonly string[];
  /**
   * Require `isInAtList === true` for group messages (`false` by default since DingTalk already gates `@bot`).
   */
  readonly requireAtInGroup?: boolean;

  /**
   * Extra Stream subscriptions in addition to `/v1.0/im/bot/messages/get`.
   */
  readonly streamSubscriptions?: readonly DingTalkStreamSubscription[];
  readonly streamUserAgent?: string;
  readonly localIp?: string;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly autoReconnect?: boolean;

  /**
   * Base URL override for DingTalk OpenAPI (`https://api.dingtalk.com` by default).
   */
  readonly apiBaseUrl?: string;
  readonly httpTimeoutMs?: number;
  readonly wsHandshakeTimeoutMs?: number;

  /**
   * Injectable transport & clock hooks for deterministic unit testing and custom runtimes.
   */
  readonly fetchFn?: typeof fetch;
  readonly createWebSocket?: DingTalkCreateWebSocketFn;
  readonly now?: () => number;
  readonly logger?: ConnectorLogger;

  /**
   * Reserved streaming configuration and adapter slots for DingTalk AI Card / Interactive Card streaming.
   *
   * @see https://open.dingtalk.com/document/development/api-streamingupdate.md
   */
  readonly streaming?: DingTalkStreamingOptions<TName>;
  readonly streamingAdapter?: DingTalkStreamingAdapter<TName>;
}
