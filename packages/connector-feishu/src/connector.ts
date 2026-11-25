/**
 * Main `FeishuConnector` class and `createFeishuConnector` factory implementing
 * `@dsh-connector/core`'s `Connector` contract for Feishu / Lark.
 *
 * Supports:
 * - Outbound REST messaging (`POST /open-apis/im/v1/messages` & `:message_id/reply`)
 *   with automatic `tenant_access_token` refresh and 3-tier target addressing.
 * - Inbound HTTP Webhook v2.0 (`url_verification`, AES-256-CBC `encryptKey` decryption,
 *   `X-Lark-Signature` verification, `im.message.receive_v1`).
 * - Optional persistent WebSocket long connection (`POST /callback/ws/endpoint` + `pbbp2` binary frames).
 * - Reserved streaming extension slots (`FeishuStreamingOptions` / `FeishuStreamingAdapter`)
 *   for future CardKit v1 streaming card updates and `PATCH /open-apis/im/v1/messages/:message_id`.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 */

import {
  assertValidConnectorName,
  type Connector,
  type ConnectorLogger,
  type ConnectorReceiver,
  type ConnectorSender,
} from "@dsh-connector/core";
import {
  DEFAULT_FEISHU_CONNECTOR_NAME,
  DEFAULT_FEISHU_DESCRIPTION,
  DEFAULT_FEISHU_DISPLAY_NAME,
} from "./constants";
import type {
  FeishuContextMarkerPolicy,
  FeishuOutboundFormat,
  feishuReceiveSchema,
  feishuSendSchema,
} from "./context";
import { FeishuApiClient } from "./api-client";
import { createFeishuSender, type FeishuSendResult } from "./sender";
import { createFeishuReceiver, type FeishuReceiverRuntime } from "./receiver";
import type { FeishuGroupMentionPolicy } from "./message-parser";
import { FeishuWsLongConnectionClient, type FeishuWebSocketFactory } from "./ws-client";
import {
  resolveFeishuStreamingAdapter,
  type FeishuStreamingAdapter,
  type FeishuStreamingOptions,
} from "./streaming";

export type FeishuReceiveMode = "webhook" | "websocket" | "both";

/**
 * Configuration options for `FeishuConnector` / `createFeishuConnector`.
 *
 * @see https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 */
export interface FeishuConnectorOptions<
  TName extends string = typeof DEFAULT_FEISHU_CONNECTOR_NAME,
> {
  readonly name?: TName;
  readonly displayName?: string;
  readonly description?: string;
  readonly sendDescription?: string;

  /** Feishu custom application App ID (e.g. `cli_...`). */
  readonly appId: string;
  /** Feishu custom application App Secret. */
  readonly appSecret: string;
  /** `"feishu"` (`https://open.feishu.cn`), `"lark"` (`https://open.larksuite.com`), or custom HTTPS base URL. */
  readonly domain?: "feishu" | "lark" | (string & {});

  /** Optional Feishu Verification Token for Webhook authenticity check. */
  readonly verificationToken?: string;
  /** Optional Feishu Encrypt Key for Webhook AES-256-CBC decryption and `X-Lark-Signature` verification. */
  readonly encryptKey?: string;

  /** Optional Bot `open_id` (`ou_...`) for exact `@bot` mention matching and self-message filtering. */
  readonly botOpenId?: string;
  /** Optional Bot display name fallback for `@bot` mention matching. */
  readonly botName?: string;
  /** Optional allowlist of sender `open_id`s (`["*"]` or omitted allows all tenant users). */
  readonly allowedOpenIds?: readonly string[];
  /** Group chat activation policy: `"mention-required"` (default) or `"all"`. */
  readonly groupMentionPolicy?: FeishuGroupMentionPolicy;
  /** Whether `@_all` (`@所有人`) counts as mentioning the bot in group chats (default `false`). */
  readonly allowAtAllInGroup?: boolean;

  /** Inbound transport mode: `"webhook"` (default), `"websocket"` (long connection), or `"both"`. */
  readonly mode?: FeishuReceiveMode;
  /** Fetch `GET /open-apis/bot/v3/info` during `start()` if `botOpenId` is unset (default `false`). */
  readonly resolveBotInfoOnStart?: boolean;
  /**
   * Accepted for existing configs. A reply reuses a session only when the event
   * text already contains a context id. `parent_id` is not fetched.
   */
  readonly resolveReplyContextFromParent?: boolean;

  /** Outbound context marker encoding policy: `"auto"` (default), `"always"`, or `"never"`. */
  readonly contextMarker?: FeishuContextMarkerPolicy;
  /** Default outbound format when `params.format` is omitted (`"text"` by default). */
  readonly defaultOutboundFormat?: FeishuOutboundFormat;

  readonly requestTimeoutMs?: number;
  readonly tokenRefreshBufferSeconds?: number;
  readonly wsHandshakeTimeoutMs?: number;
  readonly wsAutoReconnect?: boolean;

  /** Injectable HTTP `fetch` implementation (defaults to Node.js global `fetch`). */
  readonly fetchFn?: typeof fetch;
  /** Injectable clock function returning epoch milliseconds (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Injectable WebSocket constructor/factory for long-connection mode. */
  readonly createWebSocket?: FeishuWebSocketFactory;
  readonly logger?: ConnectorLogger;

  /** Reserved streaming configuration slot for future CardKit v1 / message card patch integration. */
  readonly streaming?: FeishuStreamingOptions<TName>;
  /** Direct shorthand slot for a `FeishuStreamingAdapter`. */
  readonly streamingAdapter?: FeishuStreamingAdapter<TName>;
}

export class FeishuConnector<
  const TName extends string = typeof DEFAULT_FEISHU_CONNECTOR_NAME,
> implements Connector<
  TName,
  typeof feishuSendSchema,
  typeof feishuReceiveSchema,
  FeishuSendResult
> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;
  readonly apiClient: FeishuApiClient;

  private readonly mode: FeishuReceiveMode;
  private readonly resolveBotInfoOnStart: boolean;
  private readonly sender: ConnectorSender<typeof feishuSendSchema, FeishuSendResult, TName>;
  private readonly receiverRuntime: FeishuReceiverRuntime<TName>;
  private readonly streamingAdapter: FeishuStreamingAdapter<TName> | undefined;
  private readonly hostLogger: ConnectorLogger | undefined;
  private readonly wsOptions: {
    readonly createWebSocket?: FeishuWebSocketFactory;
    readonly handshakeTimeoutMs?: number;
    readonly autoReconnect?: boolean;
    readonly now?: () => number;
  };

  private resolvedBotOpenId: string | undefined;
  private resolvedBotName: string | undefined;
  private wsClient: FeishuWsLongConnectionClient | undefined;

  constructor(options: FeishuConnectorOptions<TName>) {
    const resolvedName = (options.name ?? DEFAULT_FEISHU_CONNECTOR_NAME) as TName;
    assertValidConnectorName(resolvedName);

    this.name = resolvedName;
    this.hostLogger = options.logger;
    this.displayName = options.displayName ?? DEFAULT_FEISHU_DISPLAY_NAME;
    this.description = options.description ?? DEFAULT_FEISHU_DESCRIPTION;
    this.mode = options.mode ?? "webhook";
    this.resolveBotInfoOnStart = options.resolveBotInfoOnStart ?? false;
    this.resolvedBotOpenId = options.botOpenId?.trim() || undefined;
    this.resolvedBotName = options.botName?.trim() || undefined;

    this.apiClient = new FeishuApiClient({
      appId: options.appId,
      appSecret: options.appSecret,
      connectorName: resolvedName,
      ...(options.domain !== undefined ? { domain: options.domain } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.tokenRefreshBufferSeconds !== undefined
        ? { tokenRefreshBufferSeconds: options.tokenRefreshBufferSeconds }
        : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    this.sender = createFeishuSender<TName>({
      connectorName: this.name,
      apiClient: this.apiClient,
      ...(options.sendDescription !== undefined ? { description: options.sendDescription } : {}),
      ...(options.defaultOutboundFormat !== undefined
        ? { defaultOutboundFormat: options.defaultOutboundFormat }
        : {}),
      ...(options.contextMarker !== undefined ? { contextMarker: options.contextMarker } : {}),
    });

    this.receiverRuntime = createFeishuReceiver<TName>({
      connectorName: this.name,
      appId: options.appId,
      apiClient: this.apiClient,
      getBotOpenId: () => this.resolvedBotOpenId,
      getBotName: () => this.resolvedBotName,
      ...(options.verificationToken !== undefined
        ? { verificationToken: options.verificationToken }
        : {}),
      ...(options.encryptKey !== undefined ? { encryptKey: options.encryptKey } : {}),
      ...(options.allowedOpenIds !== undefined ? { allowedOpenIds: options.allowedOpenIds } : {}),
      ...(options.groupMentionPolicy !== undefined
        ? { groupMentionPolicy: options.groupMentionPolicy }
        : {}),
      ...(options.allowAtAllInGroup !== undefined
        ? { allowAtAllInGroup: options.allowAtAllInGroup }
        : {}),
      ...(options.resolveReplyContextFromParent !== undefined
        ? { resolveReplyContextFromParent: options.resolveReplyContextFromParent }
        : {}),
    });

    this.streamingAdapter = resolveFeishuStreamingAdapter(
      options.streaming,
      options.streamingAdapter,
    );

    this.wsOptions = {
      ...(options.createWebSocket !== undefined
        ? { createWebSocket: options.createWebSocket }
        : {}),
      ...(options.wsHandshakeTimeoutMs !== undefined
        ? { handshakeTimeoutMs: options.wsHandshakeTimeoutMs }
        : {}),
      ...(options.wsAutoReconnect !== undefined ? { autoReconnect: options.wsAutoReconnect } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    };
  }

  getSender(): ConnectorSender<typeof feishuSendSchema, FeishuSendResult, TName> {
    return this.sender;
  }

  getReceiver(): ConnectorReceiver<typeof feishuReceiveSchema, TName> {
    return this.receiverRuntime.receiver;
  }

  /**
   * Reserved extension accessor returning the configured `FeishuStreamingAdapter`
   * (or `undefined` when operating in standard non-streaming mode).
   */
  getStreamingAdapter(): FeishuStreamingAdapter<TName> | undefined {
    return this.streamingAdapter;
  }

  async start(): Promise<void> {
    if (this.resolveBotInfoOnStart && this.resolvedBotOpenId === undefined) {
      const botInfo = await this.apiClient.getBotInfo();
      this.resolvedBotOpenId = botInfo.openId;
      if (this.resolvedBotName === undefined && botInfo.appName !== undefined) {
        this.resolvedBotName = botInfo.appName;
      }
    }

    if (this.mode === "websocket" || this.mode === "both") {
      if (this.wsClient === undefined) {
        const logger = this.receiverRuntime.getReceiverContext()?.logger ?? this.hostLogger;
        this.wsClient = new FeishuWsLongConnectionClient({
          apiClient: this.apiClient,
          onEventEnvelope: async (envelope) => {
            await this.receiverRuntime.ingestEventEnvelope(envelope);
          },
          ...this.wsOptions,
          ...(logger !== undefined ? { logger } : {}),
        });
      }
      await this.wsClient.start();
    }
  }

  async stop(): Promise<void> {
    if (this.wsClient !== undefined) {
      this.wsClient.stop();
      this.wsClient = undefined;
    }
  }
}

/**
 * Factory function creating a typed `FeishuConnector` instance.
 */
export function createFeishuConnector<
  const TName extends string = typeof DEFAULT_FEISHU_CONNECTOR_NAME,
>(options: FeishuConnectorOptions<TName>): FeishuConnector<TName> {
  return new FeishuConnector(options);
}
