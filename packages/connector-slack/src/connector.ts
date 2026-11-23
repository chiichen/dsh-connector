import {
  assertValidConnectorName,
  ConnectorValidationError,
  defineConnector,
  type Connector,
  type ConnectorContext,
  type ConnectorInboundPrompt,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorSender,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import { SlackApiClient } from "./api-client";
import {
  DEFAULT_MAX_PARTICIPATING_THREADS,
  DEFAULT_SLACK_CONNECTOR_NAME,
  SLACK_CHANNEL_TYPE_IM,
} from "./constants";
import {
  slackReceiveSchema,
  type SlackReceiveParams,
  type SlackThreadReplyPolicy,
} from "./event-parser";
import { createSlackSender, type slackSendSchema, type SlackSendResult } from "./sender";
import { SlackSocketModeClient, type SlackWebSocketLike } from "./socket-mode";
import type { SlackStreamingAdapter, SlackStreamingOptions } from "./streaming";
import { dispatchSlackEventCallback, handleSlackEventsWebhook } from "./webhook";

export type SlackTransportMode = "socket" | "webhook" | "hybrid";

/**
 * Configuration options for `SlackConnector` / `createSlackConnector`.
 *
 * Supports:
 * - Events API HTTP Webhook mode (`signingSecret` + `botToken`)
 * - Socket Mode WebSocket mode (`appToken` + `botToken`)
 * - Hybrid mode (`appToken` + `signingSecret` + `botToken`)
 * - Reserved streaming extension slots (`streaming` / `streamingAdapter`)
 *
 * @see https://docs.slack.dev/apis/events-api/using-http-request-urls/
 * @see https://docs.slack.dev/apis/events-api/using-socket-mode/
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export interface SlackConnectorOptions<TName extends string = typeof DEFAULT_SLACK_CONNECTOR_NAME> {
  readonly name?: TName;
  readonly displayName?: string;
  readonly description?: string;

  /**
   * Slack Bot User OAuth Token (`xoxb-...`) with `chat:write` scope.
   */
  readonly botToken: string;

  /**
   * Slack Signing Secret used to verify `X-Slack-Signature` (`v0` HMAC-SHA256) on HTTP Webhooks.
   *
   * @see https://docs.slack.dev/authentication/verifying-requests-from-slack/
   */
  readonly signingSecret?: string;

  /**
   * Slack App-Level Token (`xapp-...`) with `connections:write` scope for Socket Mode.
   *
   * @see https://docs.slack.dev/reference/methods/apps.connections.open
   */
  readonly appToken?: string;

  /**
   * Inbound transport mode. Inferred automatically when omitted:
   * - `"socket"` when `appToken` is provided without `signingSecret`
   * - `"webhook"` when `signingSecret` is provided without `appToken`
   * - `"hybrid"` when both `appToken` and `signingSecret` are provided
   */
  readonly mode?: SlackTransportMode;

  readonly botUserId?: string;
  readonly appId?: string;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly signatureToleranceSeconds?: number;
  readonly nowSeconds?: () => number;
  readonly reconnectDelaysMs?: readonly number[];
  readonly threadReplyPolicy?: SlackThreadReplyPolicy;
  readonly maxParticipatingThreads?: number;
  readonly deliveryMode?: "queue" | "steer";
  readonly includeContextMarker?: boolean;
  readonly contextMarkerStyle?: ContextMarkerStyle;
  readonly ignoreHttpRetries?: boolean;
  readonly sanitizeBroadcastMentions?: boolean;
  readonly verifyAuthOnStart?: boolean;

  readonly fetchFn?: typeof fetch;
  readonly createWebSocket?: (url: string) => SlackWebSocketLike;

  /**
   * Reserved streaming configuration & adapter extension seam (`chat.update`,
   * `assistant.threads.setStatus`, `chat.startStream` / `chat.appendStream` / `chat.stopStream`).
   *
   * @see https://docs.slack.dev/reference/methods/chat.startStream
   * @see https://docs.slack.dev/reference/methods/chat.update
   */
  readonly streaming?: SlackStreamingOptions;
  readonly streamingAdapter?: SlackStreamingAdapter;
}

function resolveTransportMode(
  explicitMode: SlackTransportMode | undefined,
  hasAppToken: boolean,
  hasSigningSecret: boolean,
  connectorName: string,
): SlackTransportMode {
  if (explicitMode !== undefined) {
    if ((explicitMode === "socket" || explicitMode === "hybrid") && !hasAppToken) {
      throw new ConnectorValidationError(
        `SlackConnector "${connectorName}" mode "${explicitMode}" requires an appToken ("xapp-...").`,
        { connectorName },
      );
    }
    if ((explicitMode === "webhook" || explicitMode === "hybrid") && !hasSigningSecret) {
      throw new ConnectorValidationError(
        `SlackConnector "${connectorName}" mode "${explicitMode}" requires a signingSecret.`,
        { connectorName },
      );
    }
    return explicitMode;
  }

  if (hasAppToken && hasSigningSecret) {
    return "hybrid";
  }
  if (hasAppToken) {
    return "socket";
  }
  return "webhook";
}

/**
 * Slack bidirectional IM connector implementing `@dsh-connector/core`'s `Connector` contract.
 *
 * @see https://docs.slack.dev/apis/events-api/
 * @see https://docs.slack.dev/apis/events-api/using-socket-mode/
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export class SlackConnector<
  const TName extends string = typeof DEFAULT_SLACK_CONNECTOR_NAME,
> implements Connector<TName, typeof slackSendSchema, typeof slackReceiveSchema, SlackSendResult> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;
  readonly mode: SlackTransportMode;

  private readonly apiClient: SlackApiClient;
  private readonly sender: ConnectorSender<typeof slackSendSchema, SlackSendResult, TName>;
  private readonly receiver: ConnectorReceiver<typeof slackReceiveSchema, TName>;
  private readonly socketClient: SlackSocketModeClient | undefined;
  private readonly streamingOptions: SlackStreamingOptions | undefined;
  private readonly streamingAdapter: SlackStreamingAdapter | undefined;
  private readonly verifyAuthOnStart: boolean;
  private readonly participatingThreads = new Set<string>();

  private receiverContext: ConnectorReceiverContext<typeof slackReceiveSchema, TName> | undefined;
  private resolvedBotUserId: string | undefined;
  private resolvedAppId: string | undefined;

  constructor(options: SlackConnectorOptions<TName>) {
    const resolvedName = (options.name ?? DEFAULT_SLACK_CONNECTOR_NAME) as TName;
    assertValidConnectorName(resolvedName);
    this.name = resolvedName;
    this.displayName = options.displayName ?? "Slack";
    this.description =
      options.description ??
      "Send and receive Slack direct messages, channel @mentions, and threaded replies via Events API or Socket Mode.";

    const hasAppToken = Boolean(options.appToken && options.appToken.trim().length > 0);
    const hasSigningSecret = Boolean(
      options.signingSecret && options.signingSecret.trim().length > 0,
    );

    this.mode = resolveTransportMode(options.mode, hasAppToken, hasSigningSecret, resolvedName);
    this.resolvedBotUserId = options.botUserId?.trim() || undefined;
    this.resolvedAppId = options.appId?.trim() || undefined;
    this.streamingOptions = options.streaming;
    this.streamingAdapter = options.streamingAdapter ?? options.streaming?.adapter;
    this.verifyAuthOnStart =
      options.verifyAuthOnStart ?? (this.mode === "socket" || this.mode === "hybrid");

    this.apiClient = new SlackApiClient({
      connectorName: resolvedName,
      botToken: options.botToken,
      appToken: hasAppToken ? options.appToken : undefined,
      apiBaseUrl: options.apiBaseUrl,
      timeoutMs: options.timeoutMs,
      fetchFn: options.fetchFn,
      sanitizeBroadcastMentions: options.sanitizeBroadcastMentions,
    });

    const maxParticipatingThreads =
      options.maxParticipatingThreads ?? DEFAULT_MAX_PARTICIPATING_THREADS;

    const markParticipatingThread = (channelId: string, threadTs: string): void => {
      const key = `${channelId}:${threadTs}`;
      if (this.participatingThreads.has(key)) {
        this.participatingThreads.delete(key);
      } else if (this.participatingThreads.size >= maxParticipatingThreads) {
        const oldest = this.participatingThreads.values().next().value;
        if (oldest !== undefined) {
          this.participatingThreads.delete(oldest);
        }
      }
      this.participatingThreads.add(key);
    };

    const isParticipatingThread = (channelId: string, threadTs: string): boolean =>
      this.participatingThreads.has(`${channelId}:${threadTs}`);

    this.sender = createSlackSender({
      connectorName: resolvedName,
      apiClient: this.apiClient,
      includeContextMarker: options.includeContextMarker,
      contextMarkerStyle: options.contextMarkerStyle,
      onThreadActive: markParticipatingThread,
    });

    const dispatchConfig = {
      connectorName: resolvedName,
      getReceiverContext: () => this.receiverContext,
      getBotUserId: () => this.resolvedBotUserId,
      getExpectedAppId: () => this.resolvedAppId,
      threadReplyPolicy: options.threadReplyPolicy,
      deliveryMode: options.deliveryMode,
      isParticipatingThread,
      markParticipatingThread,
    };

    this.receiver = {
      schema: slackReceiveSchema,
      init: (ctx) => {
        this.receiverContext = ctx;
      },
      formatInbound: (
        params: SlackReceiveParams,
        _context: ConnectorContext<TName>,
      ): ConnectorInboundPrompt => {
        const isIm = params.channelType === SLACK_CHANNEL_TYPE_IM;
        const threadSuffix = params.threadTs !== undefined ? ` (${params.threadTs})` : "";
        const threadAttr = params.threadTs !== undefined ? ` thread_ts=${params.threadTs}` : "";
        const kindPrefix = isIm ? "Slack DM " : "Slack ";
        const headerTag = isIm ? "Slack DM" : "Slack";

        return {
          title: isIm
            ? `${kindPrefix}${params.channelId}`
            : `${kindPrefix}${params.channelId}${threadSuffix}`,
          text: `[${headerTag} channel=${params.channelId}${threadAttr} user=${params.userId} ts=${params.messageTs}]\n${params.text}`,
        };
      },
      handleWebhook: (req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> =>
        handleSlackEventsWebhook(req, {
          ...dispatchConfig,
          signingSecret: options.signingSecret,
          signatureToleranceSeconds: options.signatureToleranceSeconds,
          nowSeconds: options.nowSeconds,
          ignoreHttpRetries: options.ignoreHttpRetries,
        }),
    };

    if (this.mode === "socket" || this.mode === "hybrid") {
      this.socketClient = new SlackSocketModeClient({
        connectorName: resolvedName,
        apiClient: this.apiClient,
        getLogger: () => this.receiverContext?.logger,
        onHelloAppId: (appId) => {
          if (this.resolvedAppId === undefined) {
            this.resolvedAppId = appId;
          }
        },
        onEventCallback: async (payload) => {
          await dispatchSlackEventCallback(payload, dispatchConfig);
        },
        createWebSocket: options.createWebSocket,
        connectTimeoutMs: options.connectTimeoutMs,
        reconnectDelaysMs: options.reconnectDelaysMs,
      });
    }
  }

  getSender(): ConnectorSender<typeof slackSendSchema, SlackSendResult, TName> {
    return this.sender;
  }

  getReceiver(): ConnectorReceiver<typeof slackReceiveSchema, TName> {
    return this.receiver;
  }

  /**
   * Reserved accessor for the optional Slack streaming / in-place message update adapter.
   */
  getStreamingAdapter(): SlackStreamingAdapter | undefined {
    return this.streamingAdapter;
  }

  /**
   * Reserved accessor for optional Slack streaming configuration.
   */
  getStreamingOptions(): SlackStreamingOptions | undefined {
    return this.streamingOptions;
  }

  async start(): Promise<void> {
    if (this.verifyAuthOnStart && this.resolvedBotUserId === undefined) {
      const identity = await this.apiClient.authTest();
      this.resolvedBotUserId = identity.user_id;
    }

    if (this.socketClient !== undefined) {
      await this.socketClient.start();
    }
  }

  async stop(): Promise<void> {
    if (this.socketClient !== undefined) {
      await this.socketClient.stop();
    }
  }
}

/**
 * Factory function creating a typed `SlackConnector` instance.
 */
export function createSlackConnector<
  const TName extends string = typeof DEFAULT_SLACK_CONNECTOR_NAME,
>(options: SlackConnectorOptions<TName>): SlackConnector<TName> {
  const instance = new SlackConnector(options);
  defineConnector(instance);
  return instance;
}
