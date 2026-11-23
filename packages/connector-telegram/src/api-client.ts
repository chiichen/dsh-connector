import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  type ConnectorLogger,
  type ConnectorSendOptions,
  type ConnectorTransportErrorOptions,
} from "@dsh-connector/core";
import {
  DEFAULT_ALLOWED_UPDATES,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_MAX_SEND_RETRIES,
  DEFAULT_POLL_LIMIT,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TELEGRAM_API_BASE_URL,
  DEFAULT_TELEGRAM_CONNECTOR_NAME,
  HEADER_CONTENT_TYPE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  MIN_POLL_HTTP_TIMEOUT_MS,
  MS_PER_SECOND,
  POLL_HTTP_TIMEOUT_BUFFER_MS,
} from "./constants";
import type {
  TelegramEditMessageTextParams,
  TelegramSendChatActionParams,
  TelegramSendMessageDraftParams,
} from "./streaming";
import type {
  TelegramApiEnvelope,
  TelegramMessage,
  TelegramParseMode,
  TelegramSleepFn,
  TelegramUpdate,
  TelegramUser,
} from "./types";

const CONTROL_CHARS_PATTERN = /[\r\n\0\s]/;
const HTTP_SERVER_ERROR_MIN = 500 as const;
const DEFAULT_CHAT_ACTION = "typing" as const;
const DEFAULT_RETRY_AFTER_SECONDS = 1 as const;
const JSON_MIME_TYPE = "application/json" as const;

export interface TelegramRateLimitErrorOptions extends ConnectorTransportErrorOptions {
  readonly retryAfterSeconds: number;
}

/**
 * Specialized `ConnectorTransportError` raised when Telegram returns HTTP `429 Too Many Requests`
 * (`ResponseParameters.retry_after`).
 *
 * @see https://core.telegram.org/bots/api#responseparameters
 */
export class TelegramRateLimitError extends ConnectorTransportError {
  readonly retryAfterSeconds: number;

  constructor(message: string, options: TelegramRateLimitErrorOptions) {
    super(message, {
      ...options,
      statusCode: HTTP_STATUS_TOO_MANY_REQUESTS,
      retryable: true,
    });
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface TelegramApiClientOptions {
  readonly connectorName?: string;
  readonly botToken: string;
  readonly apiBaseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly sleepFn?: TelegramSleepFn;
  readonly requestTimeoutMs?: number;
  readonly maxSendRetries?: number;
  readonly maxRetryAfterMs?: number;
  readonly logger?: ConnectorLogger;
}

export interface TelegramGetUpdatesRequest {
  readonly offset?: number;
  readonly limit?: number;
  readonly timeoutSeconds?: number;
  readonly allowedUpdates?: readonly string[];
}

export interface TelegramSendMessageRequest {
  readonly chatId: number | string;
  readonly text: string;
  readonly messageThreadId?: number;
  readonly replyToMessageId?: number;
  readonly parseMode?: TelegramParseMode;
  readonly disableNotification?: boolean;
  readonly protectContent?: boolean;
  readonly disableLinkPreview?: boolean;
}

interface InternalCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export function defaultTelegramSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildRequestSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal !== undefined
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope<TResult>(raw: unknown): TelegramApiEnvelope<TResult> | undefined {
  if (!isPlainObject(raw) || typeof raw["ok"] !== "boolean") {
    return undefined;
  }
  const parametersRaw = raw["parameters"];
  const parameters = isPlainObject(parametersRaw)
    ? {
        ...(typeof parametersRaw["migrate_to_chat_id"] === "number"
          ? { migrate_to_chat_id: parametersRaw["migrate_to_chat_id"] }
          : {}),
        ...(typeof parametersRaw["retry_after"] === "number"
          ? { retry_after: parametersRaw["retry_after"] }
          : {}),
      }
    : undefined;

  return {
    ok: raw["ok"],
    ...(raw["result"] !== undefined ? { result: raw["result"] as TResult } : {}),
    ...(typeof raw["error_code"] === "number" ? { error_code: raw["error_code"] } : {}),
    ...(typeof raw["description"] === "string" ? { description: raw["description"] } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
  };
}

/**
 * Zero-dependency HTTPS client for the official Telegram Bot API (`https://api.telegram.org/bot<token>/<method>`).
 *
 * @see https://core.telegram.org/bots/api#making-requests
 * @see https://core.telegram.org/bots/api#authorizing-your-bot
 */
export class TelegramApiClient {
  private readonly connectorName: string;
  private readonly botToken: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: TelegramSleepFn;
  private readonly requestTimeoutMs: number;
  private readonly maxSendRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly logger: ConnectorLogger | undefined;

  constructor(options: TelegramApiClientOptions) {
    this.connectorName = options.connectorName ?? DEFAULT_TELEGRAM_CONNECTOR_NAME;
    const trimmedToken = options.botToken.trim();
    if (trimmedToken.length === 0 || CONTROL_CHARS_PATTERN.test(trimmedToken)) {
      throw new ConnectorValidationError(
        "Telegram botToken must be a non-empty string without whitespace or control characters.",
        { connectorName: this.connectorName },
      );
    }

    this.botToken = trimmedToken;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_TELEGRAM_API_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.sleepFn = options.sleepFn ?? defaultTelegramSleep;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxSendRetries = options.maxSendRetries ?? DEFAULT_MAX_SEND_RETRIES;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.logger = options.logger;
  }

  /**
   * Verifies the bot's authentication token and returns basic bot information (`User`).
   *
   * @see https://core.telegram.org/bots/api#getme
   */
  async getMe(options?: ConnectorSendOptions): Promise<TelegramUser> {
    return this.callMethod<TelegramUser>("getMe", {}, { signal: options?.signal });
  }

  /**
   * Polls incoming updates via Telegram `getUpdates` long polling.
   *
   * @see https://core.telegram.org/bots/api#getupdates
   */
  async getUpdates(
    params: TelegramGetUpdatesRequest = {},
    options?: ConnectorSendOptions,
  ): Promise<readonly TelegramUpdate[]> {
    const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    const limit = params.limit ?? DEFAULT_POLL_LIMIT;
    const allowedUpdates = params.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES;
    const httpTimeoutMs = Math.max(
      MIN_POLL_HTTP_TIMEOUT_MS,
      timeoutSeconds * MS_PER_SECOND + POLL_HTTP_TIMEOUT_BUFFER_MS,
    );

    const payload: Record<string, unknown> = {
      timeout: timeoutSeconds,
      limit,
      allowed_updates: allowedUpdates,
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
    };

    return this.callMethod<readonly TelegramUpdate[]>("getUpdates", payload, {
      signal: options?.signal,
      timeoutMs: httpTimeoutMs,
    });
  }

  /**
   * Sends a single text message (`1..4096` chars) via Telegram `sendMessage`, honoring
   * `ResponseParameters.retry_after` on HTTP `429` within configured retry bounds.
   *
   * @see https://core.telegram.org/bots/api#sendmessage
   * @see https://core.telegram.org/bots/api#replyparameters
   */
  async sendMessage(
    params: TelegramSendMessageRequest,
    options?: ConnectorSendOptions,
  ): Promise<TelegramMessage> {
    const payload: Record<string, unknown> = {
      chat_id: params.chatId,
      text: params.text,
      link_preview_options: {
        is_disabled: params.disableLinkPreview ?? true,
      },
      ...(params.messageThreadId !== undefined
        ? { message_thread_id: params.messageThreadId }
        : {}),
      ...(params.parseMode !== undefined ? { parse_mode: params.parseMode } : {}),
      ...(params.disableNotification !== undefined
        ? { disable_notification: params.disableNotification }
        : {}),
      ...(params.protectContent !== undefined ? { protect_content: params.protectContent } : {}),
      ...(params.replyToMessageId !== undefined
        ? {
            reply_parameters: {
              message_id: params.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
    };

    let accumulatedWaitMs = 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.callMethod<TelegramMessage>("sendMessage", payload, {
          signal: options?.signal,
        });
      } catch (error) {
        if (!(error instanceof TelegramRateLimitError)) {
          throw error;
        }
        const waitMs = Math.ceil(error.retryAfterSeconds * MS_PER_SECOND);
        if (attempt >= this.maxSendRetries || accumulatedWaitMs + waitMs > this.maxRetryAfterMs) {
          throw error;
        }
        accumulatedWaitMs += waitMs;
        this.logger?.warn("Telegram sendMessage rate-limited (429); waiting before retry.", {
          chatId: params.chatId,
          attempt: attempt + 1,
          waitMs,
        });
        await this.sleepFn(waitMs, options?.signal);
      }
    }
  }

  /**
   * Edits an existing text message in-place via Telegram `editMessageText` (`1..4096` chars).
   * Provided as a ready primitive for `TelegramStreamingAdapter` implementations.
   *
   * @see https://core.telegram.org/bots/api#editmessagetext
   */
  async editMessageText(
    params: TelegramEditMessageTextParams,
    options?: ConnectorSendOptions,
  ): Promise<TelegramMessage | boolean> {
    const payload: Record<string, unknown> = {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text,
      link_preview_options: {
        is_disabled: params.disableLinkPreview ?? true,
      },
      ...(params.parseMode !== undefined ? { parse_mode: params.parseMode } : {}),
      ...(params.businessConnectionId !== undefined
        ? { business_connection_id: params.businessConnectionId }
        : {}),
    };

    return this.callMethod<TelegramMessage | boolean>("editMessageText", payload, {
      signal: options?.signal,
    });
  }

  /**
   * Broadcasts a chat status indicator (`typing` by default, valid up to 5 seconds) via `sendChatAction`.
   *
   * @see https://core.telegram.org/bots/api#sendchataction
   */
  async sendChatAction(
    params: TelegramSendChatActionParams,
    options?: ConnectorSendOptions,
  ): Promise<boolean> {
    const payload: Record<string, unknown> = {
      chat_id: params.chatId,
      action: params.action ?? DEFAULT_CHAT_ACTION,
      ...(params.messageThreadId !== undefined
        ? { message_thread_id: params.messageThreadId }
        : {}),
      ...(params.businessConnectionId !== undefined
        ? { business_connection_id: params.businessConnectionId }
        : {}),
    };

    return this.callMethod<boolean>("sendChatAction", payload, {
      signal: options?.signal,
    });
  }

  /**
   * Streams an ephemeral partial message preview via Telegram Bot API `sendMessageDraft`
   * (`draft_id` must be non-zero).
   *
   * @see https://core.telegram.org/bots/api#sendmessagedraft
   */
  async sendMessageDraft(
    params: TelegramSendMessageDraftParams,
    options?: ConnectorSendOptions,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(params.draftId) || params.draftId === 0) {
      throw new ConnectorValidationError(
        "Telegram sendMessageDraft draftId must be a non-zero integer.",
        {
          connectorName: this.connectorName,
        },
      );
    }

    const payload: Record<string, unknown> = {
      chat_id: params.chatId,
      draft_id: params.draftId,
      ...(params.messageThreadId !== undefined
        ? { message_thread_id: params.messageThreadId }
        : {}),
      ...(params.text !== undefined ? { text: params.text } : {}),
      ...(params.parseMode !== undefined ? { parse_mode: params.parseMode } : {}),
      ...(params.canStop !== undefined ? { can_stop: params.canStop } : {}),
      ...(params.keepOnStop !== undefined ? { keep_on_stop: params.keepOnStop } : {}),
    };

    return this.callMethod<boolean>("sendMessageDraft", payload, {
      signal: options?.signal,
    });
  }

  private async callMethod<TResult>(
    method: string,
    payload: Record<string, unknown>,
    options?: InternalCallOptions,
  ): Promise<TResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("The operation was aborted.", "AbortError");
    }

    const url = `${this.apiBaseUrl}/bot${this.botToken}/${method}`;
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          [HEADER_CONTENT_TYPE]: JSON_MIME_TYPE,
        },
        body: JSON.stringify(payload),
        signal: buildRequestSignal(options?.signal, timeoutMs),
      });
    } catch (cause) {
      if (options?.signal?.aborted) {
        throw options.signal.reason instanceof Error ? options.signal.reason : cause;
      }
      throw new ConnectorTransportError(`Telegram Bot API "${method}" network request failed.`, {
        connectorName: this.connectorName,
        retryable: true,
        cause,
      });
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch (cause) {
      throw new ConnectorTransportError(
        `Telegram Bot API "${method}" returned non-JSON response (HTTP ${response.status}).`,
        {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable: response.status >= HTTP_SERVER_ERROR_MIN,
          cause,
        },
      );
    }

    const envelope = parseEnvelope<TResult>(rawJson);
    if (envelope === undefined) {
      throw new ConnectorTransportError(
        `Telegram Bot API "${method}" returned malformed response envelope.`,
        {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable: response.status >= HTTP_SERVER_ERROR_MIN,
        },
      );
    }

    if (!response.ok || !envelope.ok || envelope.result === undefined) {
      const statusCode = envelope.error_code ?? response.status;
      const description =
        envelope.description ?? `Telegram Bot API "${method}" failed with status ${statusCode}.`;

      if (statusCode === HTTP_STATUS_UNAUTHORIZED) {
        throw new ConnectorAuthError(`Telegram authentication failed (${method}): ${description}`, {
          connectorName: this.connectorName,
        });
      }

      if (statusCode === HTTP_STATUS_TOO_MANY_REQUESTS) {
        const retryAfter =
          envelope.parameters?.retry_after !== undefined && envelope.parameters.retry_after >= 0
            ? envelope.parameters.retry_after
            : DEFAULT_RETRY_AFTER_SECONDS;
        throw new TelegramRateLimitError(
          `Telegram rate limit exceeded (${method}): ${description}`,
          {
            connectorName: this.connectorName,
            retryAfterSeconds: retryAfter,
          },
        );
      }

      throw new ConnectorTransportError(`Telegram API error (${method}): ${description}`, {
        connectorName: this.connectorName,
        statusCode,
        retryable: statusCode >= HTTP_SERVER_ERROR_MIN,
      });
    }

    return envelope.result;
  }
}
