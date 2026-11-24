/**
 * Enterprise WeChat (WeCom) `Connector` implementation (`WeComConnector` & `createWeComConnector`).
 *
 * Unifies:
 * - Self-Built Application (`app` / `appchat`) HTTP callback reception + REST `gettoken` / `message/send` / `appchat/send`
 * - Group Custom Webhook Bot (`webhook/send?key=...`) outbound notifications
 * - Intelligent Bot (`智能机器人` / `aibot`) HTTP encrypted JSON callbacks (`response_url`) and WebSocket long connection (`wss://openws.work.weixin.qq.com/`)
 * - Reserved streaming extension seam (`WeComStreamingAdapter` / `getStreamingAdapter()`)
 *
 * @see https://developer.work.weixin.qq.com/document/path/90930 Self-built app callback configuration
 * @see https://developer.work.weixin.qq.com/document/path/96458 Self-built app message sending
 * @see https://developer.work.weixin.qq.com/document/path/90248 App group chat message sending
 * @see https://developer.work.weixin.qq.com/document/path/99110 Group webhook bot message sending
 * @see https://developer.work.weixin.qq.com/document/path/100719 Intelligent bot HTTP callback
 * @see https://developer.work.weixin.qq.com/document/path/101031 Intelligent bot passive stream reply
 * @see https://developer.work.weixin.qq.com/document/path/101463 Intelligent bot WebSocket long connection
 */

import {
  assertValidConnectorName,
  type Connector,
  type ConnectorLogger,
  type ConnectorReceiver,
  type ConnectorSender,
} from "@dsh-connector/core";
import { WeComApiClient } from "./api-client";
import {
  DEFAULT_WECOM_CONNECTOR_NAME,
  DEFAULT_WECOM_DESCRIPTION,
  DEFAULT_WECOM_DISPLAY_NAME,
} from "./constants";
import { WeComReceiver } from "./receiver";
import { WeComSender } from "./sender";
import { resolveWeComStreamingAdapter, type WeComStreamingAdapter } from "./streaming";
import type {
  WeComConnectorOptions,
  WeComSendResult,
  wecomReceiveSchema,
  wecomSendSchema,
} from "./types";
import { WeComAibotWsClient } from "./ws-client";

export class WeComConnector<const TName extends string = "wecom"> implements Connector<
  TName,
  typeof wecomSendSchema,
  typeof wecomReceiveSchema,
  WeComSendResult
> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;

  private readonly apiClient: WeComApiClient;
  private readonly wsClient: WeComAibotWsClient | undefined;
  private readonly receiver: WeComReceiver<TName> | undefined;
  private readonly sender: WeComSender<TName>;
  private readonly streamingAdapter: WeComStreamingAdapter | undefined;
  private readonly hostLogger: ConnectorLogger | undefined;

  constructor(options: WeComConnectorOptions<TName> = {}) {
    const resolvedName = (options.name ?? DEFAULT_WECOM_CONNECTOR_NAME) as TName;
    assertValidConnectorName(resolvedName);
    this.name = resolvedName;
    this.hostLogger = options.logger;
    this.displayName = options.displayName ?? DEFAULT_WECOM_DISPLAY_NAME;
    this.description = options.description ?? DEFAULT_WECOM_DESCRIPTION;
    this.streamingAdapter = resolveWeComStreamingAdapter(options);

    this.apiClient = new WeComApiClient({
      connectorName: resolvedName,
      ...(options.app !== undefined ? { app: options.app } : {}),
      ...(options.webhook !== undefined ? { webhook: options.webhook } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      ...(options.httpTimeoutMs !== undefined ? { timeoutMs: options.httpTimeoutMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    const hasInboundTransport = options.callback !== undefined || options.aibotWs !== undefined;
    this.receiver = hasInboundTransport
      ? new WeComReceiver<TName>({
          connectorName: resolvedName,
          ...(options.app?.corpId !== undefined ? { appCorpId: options.app.corpId } : {}),
          ...(options.app?.agentId !== undefined ? { appAgentId: options.app.agentId } : {}),
          ...(options.aibotWs?.botId !== undefined ? { aibotId: options.aibotWs.botId } : {}),
          ...(options.callback !== undefined ? { callback: options.callback } : {}),
          ...(options.selfUserIds !== undefined ? { selfUserIds: options.selfUserIds } : {}),
          ...(options.botMentionNames !== undefined
            ? { botMentionNames: options.botMentionNames }
            : {}),
          ...(options.requireMentionInGroup !== undefined
            ? { requireMentionInGroup: options.requireMentionInGroup }
            : {}),
          ...(options.inboundDeliveryMode !== undefined
            ? { inboundDeliveryMode: options.inboundDeliveryMode }
            : {}),
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(this.streamingAdapter !== undefined
            ? { streamingAdapter: this.streamingAdapter }
            : {}),
        })
      : undefined;

    this.wsClient =
      options.aibotWs !== undefined
        ? new WeComAibotWsClient({
            connectorName: resolvedName,
            config: options.aibotWs,
            ...(this.hostLogger !== undefined ? { logger: this.hostLogger } : {}),
            onMessageCallback: async (frame) => {
              await this.receiver?.ingestWsMessageCallback(frame);
            },
          })
        : undefined;

    const defaultConversationChannel: "app" | "aibot" =
      options.app === undefined && (options.aibotWs !== undefined || options.callback !== undefined)
        ? "aibot"
        : "app";

    this.sender = new WeComSender<TName>({
      connectorName: resolvedName,
      apiClient: this.apiClient,
      defaultConversationChannel,
      ...(this.wsClient !== undefined ? { aibotTransport: this.wsClient } : {}),
      ...(this.receiver !== undefined
        ? {
            consumeCachedResponseUrl: (contextId) =>
              this.receiver?.consumeCachedResponseUrl(contextId),
          }
        : {}),
      ...(options.includeContextMarkerByDefault !== undefined
        ? { includeContextMarkerByDefault: options.includeContextMarkerByDefault }
        : {}),
      ...(options.contextMarkerStyle !== undefined
        ? { contextMarkerStyle: options.contextMarkerStyle }
        : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
    });
  }

  getSender(): ConnectorSender<typeof wecomSendSchema, WeComSendResult, TName> {
    return this.sender;
  }

  getReceiver(): ConnectorReceiver<typeof wecomReceiveSchema, TName> | undefined {
    return this.receiver;
  }

  /**
   * Returns the optional streaming extension adapter when configured (`undefined` by default).
   *
   * @see https://developer.work.weixin.qq.com/document/path/101031
   * @see https://developer.work.weixin.qq.com/document/path/101463
   */
  getStreamingAdapter(): WeComStreamingAdapter | undefined {
    return this.streamingAdapter;
  }

  getApiClient(): WeComApiClient {
    return this.apiClient;
  }

  getWsClient(): WeComAibotWsClient | undefined {
    return this.wsClient;
  }

  async start(): Promise<void> {
    if (this.wsClient !== undefined) {
      await this.wsClient.start();
    }
  }

  async stop(): Promise<void> {
    if (this.wsClient !== undefined) {
      await this.wsClient.stop();
    }
  }
}

export function createWeComConnector<const TName extends string = "wecom">(
  options?: WeComConnectorOptions<TName>,
): WeComConnector<TName> {
  return new WeComConnector(options);
}
