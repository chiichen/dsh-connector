import { assertValidConnectorName, defineConnector, type Connector } from "@dsh-connector/core";
import { DingTalkAccessTokenManager } from "./auth";
import {
  DEFAULT_DINGTALK_CONNECTOR_NAME,
  DEFAULT_DINGTALK_DESCRIPTION,
  DEFAULT_DINGTALK_DISPLAY_NAME,
} from "./constants";
import { SessionWebhookCache } from "./http";
import { DingTalkReceiver } from "./receiver";
import { DingTalkSender } from "./sender";
import type { DingTalkStreamingAdapter, DingTalkStreamingOptions } from "./streaming";
import type {
  dingTalkReceiveSchema,
  dingTalkSendSchema,
  DingTalkConnectorOptions,
  DingTalkInboundMode,
  DingTalkSendResult,
} from "./types";

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * DingTalk `Connector` implementation supporting:
 * - Stream WebSocket long connection (`POST /v1.0/gateway/connections/open` + robot callback ACK)
 * - HTTP Outgoing robot webhook (`timestamp` + `sign` HMAC-SHA256 verification)
 * - Outbound `sessionWebhook` replies + OpenAPI v1.0 proactive single (`oToMessages/batchSend`) and group (`groupMessages/send`) delivery
 * - Reserved extension seam (`getStreamingAdapter` / `getStreamingOptions`) for DingTalk AI Card streaming (`v1.0/card/instances` & `v1.0/card/streaming`)
 *
 * @see https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 * @see https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches.md
 * @see https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message.md
 * @see https://open.dingtalk.com/document/development/api-streamingupdate.md
 */
export class DingTalkConnector<
  const TName extends string = typeof DEFAULT_DINGTALK_CONNECTOR_NAME,
> implements Connector<
  TName,
  typeof dingTalkSendSchema,
  typeof dingTalkReceiveSchema,
  DingTalkSendResult
> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;

  private readonly inboundMode: DingTalkInboundMode;
  private readonly sender: DingTalkSender<TName>;
  private readonly receiver: DingTalkReceiver<TName> | undefined;
  private readonly streamingOptions: DingTalkStreamingOptions<TName> | undefined;
  private readonly streamingAdapter: DingTalkStreamingAdapter<TName> | undefined;

  constructor(options?: DingTalkConnectorOptions<TName>) {
    const resolvedName = (options?.name ?? DEFAULT_DINGTALK_CONNECTOR_NAME) as TName;
    assertValidConnectorName(resolvedName);
    this.name = resolvedName;
    this.displayName = options?.displayName ?? DEFAULT_DINGTALK_DISPLAY_NAME;
    this.description = options?.description ?? DEFAULT_DINGTALK_DESCRIPTION;

    const clientId = nonEmptyTrimmed(options?.clientId);
    const clientSecret = nonEmptyTrimmed(options?.clientSecret);
    const hasAppCredentials = clientId !== undefined && clientSecret !== undefined;

    this.inboundMode = options?.inboundMode ?? (hasAppCredentials ? "stream" : "webhook");

    const webhookCache = new SessionWebhookCache(
      options?.now !== undefined ? { now: options.now } : undefined,
    );

    const tokenManager = hasAppCredentials
      ? new DingTalkAccessTokenManager({
          connectorName: resolvedName,
          clientId,
          clientSecret,
          ...(options?.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
          ...(options?.httpTimeoutMs !== undefined ? { httpTimeoutMs: options.httpTimeoutMs } : {}),
          ...(options?.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
          ...(options?.now !== undefined ? { now: options.now } : {}),
        })
      : undefined;

    const robotCode = nonEmptyTrimmed(options?.robotCode) ?? clientId;

    this.sender = new DingTalkSender<TName>({
      connectorName: resolvedName,
      ...(robotCode !== undefined ? { robotCode } : {}),
      ...(options?.coolAppCode !== undefined ? { coolAppCode: options.coolAppCode } : {}),
      ...(tokenManager !== undefined ? { tokenManager } : {}),
      webhookCache,
      ...(options?.preferSessionWebhook !== undefined
        ? { preferSessionWebhook: options.preferSessionWebhook }
        : {}),
      ...(options?.defaultFormat !== undefined ? { defaultFormat: options.defaultFormat } : {}),
      ...(options?.contextMarker !== undefined ? { contextMarker: options.contextMarker } : {}),
      ...(options?.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
      ...(options?.httpTimeoutMs !== undefined ? { httpTimeoutMs: options.httpTimeoutMs } : {}),
      ...(options?.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });

    this.receiver =
      this.inboundMode === "none"
        ? undefined
        : new DingTalkReceiver<TName>({
            connectorName: resolvedName,
            ...(clientId !== undefined ? { clientId } : {}),
            ...(clientSecret !== undefined ? { clientSecret } : {}),
            ...(options?.webhookSigningSecret !== undefined
              ? { webhookSigningSecret: options.webhookSigningSecret }
              : {}),
            ...(options?.outgoingToken !== undefined
              ? { outgoingToken: options.outgoingToken }
              : {}),
            ...(options?.maxWebhookSkewMs !== undefined
              ? { maxWebhookSkewMs: options.maxWebhookSkewMs }
              : {}),
            webhookCache,
            ...(options?.botUserIds !== undefined ? { botUserIds: options.botUserIds } : {}),
            ...(options?.botStaffIds !== undefined ? { botStaffIds: options.botStaffIds } : {}),
            ...(options?.requireAtInGroup !== undefined
              ? { requireAtInGroup: options.requireAtInGroup }
              : {}),
            ...(options?.streamSubscriptions !== undefined
              ? { streamSubscriptions: options.streamSubscriptions }
              : {}),
            ...(options?.streamUserAgent !== undefined
              ? { streamUserAgent: options.streamUserAgent }
              : {}),
            ...(options?.localIp !== undefined ? { localIp: options.localIp } : {}),
            ...(options?.reconnectInitialDelayMs !== undefined
              ? { reconnectInitialDelayMs: options.reconnectInitialDelayMs }
              : {}),
            ...(options?.reconnectMaxDelayMs !== undefined
              ? { reconnectMaxDelayMs: options.reconnectMaxDelayMs }
              : {}),
            ...(options?.autoReconnect !== undefined
              ? { autoReconnect: options.autoReconnect }
              : {}),
            ...(options?.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
            ...(options?.httpTimeoutMs !== undefined
              ? { httpTimeoutMs: options.httpTimeoutMs }
              : {}),
            ...(options?.wsHandshakeTimeoutMs !== undefined
              ? { wsHandshakeTimeoutMs: options.wsHandshakeTimeoutMs }
              : {}),
            ...(options?.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
            ...(options?.createWebSocket !== undefined
              ? { createWebSocket: options.createWebSocket }
              : {}),
            ...(options?.now !== undefined ? { now: options.now } : {}),
            ...(options?.logger !== undefined ? { logger: options.logger } : {}),
          });

    this.streamingOptions = options?.streaming;
    this.streamingAdapter = options?.streamingAdapter ?? options?.streaming?.adapter;
  }

  getSender(): DingTalkSender<TName> {
    return this.sender;
  }

  getReceiver(): DingTalkReceiver<TName> | undefined {
    return this.receiver;
  }

  /**
   * Returns the reserved DingTalk AI Card / Interactive Card streaming adapter if provided.
   * Non-streaming receive/send works independently without this adapter.
   */
  getStreamingAdapter(): DingTalkStreamingAdapter<TName> | undefined {
    return this.streamingAdapter;
  }

  /**
   * Returns the reserved DingTalk streaming configuration if provided.
   */
  getStreamingOptions(): DingTalkStreamingOptions<TName> | undefined {
    return this.streamingOptions;
  }

  async start(): Promise<void> {
    if (
      this.receiver !== undefined &&
      (this.inboundMode === "stream" || this.inboundMode === "both")
    ) {
      await this.receiver.startStream();
    }
  }

  async stop(): Promise<void> {
    if (this.receiver !== undefined) {
      await this.receiver.stopStream();
    }
  }
}

/**
 * Factory helper creating a validated `DingTalkConnector` instance.
 */
export function createDingTalkConnector<
  const TName extends string = typeof DEFAULT_DINGTALK_CONNECTOR_NAME,
>(options?: DingTalkConnectorOptions<TName>): DingTalkConnector<TName> {
  const instance = new DingTalkConnector<TName>(options);
  defineConnector(instance);
  return instance;
}
