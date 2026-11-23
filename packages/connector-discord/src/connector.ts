/**
 * Top-level `DiscordConnector` and `createDiscordConnector` factory implementing
 * `@dsh-connector/core`'s `Connector` contract.
 *
 * @see https://discord.com/developers/docs/reference
 * @see https://discord.com/developers/docs/events/gateway
 * @see https://discord.com/developers/docs/interactions/overview
 */

import {
  ConnectorValidationError,
  assertValidConnectorName,
  type Connector,
  type ConnectorLogger,
  type ConnectorReceiver,
  type ConnectorSender,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import { DiscordRestClient } from "./api";
import { DISCORD_CONNECTOR_DEFAULT_NAME, DISCORD_DEFAULT_INTENTS } from "./constants";
import { DiscordGatewayClient } from "./gateway";
import { DiscordReceiver } from "./receiver";
import { DiscordSender } from "./sender";
import type { DiscordStreamingAdapter, DiscordStreamingOptions } from "./streaming";
import type {
  CreateWebSocketFn,
  DiscordAllowedMentions,
  DiscordSendResult,
  discordReceiveSchema,
  discordSendSchema,
} from "./types";

export interface DiscordConnectorOptions<TName extends string = "discord"> {
  /** Unique connector instance name (defaults to `"discord"`). */
  readonly name?: TName;
  /** Human-readable display name. */
  readonly displayName?: string;
  /** Human-readable connector description. */
  readonly description?: string;
  /** Discord Bot Token (`Authorization: Bot <token>`). Required for REST sending and Gateway WebSocket. */
  readonly botToken?: string;
  /** Discord Application Public Key (64-char hex Ed25519 key). Required for Interactions HTTP Webhook verification. */
  readonly publicKey?: string;
  /** Optional known Bot User Snowflake ID (auto-discovered via `READY` or `GET /users/@me` if omitted). */
  readonly botUserId?: string;
  /** Gateway Intents bitmask (defaults to `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT = 37377`). */
  readonly intents?: number;
  /** Whether to connect to Discord Gateway WebSocket on `start()` (defaults to `true` when `botToken` is provided). */
  readonly enableGateway?: boolean;
  /** Optional explicit Gateway WSS URL (skips `GET /gateway/bot` lookup when provided). */
  readonly gatewayUrl?: string;
  /** Optional Gateway shard tuple `[shard_id, num_shards]`. */
  readonly shard?: readonly [number, number];
  /** Override Discord REST API v10 base URL (defaults to `"https://discord.com/api/v10/"`). */
  readonly apiBaseUrl?: string;
  /** Request timeout for REST calls in milliseconds (defaults to `15_000`). */
  readonly requestTimeoutMs?: number;
  /** Reconnect backoff delays in milliseconds for Gateway WebSocket drops. */
  readonly reconnectDelaysMs?: readonly number[];
  /** Whether to ignore inbound messages from bots and webhooks (defaults to `true`; self-messages are ALWAYS ignored). */
  readonly ignoreBotMessages?: boolean;
  /** Whether Guild non-thread channel messages must `@mention` or reply to the bot (defaults to `true`). */
  readonly requireMentionInGuild?: boolean;
  /** Automatically create a public thread when `@mentioned` in a Guild text channel (defaults to `false`). */
  readonly autoCreateThreadOnMention?: boolean;
  /** Auto-archive duration in minutes when `autoCreateThreadOnMention` is enabled. */
  readonly autoArchiveDurationMinutes?: 60 | 1440 | 4320 | 10080;
  /** Whether to prepend `[#ctx:<contextId>]` marker on outbound messages by default (defaults to `false`). */
  readonly includeContextMarker?: boolean;
  /** Style for outbound context markers (defaults to `"bracket"`). */
  readonly contextMarkerStyle?: ContextMarkerStyle;
  /** Maximum characters per Discord message chunk (defaults to `2000`, capped at `2000`). */
  readonly maxMessageLength?: number;
  /** Default `allowed_mentions` policy on outbound REST messages. */
  readonly defaultAllowedMentions?: DiscordAllowedMentions;
  /** Injectable HTTP `fetch` implementation for unit tests or custom proxies. */
  readonly fetchFn?: typeof fetch;
  /** Injectable WebSocket constructor/factory for unit tests or custom tunnels. */
  readonly createWebSocket?: CreateWebSocketFn;
  /** Injectable PRNG (`[0, 1)`) for deterministic Gateway heartbeat jitter in tests. */
  readonly randomFn?: () => number;
  /** Optional structured logger fallback when receiver context logger is not yet attached. */
  readonly logger?: ConnectorLogger;
  /**
   * Reserved streaming configuration seam (non-streaming loop only in current phase).
   *
   * @see https://discord.com/developers/docs/resources/message#edit-message
   * @see https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response
   * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
   */
  readonly streaming?: DiscordStreamingOptions;
  /**
   * Reserved pluggable streaming adapter seam for future `PATCH` message/interaction streaming.
   */
  readonly streamingAdapter?: DiscordStreamingAdapter;
}

/**
 * Discord Connector (`@dsh-connector/connector-discord`) supporting REST v10 outbound messaging,
 * Gateway v10 WebSocket inbound events, Interactions HTTP Webhook verification, and reserved
 * streaming extension hooks.
 */
export class DiscordConnector<TName extends string = "discord"> implements Connector<
  TName,
  typeof discordSendSchema,
  typeof discordReceiveSchema,
  DiscordSendResult
> {
  readonly name: TName;
  readonly displayName: string;
  readonly description: string;

  readonly #api: DiscordRestClient | undefined;
  readonly #sender: DiscordSender<TName> | undefined;
  readonly #receiver: DiscordReceiver<TName>;
  readonly #gateway: DiscordGatewayClient | undefined;
  readonly #streamingOptions: DiscordStreamingOptions | undefined;
  readonly #streamingAdapter: DiscordStreamingAdapter | undefined;

  constructor(options: DiscordConnectorOptions<TName>) {
    const resolvedName = (options.name ?? DISCORD_CONNECTOR_DEFAULT_NAME) as TName;
    assertValidConnectorName(resolvedName);

    const botToken = options.botToken?.trim() || undefined;
    const publicKey = options.publicKey?.trim() || undefined;

    if (!botToken && !publicKey) {
      throw new ConnectorValidationError(
        "DiscordConnector requires at least one of botToken (Gateway/REST) or publicKey (Interactions Webhook)",
        { connectorName: resolvedName },
      );
    }

    this.name = resolvedName;
    this.displayName = options.displayName ?? "Discord";
    this.description =
      options.description ??
      "Discord Bot connector via API v10 REST, Gateway v10 WebSocket, and Ed25519 Interactions Webhook";

    this.#streamingOptions = options.streaming;
    this.#streamingAdapter = options.streamingAdapter;

    if (botToken) {
      this.#api = new DiscordRestClient({
        connectorName: resolvedName,
        botToken,
        baseUrl: options.apiBaseUrl,
        fetchFn: options.fetchFn,
        timeoutMs: options.requestTimeoutMs,
        allowedMentions: options.defaultAllowedMentions,
      });

      this.#sender = new DiscordSender<TName>({
        connectorName: this.name,
        api: this.#api,
        includeContextMarker: options.includeContextMarker,
        contextMarkerStyle: options.contextMarkerStyle,
        maxMessageLength: options.maxMessageLength,
      });
    }

    this.#receiver = new DiscordReceiver<TName>({
      connectorName: this.name,
      api: this.#api,
      publicKey,
      botUserId: options.botUserId,
      ignoreBotMessages: options.ignoreBotMessages,
      requireMentionInGuild: options.requireMentionInGuild,
      autoCreateThreadOnMention: options.autoCreateThreadOnMention,
      autoArchiveDurationMinutes: options.autoArchiveDurationMinutes,
    });

    const enableGateway = options.enableGateway ?? Boolean(botToken);
    if (enableGateway) {
      if (!botToken || !this.#api) {
        throw new ConnectorValidationError(
          "DiscordConnector cannot enable Gateway WebSocket without botToken",
          { connectorName: resolvedName },
        );
      }

      this.#gateway = new DiscordGatewayClient({
        connectorName: resolvedName,
        botToken,
        api: this.#api,
        intents: options.intents ?? DISCORD_DEFAULT_INTENTS,
        gatewayUrl: options.gatewayUrl,
        botUserId: options.botUserId,
        shard: options.shard,
        createWebSocket: options.createWebSocket,
        reconnectDelaysMs: options.reconnectDelaysMs,
        randomFn: options.randomFn,
        logger: options.logger,
        onMessageCreate: async (message, gatewayCtx) => {
          await this.#receiver.handleMessageCreate(message, gatewayCtx);
        },
      });
    }
  }

  getSender(): ConnectorSender<typeof discordSendSchema, DiscordSendResult, TName> | undefined {
    return this.#sender;
  }

  getReceiver(): ConnectorReceiver<typeof discordReceiveSchema, TName> | undefined {
    return this.#receiver;
  }

  /**
   * Returns the underlying Discord REST v10 client when configured with `botToken`.
   */
  getRestClient(): DiscordRestClient | undefined {
    return this.#api;
  }

  /**
   * Returns the reserved streaming adapter instance if one was registered in options.
   */
  getStreamingAdapter(): DiscordStreamingAdapter | undefined {
    return this.#streamingAdapter;
  }

  /**
   * Returns the reserved streaming options configuration if provided.
   */
  getStreamingOptions(): DiscordStreamingOptions | undefined {
    return this.#streamingOptions;
  }

  async start(): Promise<void> {
    if (!this.#gateway) {
      return;
    }
    await this.#gateway.start();
    const resolvedBotId = this.#gateway.getBotUserId();
    if (resolvedBotId) {
      this.#receiver.setBotUserId(resolvedBotId);
    }
  }

  async stop(): Promise<void> {
    if (!this.#gateway) {
      return;
    }
    await this.#gateway.stop();
  }
}

/**
 * Factory function creating a typed `DiscordConnector` instance.
 */
export function createDiscordConnector<TName extends string = "discord">(
  options: DiscordConnectorOptions<TName>,
): DiscordConnector<TName> {
  return new DiscordConnector(options);
}
