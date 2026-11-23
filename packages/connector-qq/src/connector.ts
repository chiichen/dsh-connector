import {
  assertValidConnectorName,
  defineConnector,
  type Connector,
  type ConnectorReceiver,
  type ConnectorSender,
} from "@dsh-connector/core";
import { QqAccessTokenManager } from "./auth";
import {
  QQ_DEFAULT_API_BASE_URL,
  QQ_DEFAULT_CONNECTOR_NAME,
  QQ_DEFAULT_DESCRIPTION,
  QQ_DEFAULT_DISPLAY_NAME,
  QQ_DEFAULT_INTENTS,
  QQ_DEFAULT_REQUEST_TIMEOUT_MS,
  QQ_DEFAULT_SHARD,
  QQ_DEFAULT_TOKEN_URL,
  QQ_SANDBOX_API_BASE_URL,
} from "./constants";
import { QqGatewayClient, type QqWebSocketFactory } from "./gateway";
import { QqEventReceiver } from "./receiver";
import { QqMessageSender, QqPassiveReplyTracker } from "./sender";
import type { QqStreamingAdapter, QqStreamingOptions } from "./streaming";
import { qqReceiveSchema, qqSendSchema, type QqMessageFormat, type QqSendResult } from "./types";

/**
 * Inbound transport mode for `QqConnector`:
 * - `"webhook"` (default): Receives HTTP Webhook callbacks via `handleWebhook` (`OpCode 13` + Ed25519 `OpCode 0`).
 * - `"websocket"`: Connects to QQ WebSocket Gateway during `start()` / `stop()`.
 * - `"both"`: Enables both WebSocket Gateway and HTTP Webhook handler.
 */
export type QqTransportMode = "webhook" | "websocket" | "both";

/**
 * Configuration options for `@dsh-connector/connector-qq`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html
 */
export interface QqConnectorOptions<TName extends string = typeof QQ_DEFAULT_CONNECTOR_NAME> {
  readonly name?: TName;
  readonly displayName?: string;
  readonly description?: string;
  readonly appId: string;
  readonly clientSecret: string;
  readonly botUserId?: string;
  readonly sandbox?: boolean;
  readonly apiBaseUrl?: string;
  readonly tokenUrl?: string;
  readonly gatewayUrl?: string;
  readonly transport?: QqTransportMode;
  readonly intents?: number;
  readonly shard?: readonly [number, number];
  readonly defaultFormat?: QqMessageFormat;
  readonly includeContextMarker?: boolean;
  readonly autoPassiveReply?: boolean;
  readonly fallbackToPlainOnMarkdownReject?: boolean;
  readonly requestTimeoutMs?: number;
  readonly tokenRefreshBufferMs?: number;
  readonly reconnectDelaysMs?: readonly number[];
  readonly maxReconnectAttempts?: number;
  readonly fetchFn?: typeof fetch;
  readonly createWebSocket?: QqWebSocketFactory;
  readonly now?: () => number;

  /**
   * Reserved configuration options for future C2C `stream_messages` and multi-segment
   * passive `msg_seq` streaming support.
   *
   * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
   */
  readonly streaming?: QqStreamingOptions;

  /**
   * Reserved adapter injection slot for future streaming / rich-media / Markdown turn updates.
   */
  readonly streamingAdapter?: QqStreamingAdapter;
}

/**
 * Official QQ Bot Open Platform bidirectional connector implementing `@dsh-connector/core` `Connector`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 */
export class QqConnector<
  const TName extends string = typeof QQ_DEFAULT_CONNECTOR_NAME,
> implements Connector<TName, typeof qqSendSchema, typeof qqReceiveSchema, QqSendResult> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;
  readonly streamingOptions: QqStreamingOptions | undefined;

  private readonly transport: QqTransportMode;
  private readonly tokenManager: QqAccessTokenManager;
  private readonly passiveTracker: QqPassiveReplyTracker;
  private readonly messageSender: QqMessageSender<TName>;
  private readonly eventReceiver: QqEventReceiver<TName>;
  private readonly gatewayClient: QqGatewayClient | undefined;
  private readonly streamingAdapter: QqStreamingAdapter | undefined;

  private readonly senderCapability: ConnectorSender<typeof qqSendSchema, QqSendResult, TName>;
  private readonly receiverCapability: ConnectorReceiver<typeof qqReceiveSchema, TName>;

  constructor(options: QqConnectorOptions<TName>) {
    const resolvedName = (options.name ?? QQ_DEFAULT_CONNECTOR_NAME) as TName;
    assertValidConnectorName(resolvedName);

    this.name = resolvedName;
    this.displayName = options.displayName ?? QQ_DEFAULT_DISPLAY_NAME;
    this.description = options.description ?? QQ_DEFAULT_DESCRIPTION;
    this.transport = options.transport ?? "webhook";
    this.streamingOptions = options.streaming;
    this.streamingAdapter = options.streamingAdapter;

    const resolvedApiBaseUrl =
      options.apiBaseUrl ??
      (options.sandbox === true ? QQ_SANDBOX_API_BASE_URL : QQ_DEFAULT_API_BASE_URL);

    this.tokenManager = new QqAccessTokenManager({
      appId: options.appId,
      clientSecret: options.clientSecret,
      connectorName: resolvedName,
      tokenUrl: options.tokenUrl ?? QQ_DEFAULT_TOKEN_URL,
      ...(options.tokenRefreshBufferMs !== undefined
        ? { refreshBufferMs: options.tokenRefreshBufferMs }
        : {}),
      requestTimeoutMs: options.requestTimeoutMs ?? QQ_DEFAULT_REQUEST_TIMEOUT_MS,
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    this.passiveTracker = new QqPassiveReplyTracker();

    this.messageSender = new QqMessageSender<TName>({
      connectorName: resolvedName,
      tokenManager: this.tokenManager,
      passiveTracker: this.passiveTracker,
      apiBaseUrl: resolvedApiBaseUrl,
      ...(options.defaultFormat !== undefined ? { defaultFormat: options.defaultFormat } : {}),
      ...(options.includeContextMarker !== undefined
        ? { includeContextMarker: options.includeContextMarker }
        : {}),
      ...(options.autoPassiveReply !== undefined
        ? { autoPassiveReply: options.autoPassiveReply }
        : {}),
      ...(options.fallbackToPlainOnMarkdownReject !== undefined
        ? { fallbackToPlainOnMarkdownReject: options.fallbackToPlainOnMarkdownReject }
        : {}),
      requestTimeoutMs: options.requestTimeoutMs ?? QQ_DEFAULT_REQUEST_TIMEOUT_MS,
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });

    this.eventReceiver = new QqEventReceiver<TName>({
      connectorName: resolvedName,
      appId: options.appId,
      clientSecret: options.clientSecret,
      ...(options.botUserId !== undefined ? { botUserId: options.botUserId } : {}),
      passiveTracker: this.passiveTracker,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    if (this.transport === "websocket" || this.transport === "both") {
      this.gatewayClient = new QqGatewayClient({
        connectorName: resolvedName,
        tokenManager: this.tokenManager,
        receiver: this.eventReceiver,
        apiBaseUrl: resolvedApiBaseUrl,
        ...(options.gatewayUrl !== undefined ? { gatewayUrl: options.gatewayUrl } : {}),
        intents: options.intents ?? QQ_DEFAULT_INTENTS,
        shard: options.shard ?? QQ_DEFAULT_SHARD,
        ...(options.reconnectDelaysMs !== undefined
          ? { reconnectDelaysMs: options.reconnectDelaysMs }
          : {}),
        ...(options.maxReconnectAttempts !== undefined
          ? { maxReconnectAttempts: options.maxReconnectAttempts }
          : {}),
        requestTimeoutMs: options.requestTimeoutMs ?? QQ_DEFAULT_REQUEST_TIMEOUT_MS,
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
        ...(options.createWebSocket !== undefined
          ? { createWebSocket: options.createWebSocket }
          : {}),
      });
    }

    this.senderCapability = {
      description: this.description,
      schema: qqSendSchema,
      send: (context, params, sendOptions) => this.messageSender.send(context, params, sendOptions),
    };

    const enableWebhook = this.transport === "webhook" || this.transport === "both";
    this.receiverCapability = {
      schema: qqReceiveSchema,
      init: (ctx) => this.eventReceiver.init(ctx),
      formatInbound: (params, context) => this.eventReceiver.formatInbound(params, context),
      ...(enableWebhook
        ? {
            handleWebhook: (req) => this.eventReceiver.handleWebhook(req),
          }
        : {}),
    };
  }

  getSender(): ConnectorSender<typeof qqSendSchema, QqSendResult, TName> {
    return this.senderCapability;
  }

  getReceiver(): ConnectorReceiver<typeof qqReceiveSchema, TName> {
    return this.receiverCapability;
  }

  /**
   * Returns the optional streaming extension adapter if configured.
   */
  getStreamingAdapter(): QqStreamingAdapter | undefined {
    return this.streamingAdapter;
  }

  async start(): Promise<void> {
    if (this.gatewayClient !== undefined) {
      await this.gatewayClient.start();
    }
  }

  async stop(): Promise<void> {
    if (this.gatewayClient !== undefined) {
      await this.gatewayClient.stop();
    }
  }
}

/**
 * Factory function creating a typed `QqConnector` instance.
 */
export function createQqConnector<const TName extends string = typeof QQ_DEFAULT_CONNECTOR_NAME>(
  options: QqConnectorOptions<TName>,
): QqConnector<TName> {
  const connector = new QqConnector(options);
  defineConnector(connector);
  return connector;
}
