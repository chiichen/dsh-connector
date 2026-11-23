/**
 * Discord REST API v10 client built on Node.js 24 native `fetch`.
 *
 * @see https://discord.com/developers/docs/reference
 * @see https://discord.com/developers/docs/resources/message
 * @see https://discord.com/developers/docs/resources/channel
 * @see https://discord.com/developers/docs/resources/user
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding
 */

import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import {
  DISCORD_CONNECTOR_DEFAULT_NAME,
  DISCORD_DEFAULT_API_BASE_URL,
  DISCORD_DEFAULT_HTTP_TIMEOUT_MS,
  DISCORD_DEFAULT_RATE_LIMIT_DELAY_MS,
  DISCORD_DEFAULT_THREAD_NAME,
  DISCORD_DEFAULT_USER_AGENT,
  DISCORD_JSON_AUTH_ERROR_CODES,
  DISCORD_MAX_RATE_LIMIT_DELAY_MS,
  DISCORD_MAX_THREAD_NAME_LENGTH,
  DISCORD_MIN_RATE_LIMIT_DELAY_MS,
  DISCORD_SECONDS_TO_MS,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NO_CONTENT,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
} from "./constants";
import { assertDiscordSnowflake } from "./context-target";
import type {
  DiscordAllowedMentions,
  DiscordApiMessage,
  DiscordChannel,
  DiscordEmbed,
  DiscordGatewayBotResponse,
  DiscordUser,
} from "./types";

const DEFAULT_ALLOWED_MENTIONS: DiscordAllowedMentions = Object.freeze({
  parse: ["users"] as const,
  replied_user: false,
});

export interface DiscordRestClientOptions {
  readonly botToken?: string;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly connectorName?: string;
  readonly fetchFn?: typeof fetch;
  readonly allowedMentions?: DiscordAllowedMentions;
}

export interface CreateDiscordMessageInput {
  readonly channelId: string;
  readonly content: string;
  readonly replyToMessageId?: string;
  readonly embeds?: readonly DiscordEmbed[];
  readonly allowedMentions?: DiscordAllowedMentions;
  readonly signal?: AbortSignal;
}

export interface EditDiscordMessageInput {
  readonly channelId: string;
  readonly messageId: string;
  readonly content?: string;
  readonly embeds?: readonly DiscordEmbed[];
  readonly allowedMentions?: DiscordAllowedMentions;
  readonly flags?: number;
  readonly signal?: AbortSignal;
}

export interface EditOriginalInteractionInput {
  readonly applicationId: string;
  readonly interactionToken: string;
  readonly content?: string;
  readonly embeds?: readonly DiscordEmbed[];
  readonly allowedMentions?: DiscordAllowedMentions;
  readonly flags?: number;
  readonly threadId?: string;
  readonly withComponents?: boolean;
  readonly signal?: AbortSignal;
}

export interface StartThreadFromMessageInput {
  readonly channelId: string;
  readonly messageId: string;
  readonly name: string;
  readonly autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
  readonly signal?: AbortSignal;
}

interface DiscordApiErrorPayload {
  readonly code?: number;
  readonly message?: string;
  readonly retry_after?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseErrorPayload(value: unknown): DiscordApiErrorPayload {
  if (!isPlainRecord(value)) {
    return {};
  }
  return {
    ...(typeof value["code"] === "number" ? { code: value["code"] } : {}),
    ...(typeof value["message"] === "string" ? { message: value["message"] } : {}),
    ...(typeof value["retry_after"] === "number" ? { retry_after: value["retry_after"] } : {}),
  };
}

function buildCombinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function waitWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Operation aborted"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Operation aborted"));
      },
      { once: true },
    );
  });
}

function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
}

/**
 * Discord REST API v10 client supporting Bot-authenticated routes and token-authenticated
 * Interaction webhook routes.
 *
 * @see https://discord.com/developers/docs/reference#authentication
 */
export class DiscordRestClient {
  readonly #botToken: string | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #connectorName: string;
  readonly #fetchFn: typeof fetch;
  readonly #allowedMentions: DiscordAllowedMentions;

  constructor(options: DiscordRestClientOptions) {
    const trimmedToken = options.botToken?.trim();
    this.#botToken =
      trimmedToken !== undefined && trimmedToken.length > 0 ? trimmedToken : undefined;
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? DISCORD_DEFAULT_API_BASE_URL);
    this.#userAgent = options.userAgent ?? DISCORD_DEFAULT_USER_AGENT;
    this.#timeoutMs = options.timeoutMs ?? DISCORD_DEFAULT_HTTP_TIMEOUT_MS;
    this.#connectorName = options.connectorName ?? DISCORD_CONNECTOR_DEFAULT_NAME;
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#allowedMentions = options.allowedMentions ?? DEFAULT_ALLOWED_MENTIONS;
  }

  /**
   * `GET /users/@me`
   * @see https://discord.com/developers/docs/resources/user#get-current-user
   */
  getCurrentUser(options?: { readonly signal?: AbortSignal }): Promise<DiscordUser> {
    return this.#request<DiscordUser>("users/@me", {
      method: "GET",
      requireBotAuth: true,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * `GET /gateway/bot`
   * @see https://discord.com/developers/docs/events/gateway#get-gateway-bot
   */
  getGatewayBot(options?: { readonly signal?: AbortSignal }): Promise<DiscordGatewayBotResponse> {
    return this.#request<DiscordGatewayBotResponse>("gateway/bot", {
      method: "GET",
      requireBotAuth: true,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * `GET /channels/{channel.id}`
   * @see https://discord.com/developers/docs/resources/channel#get-channel
   */
  getChannel(
    channelId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DiscordChannel> {
    const id = assertDiscordSnowflake(channelId, "channelId", this.#connectorName);
    return this.#request<DiscordChannel>(`channels/${id}`, {
      method: "GET",
      requireBotAuth: true,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * `POST /users/@me/channels`
   * Opens or retrieves a Direct Message channel with `recipientId`.
   * @see https://discord.com/developers/docs/resources/user#create-dm
   */
  createDmChannel(
    recipientId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DiscordChannel> {
    const id = assertDiscordSnowflake(recipientId, "recipientId", this.#connectorName);
    return this.#request<DiscordChannel>("users/@me/channels", {
      method: "POST",
      requireBotAuth: true,
      body: { recipient_id: id },
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * `POST /channels/{channel.id}/messages`
   * @see https://discord.com/developers/docs/resources/message#create-message
   */
  createMessage(input: CreateDiscordMessageInput): Promise<DiscordApiMessage> {
    const channelId = assertDiscordSnowflake(input.channelId, "channelId", this.#connectorName);
    const replyId =
      input.replyToMessageId !== undefined
        ? assertDiscordSnowflake(input.replyToMessageId, "replyToMessageId", this.#connectorName)
        : undefined;

    return this.#request<DiscordApiMessage>(`channels/${channelId}/messages`, {
      method: "POST",
      requireBotAuth: true,
      body: {
        content: input.content,
        allowed_mentions: input.allowedMentions ?? this.#allowedMentions,
        ...(input.embeds !== undefined ? { embeds: input.embeds } : {}),
        ...(replyId !== undefined
          ? {
              message_reference: {
                message_id: replyId,
                channel_id: channelId,
                fail_if_not_exists: false,
              },
            }
          : {}),
      },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }

  /**
   * `PATCH /channels/{channel.id}/messages/{message.id}`
   * @see https://discord.com/developers/docs/resources/message#edit-message
   */
  editMessage(input: EditDiscordMessageInput): Promise<DiscordApiMessage> {
    const channelId = assertDiscordSnowflake(input.channelId, "channelId", this.#connectorName);
    const messageId = assertDiscordSnowflake(input.messageId, "messageId", this.#connectorName);
    return this.#request<DiscordApiMessage>(`channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      requireBotAuth: true,
      body: {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.embeds !== undefined ? { embeds: input.embeds } : {}),
        ...(input.flags !== undefined ? { flags: input.flags } : {}),
        allowed_mentions: input.allowedMentions ?? this.#allowedMentions,
      },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }

  /**
   * `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original`
   * @see https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response
   */
  editOriginalInteractionResponse(input: EditOriginalInteractionInput): Promise<DiscordApiMessage> {
    const appId = assertDiscordSnowflake(input.applicationId, "applicationId", this.#connectorName);
    const token = input.interactionToken.trim();
    if (token.length === 0) {
      throw new ConnectorValidationError("Discord interactionToken must be non-empty.", {
        connectorName: this.#connectorName,
      });
    }
    const query = new URLSearchParams();
    if (input.threadId !== undefined) {
      query.set(
        "thread_id",
        assertDiscordSnowflake(input.threadId, "threadId", this.#connectorName),
      );
    }
    if (input.withComponents !== undefined) {
      query.set("with_components", String(input.withComponents));
    }
    const qs = query.toString();
    const path = `webhooks/${appId}/${encodeURIComponent(token)}/messages/@original${qs.length > 0 ? `?${qs}` : ""}`;

    return this.#request<DiscordApiMessage>(path, {
      method: "PATCH",
      requireBotAuth: false,
      body: {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.embeds !== undefined ? { embeds: input.embeds } : {}),
        ...(input.flags !== undefined ? { flags: input.flags } : {}),
        allowed_mentions: input.allowedMentions ?? this.#allowedMentions,
      },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }

  /**
   * `POST /channels/{channel.id}/typing`
   * Triggers a 10-second typing indicator in the target channel.
   * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
   */
  async triggerTypingIndicator(
    channelId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    const id = assertDiscordSnowflake(channelId, "channelId", this.#connectorName);
    await this.#request<undefined>(`channels/${id}/typing`, {
      method: "POST",
      requireBotAuth: true,
      expectBody: false,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * `POST /channels/{channel.id}/messages/{message.id}/threads`
   * @see https://discord.com/developers/docs/resources/channel#start-thread-from-message
   */
  startThreadFromMessage(input: StartThreadFromMessageInput): Promise<DiscordChannel> {
    const channelId = assertDiscordSnowflake(input.channelId, "channelId", this.#connectorName);
    const messageId = assertDiscordSnowflake(input.messageId, "messageId", this.#connectorName);
    const normalizedName =
      Array.from(input.name.trim()).slice(0, DISCORD_MAX_THREAD_NAME_LENGTH).join("") ||
      DISCORD_DEFAULT_THREAD_NAME;

    return this.#request<DiscordChannel>(`channels/${channelId}/messages/${messageId}/threads`, {
      method: "POST",
      requireBotAuth: true,
      body: {
        name: normalizedName,
        ...(input.autoArchiveDuration !== undefined
          ? { auto_archive_duration: input.autoArchiveDuration }
          : {}),
      },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }

  async #request<TResponse>(
    path: string,
    options: {
      readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      readonly requireBotAuth: boolean;
      readonly body?: Record<string, unknown>;
      readonly expectBody?: boolean;
      readonly allowRateLimitRetry?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<TResponse> {
    if (options.requireBotAuth && this.#botToken === undefined) {
      throw new ConnectorAuthError(
        `Discord REST endpoint "${options.method} /${path}" requires a configured botToken.`,
        { connectorName: this.#connectorName },
      );
    }

    const expectBody = options.expectBody ?? true;
    const allowRetry = options.allowRateLimitRetry ?? true;
    const headers: Record<string, string> = {
      "user-agent": this.#userAgent,
      ...(this.#botToken !== undefined ? { authorization: `Bot ${this.#botToken}` } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    };

    const targetUrl = new URL(path, this.#baseUrl);
    let response: Response;
    try {
      response = await this.#fetchFn(targetUrl, {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: buildCombinedSignal(options.signal, this.#timeoutMs),
      });
    } catch (cause) {
      throw new ConnectorTransportError(
        `Discord REST ${options.method} /${path} network request failed.`,
        {
          connectorName: this.#connectorName,
          retryable: options.signal?.aborted !== true,
          cause,
        },
      );
    }

    if (response.status === HTTP_STATUS_NO_CONTENT && !expectBody) {
      return undefined as TResponse;
    }

    let parsedBody: unknown = undefined;
    if (expectBody || !response.ok || response.status === HTTP_STATUS_TOO_MANY_REQUESTS) {
      try {
        parsedBody = await response.json();
      } catch (cause) {
        if (response.ok && expectBody) {
          throw new ConnectorTransportError(
            `Discord REST ${options.method} /${path} returned malformed JSON.`,
            {
              connectorName: this.#connectorName,
              statusCode: response.status,
              retryable: false,
              cause,
            },
          );
        }
      }
    }

    if (response.status === HTTP_STATUS_TOO_MANY_REQUESTS && allowRetry) {
      const errPayload = parseErrorPayload(parsedBody);
      const retryHeaderSeconds = Number(response.headers.get("retry-after"));
      const rawSeconds = errPayload.retry_after ?? retryHeaderSeconds;
      const delayMs =
        Number.isFinite(rawSeconds) && rawSeconds > 0
          ? Math.min(
              DISCORD_MAX_RATE_LIMIT_DELAY_MS,
              Math.max(
                DISCORD_MIN_RATE_LIMIT_DELAY_MS,
                Math.ceil(rawSeconds * DISCORD_SECONDS_TO_MS),
              ),
            )
          : DISCORD_DEFAULT_RATE_LIMIT_DELAY_MS;

      try {
        await waitWithSignal(delayMs, options.signal);
      } catch (cause) {
        throw new ConnectorTransportError("Discord rate-limit backoff aborted.", {
          connectorName: this.#connectorName,
          statusCode: HTTP_STATUS_TOO_MANY_REQUESTS,
          retryable: false,
          cause,
        });
      }

      return this.#request<TResponse>(path, {
        ...options,
        allowRateLimitRetry: false,
      });
    }

    if (!response.ok) {
      const errPayload = parseErrorPayload(parsedBody);
      const detail = errPayload.message ?? `HTTP ${response.status}`;

      if (
        response.status === HTTP_STATUS_UNAUTHORIZED ||
        response.status === HTTP_STATUS_FORBIDDEN ||
        (errPayload.code !== undefined && DISCORD_JSON_AUTH_ERROR_CODES.has(errPayload.code))
      ) {
        throw new ConnectorAuthError(
          `Discord REST ${options.method} /${path} authorization failed: ${detail}`,
          { connectorName: this.#connectorName },
        );
      }

      throw new ConnectorTransportError(
        `Discord REST ${options.method} /${path} failed (${response.status}): ${detail}`,
        {
          connectorName: this.#connectorName,
          statusCode: response.status,
          retryable:
            response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
            response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
        },
      );
    }

    return parsedBody as TResponse;
  }
}
