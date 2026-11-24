import {
  assertValidConnectorName,
  ConnectorValidationError,
  defineConnector,
  type Connector,
  type ConnectorLogger,
  type ConnectorReceiver,
  type ConnectorSender,
} from "@dsh-connector/core";
import {
  DEFAULT_WHATSAPP_CONNECTOR_NAME,
  DEFAULT_WHATSAPP_DESCRIPTION,
  DEFAULT_WHATSAPP_DISPLAY_NAME,
} from "./constants";
import { SentMessageTracker } from "./context-id";
import { createWhatsAppReceiver } from "./receiver";
import { createWhatsAppSender } from "./sender";
import type { WhatsAppStreamingAdapter, WhatsAppStreamingOptions } from "./streaming";
import type {
  WhatsAppConnectorOptions,
  whatsappReceiveSchema,
  WhatsAppSendResult,
  whatsappSendSchema,
} from "./types";

/**
 * Official Meta WhatsApp Business Cloud API `Connector` implementation.
 *
 * Supports:
 * - Outbound Graph API `POST /{version}/{phone-number-id}/messages` text sending, contextual
 *   replies (`context: { message_id }`), three-tier recipient resolution, and automatic 4096-char
 *   chunking.
 * - Inbound Meta Webhooks (`GET` `hub.mode` / `hub.verify_token` / `hub.challenge` handshake,
 *   `POST` `X-Hub-Signature-256` HMAC-SHA256 verification, status receipt filtering, bot echo
 *   prevention, and `context.id` quote-reply correlation).
 * - Reserved streaming extension slots (`getStreamingOptions()` / `getStreamingAdapter()`) for
 *   Cloud API read/typing indicators and progressive segment/reaction updates.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export class WhatsAppConnector<
  TName extends string = typeof DEFAULT_WHATSAPP_CONNECTOR_NAME,
> implements Connector<
  TName,
  typeof whatsappSendSchema,
  typeof whatsappReceiveSchema,
  WhatsAppSendResult
> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;

  private readonly sender: ConnectorSender<typeof whatsappSendSchema, WhatsAppSendResult, TName>;
  private readonly receiver: ConnectorReceiver<typeof whatsappReceiveSchema, TName>;
  private readonly streamingOptions: WhatsAppStreamingOptions | undefined;
  private readonly streamingAdapter: WhatsAppStreamingAdapter | undefined;
  private readonly hostLogger: ConnectorLogger | undefined;
  private started = false;

  constructor(options: WhatsAppConnectorOptions<TName>) {
    const resolvedName = (options.name ?? DEFAULT_WHATSAPP_CONNECTOR_NAME) as TName;
    assertValidConnectorName(resolvedName);

    const phoneNumberId = options.phoneNumberId.trim();
    if (phoneNumberId.length === 0) {
      throw new ConnectorValidationError("WhatsAppConnector requires a non-empty phoneNumberId.", {
        connectorName: resolvedName,
      });
    }

    this.name = resolvedName;
    this.hostLogger = options.logger;
    this.displayName = options.displayName ?? DEFAULT_WHATSAPP_DISPLAY_NAME;
    this.description = options.description ?? DEFAULT_WHATSAPP_DESCRIPTION;
    this.streamingOptions = options.streaming;
    this.streamingAdapter = options.streamingAdapter ?? options.streaming?.adapter;

    const sentMessageTracker = new SentMessageTracker(options.outboundEchoCacheSize);

    this.sender = createWhatsAppSender({
      connectorName: resolvedName,
      accessToken: options.accessToken,
      phoneNumberId,
      ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
      ...(options.apiVersion !== undefined ? { apiVersion: options.apiVersion } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.maxTextLength !== undefined ? { maxTextLength: options.maxTextLength } : {}),
      ...(options.contextMarkerStyle !== undefined
        ? { contextMarkerStyle: options.contextMarkerStyle }
        : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      sentMessageTracker,
    });

    this.receiver = createWhatsAppReceiver({
      connectorName: resolvedName,
      phoneNumberId,
      ...(this.hostLogger !== undefined ? { logger: this.hostLogger } : {}),
      ...(options.businessPhoneNumber !== undefined
        ? { businessPhoneNumber: options.businessPhoneNumber }
        : {}),
      ...(options.verifyToken !== undefined ? { verifyToken: options.verifyToken } : {}),
      ...(options.appSecret !== undefined ? { appSecret: options.appSecret } : {}),
      ...(options.allowUnsignedWebhooks !== undefined
        ? { allowUnsignedWebhooks: options.allowUnsignedWebhooks }
        : {}),
      ...(options.allowedSenders !== undefined ? { allowedSenders: options.allowedSenders } : {}),
      sentMessageTracker,
    });
  }

  getSender(): ConnectorSender<typeof whatsappSendSchema, WhatsAppSendResult, TName> {
    return this.sender;
  }

  getReceiver(): ConnectorReceiver<typeof whatsappReceiveSchema, TName> {
    return this.receiver;
  }

  /**
   * Returns reserved streaming and typing-indicator options configured on this connector.
   *
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
   */
  getStreamingOptions(): WhatsAppStreamingOptions | undefined {
    return this.streamingOptions;
  }

  /**
   * Returns the optional `WhatsAppStreamingAdapter` reserved for future turn-progress and
   * progressive response delivery.
   *
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/reaction-messages
   */
  getStreamingAdapter(): WhatsAppStreamingAdapter | undefined {
    return this.streamingAdapter;
  }

  isStarted(): boolean {
    return this.started;
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }
}

/**
 * Factory function creating a typed `WhatsAppConnector` instance verified against `@dsh-connector/core`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/
 */
export function createWhatsAppConnector<
  const TName extends string = typeof DEFAULT_WHATSAPP_CONNECTOR_NAME,
>(options: WhatsAppConnectorOptions<TName>): WhatsAppConnector<TName> {
  const instance = new WhatsAppConnector(options);
  defineConnector(instance);
  return instance;
}
