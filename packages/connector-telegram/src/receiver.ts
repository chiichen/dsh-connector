import {
  ConnectorAuthError,
  ConnectorError,
  createConnectorContext,
  type ConnectorContext,
  type ConnectorInboundPrompt,
  type ConnectorLogger,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import { TelegramRateLimitError, defaultTelegramSleep, type TelegramApiClient } from "./api-client";
import {
  CONTENT_TYPE_APPLICATION_JSON,
  DEFAULT_ALLOWED_UPDATES,
  DEFAULT_POLL_LIMIT,
  DEFAULT_POLL_RETRY_BASE_MS,
  DEFAULT_POLL_RETRY_MAX_MS,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  HEADER_ALLOW,
  HEADER_CONTENT_TYPE,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  MAX_POLL_LIMIT,
  MIN_POLL_LIMIT,
  MS_PER_SECOND,
} from "./constants";
import {
  formatTelegramInboundPrompt,
  normalizeTelegramUpdate,
  parseRawTelegramUpdate,
} from "./inbound";
import type { TelegramMessageGenerationStoppedEvent } from "./streaming";
import {
  telegramReceiveSchema,
  type TelegramBotIdentity,
  type TelegramGroupTriggerMode,
  type TelegramPollingOptions,
  type TelegramReceivePayload,
  type TelegramSleepFn,
  type TelegramUpdate,
} from "./types";
import { verifyTelegramWebhookSecretToken } from "./webhook-auth";

const WEBHOOK_ALLOWED_METHOD = "POST" as const;
const DROP_PENDING_OFFSET = -1 as const;
const DROP_PENDING_LIMIT = 1 as const;
const DROP_PENDING_TIMEOUT_SECONDS = 0 as const;

export interface TelegramReceiverOptions<TName extends string = "telegram"> {
  readonly connectorName: TName;
  readonly apiClient: TelegramApiClient;
  readonly botId?: number;
  readonly botUsername?: string;
  readonly webhookSecretToken?: string;
  readonly requireWebhookSecretToken?: boolean;
  readonly groupTriggerMode?: TelegramGroupTriggerMode;
  readonly allowedChatIds?: ReadonlyArray<number | string>;
  readonly allowedUserIds?: ReadonlyArray<number | string>;
  readonly acceptEditedMessages?: boolean;
  readonly inboundDeliveryMode?: "queue" | "steer";
  readonly polling?: TelegramPollingOptions;
  readonly sleepFn?: TelegramSleepFn;
  readonly onGenerationStopped?: (
    event: TelegramMessageGenerationStoppedEvent,
  ) => Promise<void> | void;
}

function jsonWebhookResponse(
  status: number,
  payload: Record<string, unknown>,
): ConnectorWebhookResponse {
  return {
    status,
    headers: {
      [HEADER_CONTENT_TYPE]: CONTENT_TYPE_APPLICATION_JSON,
    },
    body: JSON.stringify(payload),
  };
}

/**
 * Inbound `ConnectorReceiver` supporting both:
 * 1. HTTPS Webhook callbacks verified in constant time via `X-Telegram-Bot-Api-Secret-Token`
 * 2. Background `getUpdates` long polling with `offset` cursor persistence and exponential/429 backoff
 *
 * @see https://core.telegram.org/bots/api#getupdates
 * @see https://core.telegram.org/bots/api#setwebhook
 */
export class TelegramReceiver<TName extends string = "telegram"> implements ConnectorReceiver<
  typeof telegramReceiveSchema,
  TName
> {
  readonly schema = telegramReceiveSchema;

  private readonly connectorName: TName;
  private readonly apiClient: TelegramApiClient;
  private readonly webhookSecretToken: string | undefined;
  private readonly requireWebhookSecretToken: boolean;
  private readonly groupTriggerMode: TelegramGroupTriggerMode | undefined;
  private readonly allowedChatIds: ReadonlyArray<number | string> | undefined;
  private readonly allowedUserIds: ReadonlyArray<number | string> | undefined;
  private readonly acceptEditedMessages: boolean | undefined;
  private readonly inboundDeliveryMode: "queue" | "steer" | undefined;
  private readonly pollingOptions: TelegramPollingOptions | undefined;
  private readonly sleepFn: TelegramSleepFn;
  private readonly onGenerationStopped:
    | ((event: TelegramMessageGenerationStoppedEvent) => Promise<void> | void)
    | undefined;

  private receiverCtx: ConnectorReceiverContext<typeof telegramReceiveSchema, TName> | undefined;
  private botIdentity: TelegramBotIdentity | undefined;
  private currentOffset: number | undefined;
  private pollAbortController: AbortController | undefined;
  private pollTask: Promise<void> | undefined;

  constructor(options: TelegramReceiverOptions<TName>) {
    this.connectorName = options.connectorName;
    this.apiClient = options.apiClient;
    this.webhookSecretToken = options.webhookSecretToken;
    this.requireWebhookSecretToken = options.requireWebhookSecretToken ?? true;
    this.groupTriggerMode = options.groupTriggerMode;
    this.allowedChatIds = options.allowedChatIds;
    this.allowedUserIds = options.allowedUserIds;
    this.acceptEditedMessages = options.acceptEditedMessages;
    this.inboundDeliveryMode = options.inboundDeliveryMode;
    this.pollingOptions = options.polling;
    this.sleepFn = options.sleepFn ?? defaultTelegramSleep;
    this.onGenerationStopped = options.onGenerationStopped;

    if (options.botId !== undefined) {
      this.botIdentity = {
        id: options.botId,
        ...(options.botUsername !== undefined ? { username: options.botUsername } : {}),
      };
    }
    this.currentOffset = options.polling?.initialOffset;
  }

  private get logger(): ConnectorLogger | undefined {
    return this.receiverCtx?.logger;
  }

  getBotIdentity(): TelegramBotIdentity | undefined {
    return this.botIdentity;
  }

  getCurrentOffset(): number | undefined {
    return this.currentOffset;
  }

  init(ctx: ConnectorReceiverContext<typeof telegramReceiveSchema, TName>): void {
    this.receiverCtx = ctx;
  }

  formatInbound(
    params: TelegramReceivePayload,
    context: ConnectorContext<TName>,
  ): ConnectorInboundPrompt {
    return formatTelegramInboundPrompt(params, context);
  }

  /**
   * Handles an incoming HTTPS Webhook request from Telegram servers.
   *
   * @see https://core.telegram.org/bots/api#setwebhook
   */
  async handleWebhook(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> {
    if (req.method.toUpperCase() !== WEBHOOK_ALLOWED_METHOD) {
      return {
        status: HTTP_STATUS_METHOD_NOT_ALLOWED,
        headers: {
          [HEADER_ALLOW]: WEBHOOK_ALLOWED_METHOD,
          [HEADER_CONTENT_TYPE]: CONTENT_TYPE_APPLICATION_JSON,
        },
        body: JSON.stringify({ ok: false, error: "Method Not Allowed" }),
      };
    }

    if (this.webhookSecretToken !== undefined) {
      const valid = verifyTelegramWebhookSecretToken(req.headers, this.webhookSecretToken);
      if (!valid) {
        this.logger?.warn(
          "Rejected Telegram webhook with invalid X-Telegram-Bot-Api-Secret-Token.",
        );
        return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
          ok: false,
          error: "Unauthorized",
        });
      }
    } else if (this.requireWebhookSecretToken) {
      this.logger?.warn(
        "Rejected Telegram webhook because webhookSecretToken is not configured while requireWebhookSecretToken is true.",
      );
      return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
        ok: false,
        error: "Webhook secret token is not configured",
      });
    }

    let rawUpdateValue: unknown;
    try {
      const decodedText = new TextDecoder("utf-8", { fatal: true }).decode(req.rawBody);
      rawUpdateValue = JSON.parse(decodedText) as unknown;
    } catch {
      return jsonWebhookResponse(HTTP_STATUS_BAD_REQUEST, {
        ok: false,
        error: "Malformed UTF-8 JSON body",
      });
    }

    const update = parseRawTelegramUpdate(rawUpdateValue);
    if (update === undefined) {
      return jsonWebhookResponse(HTTP_STATUS_BAD_REQUEST, {
        ok: false,
        error: "Invalid Telegram Update payload",
      });
    }

    try {
      const result = await this.ingestUpdate(update);
      return jsonWebhookResponse(HTTP_STATUS_OK, {
        ok: true,
        ...result,
      });
    } catch (error) {
      this.logger?.error("Failed to dispatch Telegram webhook update.", {
        updateId: update.update_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonWebhookResponse(HTTP_STATUS_INTERNAL_SERVER_ERROR, {
        ok: false,
        error: "Internal Server Error",
      });
    }
  }

  /**
   * Starts the background `getUpdates` long-polling loop, discovering bot identity via `getMe`
   * if not pre-configured and restoring or fast-forwarding the `offset` cursor.
   *
   * @see https://core.telegram.org/bots/api#getupdates
   * @see https://core.telegram.org/bots/api#getme
   */
  async startPolling(): Promise<void> {
    if (this.pollTask !== undefined) {
      return;
    }
    if (this.receiverCtx === undefined) {
      throw new ConnectorError(
        `TelegramReceiver "${this.connectorName}" must be initialized via init() before startPolling().`,
        { connectorName: this.connectorName },
      );
    }

    const controller = new AbortController();
    this.pollAbortController = controller;

    try {
      if (this.botIdentity === undefined || this.botIdentity.username === undefined) {
        const me = await this.apiClient.getMe({ signal: controller.signal });
        this.botIdentity = {
          id: me.id,
          ...(me.username !== undefined ? { username: me.username } : {}),
          firstName: me.first_name,
        };
      }

      const storedOffset = await this.pollingOptions?.offsetStore?.getOffset();
      if (storedOffset !== undefined) {
        this.currentOffset = storedOffset;
      }

      if (
        this.currentOffset === undefined &&
        this.pollingOptions?.dropPendingUpdatesOnStart === true
      ) {
        const latest = await this.apiClient.getUpdates(
          {
            offset: DROP_PENDING_OFFSET,
            limit: DROP_PENDING_LIMIT,
            timeoutSeconds: DROP_PENDING_TIMEOUT_SECONDS,
            allowedUpdates: this.pollingOptions.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES,
          },
          { signal: controller.signal },
        );
        const tail = latest.length > 0 ? latest[latest.length - 1] : undefined;
        const nextCursor = tail !== undefined ? tail.update_id + 1 : 0;
        await this.commitOffset(nextCursor);
      }
    } catch (error) {
      this.pollAbortController = undefined;
      throw error;
    }

    this.pollTask = this.runPollLoop(controller.signal);
  }

  /**
   * Cancels any in-flight `getUpdates` request and awaits clean shutdown of the polling loop.
   */
  async stopPolling(): Promise<void> {
    const controller = this.pollAbortController;
    const task = this.pollTask;
    this.pollAbortController = undefined;
    this.pollTask = undefined;

    controller?.abort();
    if (task !== undefined) {
      await task;
    }
  }

  private async commitOffset(nextOffset: number): Promise<void> {
    this.currentOffset = nextOffset;
    await this.pollingOptions?.offsetStore?.setOffset(nextOffset);
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    const timeoutSeconds = this.pollingOptions?.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    const rawLimit = this.pollingOptions?.limit ?? DEFAULT_POLL_LIMIT;
    const limit = Math.min(MAX_POLL_LIMIT, Math.max(MIN_POLL_LIMIT, rawLimit));
    const allowedUpdates = this.pollingOptions?.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES;
    const retryBaseMs = this.pollingOptions?.retryBaseDelayMs ?? DEFAULT_POLL_RETRY_BASE_MS;
    const retryMaxMs = this.pollingOptions?.retryMaxDelayMs ?? DEFAULT_POLL_RETRY_MAX_MS;
    const onUpdateError = this.pollingOptions?.onUpdateError ?? "retry";

    let consecutiveErrors = 0;

    while (!signal.aborted) {
      try {
        const rawUpdates = await this.apiClient.getUpdates(
          {
            ...(this.currentOffset !== undefined ? { offset: this.currentOffset } : {}),
            limit,
            timeoutSeconds,
            allowedUpdates,
          },
          { signal },
        );

        consecutiveErrors = 0;
        if (signal.aborted) {
          return;
        }

        const orderedUpdates = [...rawUpdates]
          .map((item) => parseRawTelegramUpdate(item))
          .filter((item): item is TelegramUpdate => item !== undefined)
          .sort((a, b) => a.update_id - b.update_id);

        for (const update of orderedUpdates) {
          if (signal.aborted) {
            return;
          }
          try {
            await this.ingestUpdate(update);
            const nextCursor = Math.max(this.currentOffset ?? 0, update.update_id + 1);
            await this.commitOffset(nextCursor);
          } catch (handlerError) {
            this.logger?.error("Error processing polled Telegram update.", {
              updateId: update.update_id,
              mode: onUpdateError,
              error: handlerError instanceof Error ? handlerError.message : String(handlerError),
            });
            if (onUpdateError === "skip") {
              const nextCursor = Math.max(this.currentOffset ?? 0, update.update_id + 1);
              await this.commitOffset(nextCursor);
              continue;
            }
            throw handlerError;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof ConnectorAuthError) {
          this.logger?.error("Fatal Telegram authentication failure; stopping getUpdates loop.", {
            error: error.message,
          });
          return;
        }

        const delayMs =
          error instanceof TelegramRateLimitError
            ? Math.min(retryMaxMs, Math.ceil(error.retryAfterSeconds * MS_PER_SECOND))
            : Math.min(retryMaxMs, retryBaseMs * 2 ** consecutiveErrors);

        consecutiveErrors += 1;
        this.logger?.warn("Telegram getUpdates poll failed; backing off before retry.", {
          delayMs,
          consecutiveErrors,
          error: error instanceof Error ? error.message : String(error),
        });

        try {
          await this.sleepFn(delayMs, signal);
        } catch {
          return;
        }
      }
    }
  }

  private async ingestUpdate(update: TelegramUpdate): Promise<{
    readonly handled: boolean;
    readonly sessionId?: string;
    readonly deduplicated?: boolean;
  }> {
    if (this.receiverCtx === undefined) {
      throw new ConnectorError(
        `TelegramReceiver "${this.connectorName}" has not been initialized via init().`,
        { connectorName: this.connectorName },
      );
    }

    if (update.stopped_message_generation !== undefined && this.onGenerationStopped !== undefined) {
      const stopped = update.stopped_message_generation;
      await this.onGenerationStopped({
        chatId: stopped.chat.id,
        ...(stopped.message_thread_id !== undefined
          ? { messageThreadId: stopped.message_thread_id }
          : {}),
        draftId: stopped.draft_id,
      });
    }

    const normalized = normalizeTelegramUpdate(update, {
      botId: this.botIdentity?.id,
      botUsername: this.botIdentity?.username,
      groupTriggerMode: this.groupTriggerMode,
      allowedChatIds: this.allowedChatIds,
      allowedUserIds: this.allowedUserIds,
      acceptEditedMessages: this.acceptEditedMessages,
      inboundDeliveryMode: this.inboundDeliveryMode,
    });

    if (normalized === undefined) {
      return { handled: false };
    }

    const context = createConnectorContext(this.connectorName, normalized.contextId);
    const delivery = await this.receiverCtx.onReceive(context, normalized.payload, normalized.meta);

    return {
      handled: true,
      sessionId: delivery.sessionId,
      ...(delivery.deduplicated !== undefined ? { deduplicated: delivery.deduplicated } : {}),
    };
  }
}
