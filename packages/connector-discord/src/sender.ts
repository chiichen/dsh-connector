/**
 * Outbound `ConnectorSender` implementation for Discord REST API v10 (`POST /channels/{channel.id}/messages`).
 *
 * Implements:
 * 1. Unified `sender.schema` with `text` primary field and optional target overrides.
 * 2. Strict three-level target resolution (`params` > structured `context.contextId` > `ConnectorTargetRequiredError`).
 * 3. Optional `[#ctx:<contextId>]` header marker encoding prior to 2000-character chunking.
 * 4. Structured `DiscordSendResult` preserving `messageId`, `channelId`, `threadId`, and `raw` messages
 *    for future in-place editing / streaming continuation.
 *
 * @see https://discord.com/developers/docs/resources/message#create-message
 * @see https://discord.com/developers/docs/resources/user#create-dm
 */

import {
  prependContextMarker,
  type ConnectorContext,
  type ConnectorSender,
  type ConnectorSendOptions,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import type { DiscordRestClient } from "./api";
import { splitDiscordMessage } from "./chunking";
import { DISCORD_MAX_MESSAGE_LENGTH } from "./constants";
import { resolveDiscordSendTarget } from "./context-target";
import {
  discordSendSchema,
  type DiscordApiMessage,
  type DiscordSendParams,
  type DiscordSendResult,
} from "./types";

export interface DiscordSenderOptions<TName extends string = "discord"> {
  readonly connectorName: TName;
  readonly api: DiscordRestClient;
  readonly description?: string;
  readonly maxMessageLength?: number;
  readonly includeContextMarker?: boolean;
  readonly contextMarkerStyle?: ContextMarkerStyle;
}

export class DiscordSender<TName extends string = "discord"> implements ConnectorSender<
  typeof discordSendSchema,
  DiscordSendResult,
  TName
> {
  readonly schema = discordSendSchema;
  readonly description: string;

  readonly #connectorName: TName;
  readonly #api: DiscordRestClient;
  readonly #maxMessageLength: number;
  readonly #includeContextMarker: boolean;
  readonly #contextMarkerStyle: ContextMarkerStyle;
  readonly #dmChannelCache = new Map<string, string>();

  constructor(options: DiscordSenderOptions<TName>) {
    this.#connectorName = options.connectorName;
    this.#api = options.api;
    this.#maxMessageLength = options.maxMessageLength ?? DISCORD_MAX_MESSAGE_LENGTH;
    this.#includeContextMarker = options.includeContextMarker ?? false;
    this.#contextMarkerStyle = options.contextMarkerStyle ?? "bracket";
    this.description =
      options.description ??
      "Send a message to a Discord channel, thread, or Direct Message conversation via Discord REST API v10.";
  }

  async send(
    context: ConnectorContext<TName>,
    params: DiscordSendParams,
    options?: ConnectorSendOptions,
  ): Promise<DiscordSendResult> {
    const resolved = resolveDiscordSendTarget(context, params);

    let targetChannelId: string;
    let threadId: string | undefined;

    if (resolved.kind === "user") {
      const cachedDmId = this.#dmChannelCache.get(resolved.userId);
      if (cachedDmId !== undefined) {
        targetChannelId = cachedDmId;
      } else {
        const dmChannel = await this.#api.createDmChannel(resolved.userId, {
          signal: options?.signal,
        });
        targetChannelId = dmChannel.id;
        this.#dmChannelCache.set(resolved.userId, targetChannelId);
      }
    } else if (resolved.kind === "thread") {
      targetChannelId = resolved.channelId;
      threadId = resolved.threadId;
    } else {
      targetChannelId = resolved.channelId;
    }

    const shouldPrependMarker = params.includeContextMarker ?? this.#includeContextMarker;
    const preparedText = shouldPrependMarker
      ? prependContextMarker(params.text, context.contextId, this.#contextMarkerStyle)
      : params.text;

    const chunks = splitDiscordMessage(preparedText, this.#maxMessageLength);
    const rawMessages: DiscordApiMessage[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const sent = await this.#api.createMessage({
        channelId: targetChannelId,
        content: chunk,
        replyToMessageId: index === 0 ? params.replyToMessageId : undefined,
        signal: options?.signal,
      });
      rawMessages.push(sent);
    }

    const messageIds = rawMessages.map((msg) => msg.id);
    const primaryMessageId = messageIds[0]!;

    void this.#connectorName;

    return {
      externalId: primaryMessageId,
      messageId: primaryMessageId,
      messageIds,
      channelId: targetChannelId,
      ...(threadId !== undefined ? { threadId } : {}),
      summary:
        messageIds.length === 1
          ? `Sent Discord message ${primaryMessageId} to channel ${targetChannelId}.`
          : `Sent ${messageIds.length} Discord message chunks (first: ${primaryMessageId}) to channel ${targetChannelId}.`,
      raw: rawMessages,
      data: {
        messageId: primaryMessageId,
        messageIds,
        channelId: targetChannelId,
        ...(threadId !== undefined ? { threadId } : {}),
      },
    };
  }
}
