import {
  assertValidConnectorName,
  type Connector,
  type ConnectorLogger,
} from "@dsh-connector/core";
import { TelegramApiClient } from "./api-client";
import {
  DEFAULT_TELEGRAM_CONNECTOR_NAME,
  DEFAULT_TELEGRAM_DESCRIPTION,
  DEFAULT_TELEGRAM_DISPLAY_NAME,
} from "./constants";
import { TelegramReceiver } from "./receiver";
import { TelegramSender } from "./sender";
import type { TelegramStreamingAdapter, TelegramStreamingOptions } from "./streaming";
import {
  telegramReceiveSchema,
  telegramSendSchema,
  type TelegramConnectorOptions,
  type TelegramSendResult,
  type TelegramTransportMode,
} from "./types";
import { assertValidWebhookSecretToken } from "./webhook-auth";

function resolveTransportMode(options: TelegramConnectorOptions<string>): TelegramTransportMode {
  if (options.mode !== undefined) {
    return options.mode;
  }
  if (options.webhookSecretToken !== undefined && options.polling === undefined) {
    return "webhook";
  }
  return "polling";
}

/**
 * Official Telegram Bot API `Connector` implementation for `@dsh-connector`.
 *
 * Supports:
 * - Outbound `sendMessage` with 3-tier target resolution, Forum Topic `message_thread_id`,
 *   `reply_parameters` quoting, `429 retry_after` handling, and `<=4096`-character safe splitting
 * - Inbound `getUpdates` long polling with `offset` cursor persistence & backoff
 * - Inbound HTTPS Webhook with constant-time `X-Telegram-Bot-Api-Secret-Token` verification
 * - Private direct messages, group `@mention`/`text_mention`/`/cmd@bot`/reply-to-bot gating,
 *   `reply_to_message` provenance, and bot self-message loop prevention
 * - Reserved extension slots for `editMessageText`, `sendChatAction`, and `sendMessageDraft` streaming
 *
 * @see https://core.telegram.org/bots/api
 */
export class TelegramConnector<
  TName extends string = typeof DEFAULT_TELEGRAM_CONNECTOR_NAME,
> implements Connector<
  TName,
  typeof telegramSendSchema,
  typeof telegramReceiveSchema,
  TelegramSendResult
> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;

  private readonly mode: TelegramTransportMode;
  private readonly apiClient: TelegramApiClient;
  private readonly sender: TelegramSender<TName>;
  private readonly receiver: TelegramReceiver<TName>;
  private readonly streamingOptions: TelegramStreamingOptions | undefined;
  private readonly streamingAdapter: TelegramStreamingAdapter | undefined;
  private readonly hostLogger: ConnectorLogger | undefined;

  constructor(options: TelegramConnectorOptions<TName>) {
    const resolvedName = (options.name ?? DEFAULT_TELEGRAM_CONNECTOR_NAME) as TName;
    assertValidConnectorName(resolvedName);

    if (options.webhookSecretToken !== undefined) {
      assertValidWebhookSecretToken(options.webhookSecretToken, resolvedName);
    }

    this.name = resolvedName;
    this.hostLogger = options.logger;
    this.displayName = options.displayName ?? DEFAULT_TELEGRAM_DISPLAY_NAME;
    this.description = options.description ?? DEFAULT_TELEGRAM_DESCRIPTION;
    this.mode = resolveTransportMode(options);
    this.streamingOptions = options.streaming;
    this.streamingAdapter = options.streamingAdapter ?? options.streaming?.adapter;

    this.apiClient = new TelegramApiClient({
      connectorName: resolvedName,
      botToken: options.botToken,
      ...(this.hostLogger !== undefined ? { logger: this.hostLogger } : {}),
      apiBaseUrl: options.apiBaseUrl,
      fetchFn: options.fetchFn,
      sleepFn: options.sleepFn,
      requestTimeoutMs: options.requestTimeoutMs,
      maxSendRetries: options.maxSendRetries,
      maxRetryAfterMs: options.maxRetryAfterMs,
    });

    this.sender = new TelegramSender<TName>({
      connectorName: resolvedName,
      apiClient: this.apiClient,
      includeContextMarker: options.includeContextMarker,
      contextMarkerStyle: options.contextMarkerStyle,
      maxMessageLength: options.maxMessageLength,
    });

    const adapter = this.streamingAdapter;
    this.receiver = new TelegramReceiver<TName>({
      connectorName: resolvedName,
      apiClient: this.apiClient,
      ...(this.hostLogger !== undefined ? { logger: this.hostLogger } : {}),
      botId: options.botId,
      botUsername: options.botUsername,
      webhookSecretToken: options.webhookSecretToken,
      requireWebhookSecretToken: options.requireWebhookSecretToken,
      groupTriggerMode: options.groupTriggerMode,
      allowedChatIds: options.allowedChatIds,
      allowedUserIds: options.allowedUserIds,
      acceptEditedMessages: options.acceptEditedMessages,
      inboundDeliveryMode: options.inboundDeliveryMode,
      polling: options.polling,
      sleepFn: options.sleepFn,
      ...(adapter?.onGenerationStopped !== undefined
        ? { onGenerationStopped: (ev) => adapter.onGenerationStopped!(ev) }
        : {}),
    });
  }

  getSender(): TelegramSender<TName> {
    return this.sender;
  }

  getReceiver(): TelegramReceiver<TName> {
    return this.receiver;
  }

  /**
   * Returns the reserved `TelegramStreamingAdapter` slot if configured (`undefined` by default).
   *
   * @see https://core.telegram.org/bots/api#editmessagetext
   * @see https://core.telegram.org/bots/api#sendchataction
   * @see https://core.telegram.org/bots/api#sendmessagedraft
   */
  getStreamingAdapter(): TelegramStreamingAdapter | undefined {
    return this.streamingAdapter;
  }

  getStreamingOptions(): TelegramStreamingOptions | undefined {
    return this.streamingOptions;
  }

  getApiClient(): TelegramApiClient {
    return this.apiClient;
  }

  getMode(): TelegramTransportMode {
    return this.mode;
  }

  async start(): Promise<void> {
    if (this.mode === "polling") {
      await this.receiver.startPolling();
    }
  }

  async stop(): Promise<void> {
    await this.receiver.stopPolling();
  }
}

/**
 * Factory function creating a typed `TelegramConnector` instance.
 *
 * @see https://core.telegram.org/bots/api
 */
export function createTelegramConnector<
  const TName extends string = typeof DEFAULT_TELEGRAM_CONNECTOR_NAME,
>(options: TelegramConnectorOptions<TName>): TelegramConnector<TName> {
  return new TelegramConnector<TName>(options);
}
