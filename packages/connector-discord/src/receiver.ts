/**
 * Discord inbound `ConnectorReceiver` implementation combining Gateway `MESSAGE_CREATE`
 * routing (DM / `@mention` Guild Channel / Thread + Bot self-loop filtering + Context Marker)
 * and Interactions HTTP Webhook handling.
 *
 * @see https://discord.com/developers/docs/events/gateway-events#message-create
 * @see https://discord.com/developers/docs/resources/message#message-object
 * @see https://discord.com/developers/docs/topics/threads
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding
 */

import {
  createConnectorContext,
  extractContextMarker,
  type ConnectorContext,
  type ConnectorInboundPrompt,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import type { DiscordRestClient } from "./api";
import {
  DISCORD_CONNECTOR_DEFAULT_NAME,
  DISCORD_DIRECT_CHANNEL_TYPES,
  DISCORD_IDEMPOTENCY_PREFIX_MESSAGE,
  DISCORD_MAX_THREAD_NAME_LENGTH,
  DISCORD_THREAD_CHANNEL_TYPES,
  DISCORD_USER_MESSAGE_TYPES,
} from "./constants";
import {
  formatDiscordChannelContextId,
  formatDiscordDmContextId,
  formatDiscordThreadContextId,
  stripDiscordBotMentions,
} from "./context-target";
import type { DiscordGatewayDispatchContext } from "./gateway";
import {
  discordReceiveSchema,
  type DiscordApiMessage,
  type DiscordChannel,
  type DiscordNormalizedAttachment,
  type DiscordReceiveEvent,
} from "./types";
import { handleDiscordInteractionWebhook } from "./webhook";

export interface DiscordReceiverOptions<TName extends string = "discord"> {
  readonly connectorName?: TName;
  readonly api?: DiscordRestClient;
  readonly publicKey?: string;
  readonly botUserId?: string;
  readonly ignoreBotMessages?: boolean;
  readonly requireMentionInGuild?: boolean;
  readonly autoCreateThreadOnMention?: boolean;
  readonly autoArchiveDurationMinutes?: 60 | 1440 | 4320 | 10080;
}

function isBotMentionedInMessage(
  message: DiscordApiMessage,
  botUserId: string | undefined,
): boolean {
  if (!botUserId) {
    return false;
  }
  if (message.mentions?.some((user) => user.id === botUserId)) {
    return true;
  }
  if (message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`)) {
    return true;
  }
  if (message.referenced_message?.author?.id === botUserId) {
    return true;
  }
  return false;
}

function normalizeAttachments(message: DiscordApiMessage): DiscordNormalizedAttachment[] {
  if (!message.attachments || message.attachments.length === 0) {
    return [];
  }
  return message.attachments.map((att) => ({
    id: att.id,
    filename: att.filename,
    url: att.url,
    ...(att.content_type ? { contentType: att.content_type } : {}),
    ...(typeof att.size === "number" ? { size: att.size } : {}),
  }));
}

function buildThreadStarterName(cleanText: string, authorName: string): string {
  const firstLine = cleanText.split(/\r?\n/u)[0]?.trim() ?? "";
  const candidate = firstLine || `Conversation with ${authorName}`;
  return candidate.length <= DISCORD_MAX_THREAD_NAME_LENGTH
    ? candidate
    : `${candidate.slice(0, DISCORD_MAX_THREAD_NAME_LENGTH - 1)}…`;
}

/**
 * Inbound receiver for `@dsh-connector/connector-discord`.
 */
export class DiscordReceiver<TName extends string = "discord"> implements ConnectorReceiver<
  typeof discordReceiveSchema,
  TName
> {
  readonly schema = discordReceiveSchema;

  readonly #connectorName: TName;
  readonly #api: DiscordRestClient | undefined;
  readonly #publicKey: string | undefined;
  readonly #ignoreBotMessages: boolean;
  readonly #requireMentionInGuild: boolean;
  readonly #autoCreateThreadOnMention: boolean;
  readonly #autoArchiveDurationMinutes: 60 | 1440 | 4320 | 10080 | undefined;

  #botUserId: string | undefined;
  #receiverContext: ConnectorReceiverContext<typeof discordReceiveSchema, TName> | undefined;

  constructor(options: DiscordReceiverOptions<TName> = {}) {
    this.#connectorName = (options.connectorName ?? DISCORD_CONNECTOR_DEFAULT_NAME) as TName;
    this.#api = options.api;
    this.#publicKey = options.publicKey?.trim() || undefined;
    this.#botUserId = options.botUserId?.trim() || undefined;
    this.#ignoreBotMessages = options.ignoreBotMessages ?? true;
    this.#requireMentionInGuild = options.requireMentionInGuild ?? true;
    this.#autoCreateThreadOnMention = options.autoCreateThreadOnMention ?? false;
    this.#autoArchiveDurationMinutes = options.autoArchiveDurationMinutes;
  }

  setBotUserId(botUserId: string): void {
    this.#botUserId = botUserId;
  }

  getReceiverContext(): ConnectorReceiverContext<typeof discordReceiveSchema, TName> | undefined {
    return this.#receiverContext;
  }

  async init(ctx: ConnectorReceiverContext<typeof discordReceiveSchema, TName>): Promise<void> {
    this.#receiverContext = ctx;
  }

  /**
   * Handles a Gateway `MESSAGE_CREATE` dispatch event.
   *
   * Enforces strict loop prevention (always drops messages sent by this bot itself,
   * and drops other bots/webhooks unless `ignoreBotMessages: false`), filters non-user
   * system message types, resolves DM / Guild `@mention` / Thread routing, and extracts
   * `[#ctx:...]` context markers from referenced or inline content.
   *
   * @see https://discord.com/developers/docs/events/gateway-events#message-create
   * @see https://discord.com/developers/docs/resources/message#message-object-message-types
   */
  async handleMessageCreate(
    message: DiscordApiMessage,
    gatewayCtx: DiscordGatewayDispatchContext,
  ): Promise<void> {
    const activeCtx = this.#receiverContext;
    if (!activeCtx) {
      return;
    }

    const effectiveBotUserId = gatewayCtx.botUserId ?? this.#botUserId;
    if (effectiveBotUserId && !this.#botUserId) {
      this.#botUserId = effectiveBotUserId;
    }

    // 1. Strict self-message filter (mandatory loop prevention)
    if (effectiveBotUserId && message.author.id === effectiveBotUserId) {
      return;
    }

    // 2. Bot & Webhook message filter
    if (this.#ignoreBotMessages && (message.author.bot === true || Boolean(message.webhook_id))) {
      return;
    }

    // 3. System / non-conversational message type filter (e.g. THREAD_STARTER_MESSAGE = 21)
    if (!DISCORD_USER_MESSAGE_TYPES.has(message.type)) {
      return;
    }

    // 4. Resolve channel & thread metadata
    let channelMeta: DiscordChannel | undefined = gatewayCtx.getCachedChannel(message.channel_id);
    let channelType = message.channel_type ?? channelMeta?.type;

    if (channelType === undefined && message.guild_id && this.#api) {
      try {
        channelMeta = await this.#api.getChannel(message.channel_id);
        gatewayCtx.rememberChannel(channelMeta);
        channelType = channelMeta.type;
      } catch (err) {
        activeCtx.logger?.debug("Failed to fetch uncached Discord channel metadata", {
          channelId: message.channel_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const isDirectMessage =
      !message.guild_id ||
      (channelType !== undefined && DISCORD_DIRECT_CHANNEL_TYPES.has(channelType));
    let isThread =
      !isDirectMessage &&
      channelType !== undefined &&
      DISCORD_THREAD_CHANNEL_TYPES.has(channelType);
    let parentChannelId = channelMeta?.parent_id ?? undefined;

    if (isThread && !parentChannelId && this.#api) {
      try {
        channelMeta = await this.#api.getChannel(message.channel_id);
        gatewayCtx.rememberChannel(channelMeta);
        parentChannelId = channelMeta.parent_id ?? undefined;
      } catch {
        // Proceed with single-segment thread:<threadId> fallback if parent lookup fails
      }
    }

    const mentionedBot = isBotMentionedInMessage(message, effectiveBotUserId);

    // 5. Guild non-thread channel requires @bot mention (or reply to bot) by default
    if (!isDirectMessage && !isThread && this.#requireMentionInGuild && !mentionedBot) {
      return;
    }

    // 6. Extract context marker from referenced parent message or current message content
    const refMarker = message.referenced_message?.content
      ? extractContextMarker(message.referenced_message.content)
      : undefined;
    const contentWithoutMention = effectiveBotUserId
      ? stripDiscordBotMentions(message.content, effectiveBotUserId)
      : message.content.trim();
    const selfMarker = extractContextMarker(contentWithoutMention);

    const extractedContextId = refMarker?.contextId ?? selfMarker.contextId;
    const cleanText = selfMarker.cleanedContent.trim();
    const attachments = normalizeAttachments(message);

    if (!cleanText && attachments.length === 0) {
      return;
    }

    const authorName =
      message.member?.nick?.trim() || message.author.global_name?.trim() || message.author.username;

    // 7. Optional auto-thread creation on Guild channel @mention
    let effectiveChannelId = message.channel_id;
    let effectiveThreadId = isThread ? message.channel_id : undefined;

    if (
      !isDirectMessage &&
      !isThread &&
      this.#autoCreateThreadOnMention &&
      this.#api &&
      !extractedContextId
    ) {
      try {
        const createdThread = await this.#api.startThreadFromMessage({
          channelId: message.channel_id,
          messageId: message.id,
          name: buildThreadStarterName(cleanText, authorName),
          ...(this.#autoArchiveDurationMinutes !== undefined
            ? { autoArchiveDuration: this.#autoArchiveDurationMinutes }
            : {}),
        });
        gatewayCtx.rememberChannel(createdThread);
        isThread = true;
        parentChannelId = message.channel_id;
        effectiveChannelId = createdThread.id;
        effectiveThreadId = createdThread.id;
      } catch (err) {
        activeCtx.logger?.warn(
          "Failed to auto-create Discord thread from @mention; falling back to channel",
          {
            channelId: message.channel_id,
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    const defaultContextId = isDirectMessage
      ? formatDiscordDmContextId(effectiveChannelId)
      : isThread && effectiveThreadId
        ? formatDiscordThreadContextId(effectiveThreadId, parentChannelId)
        : formatDiscordChannelContextId(effectiveChannelId);

    const context = createConnectorContext(
      this.#connectorName,
      extractedContextId ?? defaultContextId,
    );

    const effectiveText =
      cleanText ||
      attachments.map((att) => `[attachment: ${att.filename} (${att.url})]`).join("\n");

    const replyToMessageId =
      message.referenced_message?.id ?? message.message_reference?.message_id;
    const referencedText = refMarker
      ? refMarker.cleanedContent
      : message.referenced_message?.content || undefined;

    const receiveEvent: DiscordReceiveEvent = {
      source: "gateway-message",
      eventId: message.id,
      channelId: effectiveChannelId,
      ...(message.guild_id ? { guildId: message.guild_id } : {}),
      ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
      ...(isThread && parentChannelId ? { parentChannelId } : {}),
      authorId: message.author.id,
      authorName,
      text: effectiveText,
      rawContent: message.content,
      isDirectMessage,
      isThread,
      mentionedBot,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(referencedText ? { referencedText } : {}),
      attachments,
      timestamp: message.timestamp,
    };

    const parsedTimestamp = Date.parse(message.timestamp);
    await activeCtx.onReceive(context, receiveEvent, {
      idempotencyKey: `${DISCORD_IDEMPOTENCY_PREFIX_MESSAGE}${message.id}`,
      receivedAt: Number.isNaN(parsedTimestamp) ? Date.now() : parsedTimestamp,
      suggestedTitle: isDirectMessage
        ? `Discord DM (${authorName})`
        : channelMeta?.name
          ? `Discord #${channelMeta.name}`
          : `Discord (${authorName})`,
    });
  }

  /**
   * Handles incoming Discord Interactions HTTP Webhook requests.
   *
   * @see https://discord.com/developers/docs/interactions/overview
   */
  async handleWebhook(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> {
    return await handleDiscordInteractionWebhook(req, {
      connectorName: this.#connectorName,
      ...(this.#publicKey !== undefined ? { publicKey: this.#publicKey } : {}),
      ...(this.#botUserId !== undefined ? { botUserId: this.#botUserId } : {}),
      ignoreBotMessages: this.#ignoreBotMessages,
      ...(this.#receiverContext !== undefined ? { receiverContext: this.#receiverContext } : {}),
    });
  }

  /**
   * Formats a validated `DiscordReceiveEvent` into a structured prompt for the host session.
   */
  formatInbound(
    params: DiscordReceiveEvent,
    context: ConnectorContext<TName>,
  ): ConnectorInboundPrompt {
    const scopeLabel = params.isDirectMessage
      ? "Direct Message"
      : params.isThread
        ? `Thread ${params.threadId ?? params.channelId}`
        : `Channel ${params.channelId}`;

    const lines: string[] = [];
    if (params.referencedText) {
      lines.push(`> Replying to: ${params.referencedText}`);
      lines.push("");
    }
    lines.push(params.text);

    const attachments = params.attachments ?? [];
    if (attachments.length > 0 && params.text !== "") {
      const hasAttachmentUrls = attachments.every((a) => params.text.includes(a.url));
      if (!hasAttachmentUrls) {
        lines.push("");
        lines.push("Attachments:");
        for (const att of attachments) {
          lines.push(`- ${att.filename}: ${att.url}`);
        }
      }
    }

    return {
      title: `[Discord ${scopeLabel}] ${params.authorName} (${context.contextId})`,
      text: lines.join("\n"),
    };
  }
}
