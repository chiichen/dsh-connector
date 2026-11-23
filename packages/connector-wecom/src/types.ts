import { z } from "zod";
import type { ConnectorLogger, ConnectorSendResult, ContextMarkerStyle } from "@dsh-connector/core";
import type { WeComStreamingAdapter, WeComStreamingOptions } from "./streaming";

/**
 * Outbound delivery channels supported by `@dsh-connector/connector-wecom`:
 * - `app`: Self-built enterprise application (`POST /cgi-bin/message/send`)
 * - `appchat`: Application-managed group chat (`POST /cgi-bin/appchat/send`)
 * - `webhook`: Group custom webhook bot (`POST /cgi-bin/webhook/send?key=...`)
 * - `aibot`: Intelligent bot via WebSocket (`aibot_send_msg` / `aibot_respond_msg`) or `response_url`
 *
 * @see https://developer.work.weixin.qq.com/document/path/96458
 * @see https://developer.work.weixin.qq.com/document/path/90248
 * @see https://developer.work.weixin.qq.com/document/path/99110
 * @see https://developer.work.weixin.qq.com/document/path/101138
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export const wecomChannelSchema = z.enum(["app", "appchat", "webhook", "aibot"]);
export type WeComOutboundChannel = z.infer<typeof wecomChannelSchema>;

export const wecomMessageFormatSchema = z.enum(["text", "markdown", "markdown_v2"]);
export type WeComMessageFormat = z.infer<typeof wecomMessageFormatSchema>;

/**
 * Unified outbound sender Zod schema.
 * Uses `text` as the primary required content field for host auto-reply compatibility,
 * keeping all platform target fields optional for 3-tier target resolution.
 */
export const wecomSendSchema = z.object({
  text: z.string().min(1).describe("Message content (UTF-8 text or Markdown) to send via WeCom."),
  channel: wecomChannelSchema
    .optional()
    .describe("Explicit WeCom delivery channel (`app`, `appchat`, `webhook`, or `aibot`)."),
  toUser: z
    .string()
    .min(1)
    .optional()
    .describe("Recipient UserID list (`UserID1|UserID2` or `@all`) for `app` or single `aibot`."),
  toParty: z
    .string()
    .min(1)
    .optional()
    .describe("Recipient PartyID list (`PartyID1|PartyID2`) for self-built `app` messages."),
  toTag: z
    .string()
    .min(1)
    .optional()
    .describe("Recipient TagID list (`TagID1|TagID2`) for self-built `app` messages."),
  chatId: z
    .string()
    .min(1)
    .optional()
    .describe("Group `chatid` for `appchat` or `aibot` group/single session."),
  webhookKey: z
    .string()
    .min(1)
    .optional()
    .describe("Group webhook bot `key` query parameter for `/cgi-bin/webhook/send`."),
  responseUrl: z
    .string()
    .min(1)
    .optional()
    .describe("Temporary 1-hour single-use `response_url` from an Intelligent Bot HTTP callback."),
  reqId: z
    .string()
    .min(1)
    .optional()
    .describe("Inbound WebSocket `req_id` for `aibot_respond_msg` reply correlation."),
  format: wecomMessageFormatSchema
    .optional()
    .describe("Message format (`text`, `markdown`, or `markdown_v2` for group webhooks)."),
  mentionedList: z
    .array(z.string().min(1))
    .optional()
    .describe("UserIDs to mention (`@all` supported) in `appchat` or `webhook` text messages."),
  mentionedMobileList: z
    .array(z.string().min(1))
    .optional()
    .describe("Mobile numbers to mention (`@all` supported) in `webhook` text messages."),
  safe: z
    .boolean()
    .optional()
    .describe(
      "Whether to enable confidential watermark protection (`safe: 1`) on `app`/`appchat`.",
    ),
  includeContextMarker: z
    .boolean()
    .optional()
    .describe("Whether to prepend the DSH session context marker line to the outbound text."),
});

export type WeComSendParams = z.output<typeof wecomSendSchema>;
export type WeComSendInput = z.input<typeof wecomSendSchema>;

export const wecomInboundSourceSchema = z.enum(["app-webhook", "aibot-webhook", "aibot-ws"]);
export type WeComInboundSource = z.infer<typeof wecomInboundSourceSchema>;

/**
 * Normalized inbound message schema produced by WeCom HTTP callbacks and WebSocket frames.
 *
 * @see https://developer.work.weixin.qq.com/document/path/90239 Self-built app message XML format
 * @see https://developer.work.weixin.qq.com/document/path/100719 Intelligent bot HTTP callback JSON format
 * @see https://developer.work.weixin.qq.com/document/path/101463 Intelligent bot WebSocket callback format
 */
export const wecomReceiveSchema = z.object({
  source: wecomInboundSourceSchema,
  messageId: z.string().min(1),
  msgType: z.string().min(1),
  senderId: z.string().min(1),
  chatType: z.enum(["single", "group"]),
  chatId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  text: z.string(),
  quotedText: z.string().optional(),
  mediaUrl: z.string().optional(),
  mediaId: z.string().optional(),
  responseUrl: z.string().optional(),
  reqId: z.string().optional(),
  createdAt: z.number().optional(),
});

export type WeComReceiveParams = z.output<typeof wecomReceiveSchema>;
export type WeComReceiveInput = z.input<typeof wecomReceiveSchema>;

/**
 * Structured `ConnectorSendResult` retaining WeCom platform handles (`messageId`, `channel`,
 * `target`, `reqId`, `streamId`, `responseCode`, `chunkCount`, and `raw` provider response)
 * so future streaming / template-card updates can operate in-place without breaking callers.
 */
export interface WeComSendResult extends ConnectorSendResult {
  readonly messageId?: string;
  readonly channel: WeComOutboundChannel;
  readonly target: string;
  readonly chunkCount: number;
  readonly reqId?: string;
  readonly streamId?: string;
  readonly responseCode?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * Self-built Enterprise WeChat application credentials.
 *
 * @see https://developer.work.weixin.qq.com/document/path/91039
 * @see https://developer.work.weixin.qq.com/document/path/96458
 */
export interface WeComAppCredentials {
  readonly corpId: string;
  readonly corpSecret: string;
  readonly agentId: number | string;
  readonly apiBaseUrl?: string;
  readonly enableDuplicateCheck?: boolean;
  readonly duplicateCheckIntervalSeconds?: number;
}

/**
 * Group custom webhook bot configuration.
 *
 * @see https://developer.work.weixin.qq.com/document/path/99110
 */
export interface WeComWebhookCredentials {
  readonly apiBaseUrl?: string;
}

/**
 * HTTP callback verification and AES-256-CBC decryption configuration.
 * - For self-built apps, `receiveId` defaults to `app.corpId` (or explicit `receiveId`).
 * - For Intelligent Bots, official WeCom specification sets `receiveId` to `""` (empty string).
 *
 * @see https://developer.work.weixin.qq.com/document/path/90930
 * @see https://developer.work.weixin.qq.com/document/path/91144
 * @see https://developer.work.weixin.qq.com/document/path/101033
 */
export interface WeComCallbackConfig {
  readonly token: string;
  readonly encodingAesKey: string;
  readonly receiveId?: string;
}

/**
 * Minimal standard WebSocket interface compatible with Node.js 24 global `WebSocket`
 * and deterministic in-memory test doubles.
 */
export interface WeComWebSocketMessageEvent {
  readonly data: string | ArrayBuffer | Uint8Array;
}

export interface WeComWebSocketCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

export interface WeComWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void, options?: { readonly once?: boolean }): void;
  addEventListener(
    type: "message",
    listener: (event: WeComWebSocketMessageEvent) => void,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "close",
    listener: (event: WeComWebSocketCloseEvent) => void,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "error",
    listener: (event: unknown) => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: string, listener: (...args: never[]) => void): void;
}

export type CreateWeComWebSocket = (url: string) => WeComWebSocketLike;

/**
 * Intelligent Bot (`智能机器人`) WebSocket long-connection configuration.
 *
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export interface WeComAibotWsConfig {
  readonly botId: string;
  readonly secret: string;
  readonly wsUrl?: string;
  readonly heartbeatIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly autoReconnect?: boolean;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly createWebSocket?: CreateWeComWebSocket;
}

/**
 * Configuration options for `WeComConnector` / `createWeComConnector`.
 */
export interface WeComConnectorOptions<TName extends string = "wecom"> {
  readonly name?: TName;
  readonly displayName?: string;
  readonly description?: string;
  readonly app?: WeComAppCredentials;
  readonly webhook?: WeComWebhookCredentials;
  readonly callback?: WeComCallbackConfig;
  readonly aibotWs?: WeComAibotWsConfig;
  readonly selfUserIds?: readonly string[];
  readonly botMentionNames?: readonly string[];
  readonly requireMentionInGroup?: boolean;
  readonly includeContextMarkerByDefault?: boolean;
  readonly contextMarkerStyle?: ContextMarkerStyle;
  readonly inboundDeliveryMode?: "queue" | "steer";
  readonly httpTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly logger?: ConnectorLogger;
  /**
   * Reserved streaming configuration seam (not invoked during non-streaming delivery).
   *
   * @see https://developer.work.weixin.qq.com/document/path/101031
   * @see https://developer.work.weixin.qq.com/document/path/101463
   */
  readonly streaming?: WeComStreamingOptions;
  /**
   * Direct streaming adapter slot shortcut (equivalent to `streaming.adapter`).
   */
  readonly streamingAdapter?: WeComStreamingAdapter;
}
