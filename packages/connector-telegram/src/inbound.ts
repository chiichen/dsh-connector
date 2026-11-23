import {
  extractContextMarker,
  type ConnectorContext,
  type ConnectorContextId,
  type ConnectorInboundPrompt,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import { MS_PER_SECOND } from "./constants";
import { formatTelegramContextId } from "./context-target";
import type {
  TelegramChat,
  TelegramChatType,
  TelegramGroupTriggerMode,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramRawMessageGenerationStopped,
  TelegramReceivePayload,
  TelegramTextQuote,
  TelegramUpdate,
  TelegramUser,
} from "./types";

export interface NormalizeTelegramUpdateOptions {
  readonly botId?: number;
  readonly botUsername?: string;
  readonly groupTriggerMode?: TelegramGroupTriggerMode;
  readonly allowedChatIds?: ReadonlyArray<number | string>;
  readonly allowedUserIds?: ReadonlyArray<number | string>;
  readonly acceptEditedMessages?: boolean;
  readonly inboundDeliveryMode?: "queue" | "steer";
}

export interface NormalizedTelegramInbound {
  readonly contextId: ConnectorContextId;
  readonly payload: TelegramReceivePayload;
  readonly meta: InboundDeliveryMeta;
}

const VALID_CHAT_TYPES = new Set<TelegramChatType>(["private", "group", "supergroup", "channel"]);
const USERNAME_CHAR_PATTERN = /[A-Za-z0-9_]/;
const IDEMPOTENCY_PREFIX = "telegram" as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUser(raw: unknown): TelegramUser | undefined {
  if (
    !isPlainObject(raw) ||
    typeof raw["id"] !== "number" ||
    !Number.isSafeInteger(raw["id"]) ||
    typeof raw["is_bot"] !== "boolean" ||
    typeof raw["first_name"] !== "string"
  ) {
    return undefined;
  }

  return {
    id: raw["id"],
    is_bot: raw["is_bot"],
    first_name: raw["first_name"],
    ...(typeof raw["last_name"] === "string" ? { last_name: raw["last_name"] } : {}),
    ...(typeof raw["username"] === "string" ? { username: raw["username"] } : {}),
    ...(typeof raw["language_code"] === "string" ? { language_code: raw["language_code"] } : {}),
  };
}

function parseChat(raw: unknown): TelegramChat | undefined {
  if (
    !isPlainObject(raw) ||
    typeof raw["id"] !== "number" ||
    !Number.isSafeInteger(raw["id"]) ||
    typeof raw["type"] !== "string" ||
    !VALID_CHAT_TYPES.has(raw["type"] as TelegramChatType)
  ) {
    return undefined;
  }

  return {
    id: raw["id"],
    type: raw["type"] as TelegramChatType,
    ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
    ...(typeof raw["username"] === "string" ? { username: raw["username"] } : {}),
    ...(typeof raw["first_name"] === "string" ? { first_name: raw["first_name"] } : {}),
    ...(typeof raw["last_name"] === "string" ? { last_name: raw["last_name"] } : {}),
    ...(typeof raw["is_forum"] === "boolean" ? { is_forum: raw["is_forum"] } : {}),
  };
}

function parseEntities(raw: unknown): readonly TelegramMessageEntity[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const entities: TelegramMessageEntity[] = [];
  for (const item of raw) {
    if (
      !isPlainObject(item) ||
      typeof item["type"] !== "string" ||
      typeof item["offset"] !== "number" ||
      !Number.isInteger(item["offset"]) ||
      typeof item["length"] !== "number" ||
      !Number.isInteger(item["length"])
    ) {
      continue;
    }
    const user = parseUser(item["user"]);
    entities.push({
      type: item["type"],
      offset: item["offset"],
      length: item["length"],
      ...(typeof item["url"] === "string" ? { url: item["url"] } : {}),
      ...(user !== undefined ? { user } : {}),
      ...(typeof item["language"] === "string" ? { language: item["language"] } : {}),
      ...(typeof item["custom_emoji_id"] === "string"
        ? { custom_emoji_id: item["custom_emoji_id"] }
        : {}),
    });
  }
  return entities;
}

function parseQuote(raw: unknown): TelegramTextQuote | undefined {
  if (
    !isPlainObject(raw) ||
    typeof raw["text"] !== "string" ||
    typeof raw["position"] !== "number"
  ) {
    return undefined;
  }
  const entities = parseEntities(raw["entities"]);
  return {
    text: raw["text"],
    position: raw["position"],
    ...(entities !== undefined ? { entities } : {}),
    ...(typeof raw["is_manual"] === "boolean" ? { is_manual: raw["is_manual"] } : {}),
  };
}

function parseMessage(raw: unknown, allowNestedReply: boolean): TelegramMessage | undefined {
  if (
    !isPlainObject(raw) ||
    typeof raw["message_id"] !== "number" ||
    !Number.isSafeInteger(raw["message_id"]) ||
    typeof raw["date"] !== "number" ||
    !Number.isSafeInteger(raw["date"])
  ) {
    return undefined;
  }

  const chat = parseChat(raw["chat"]);
  if (chat === undefined) {
    return undefined;
  }

  const from = parseUser(raw["from"]);
  const senderChat = parseChat(raw["sender_chat"]);
  const entities = parseEntities(raw["entities"]);
  const captionEntities = parseEntities(raw["caption_entities"]);
  const quote = parseQuote(raw["quote"]);
  const replyToMessage = allowNestedReply
    ? parseMessage(raw["reply_to_message"], false)
    : undefined;

  return {
    message_id: raw["message_id"],
    date: raw["date"],
    chat,
    ...(typeof raw["message_thread_id"] === "number" &&
    Number.isSafeInteger(raw["message_thread_id"])
      ? { message_thread_id: raw["message_thread_id"] }
      : {}),
    ...(from !== undefined ? { from } : {}),
    ...(senderChat !== undefined ? { sender_chat: senderChat } : {}),
    ...(typeof raw["is_topic_message"] === "boolean"
      ? { is_topic_message: raw["is_topic_message"] }
      : {}),
    ...(typeof raw["is_automatic_forward"] === "boolean"
      ? { is_automatic_forward: raw["is_automatic_forward"] }
      : {}),
    ...(replyToMessage !== undefined ? { reply_to_message: replyToMessage } : {}),
    ...(quote !== undefined ? { quote } : {}),
    ...(typeof raw["text"] === "string" ? { text: raw["text"] } : {}),
    ...(entities !== undefined ? { entities } : {}),
    ...(typeof raw["caption"] === "string" ? { caption: raw["caption"] } : {}),
    ...(captionEntities !== undefined ? { caption_entities: captionEntities } : {}),
  };
}

function parseStoppedGeneration(raw: unknown): TelegramRawMessageGenerationStopped | undefined {
  if (
    !isPlainObject(raw) ||
    typeof raw["draft_id"] !== "number" ||
    !Number.isSafeInteger(raw["draft_id"])
  ) {
    return undefined;
  }
  const chat = parseChat(raw["chat"]);
  if (chat === undefined) {
    return undefined;
  }
  return {
    chat,
    draft_id: raw["draft_id"],
    ...(typeof raw["message_thread_id"] === "number" &&
    Number.isSafeInteger(raw["message_thread_id"])
      ? { message_thread_id: raw["message_thread_id"] }
      : {}),
  };
}

/**
 * Safely parses an untrusted JSON value into a typed `TelegramUpdate` envelope.
 *
 * @see https://core.telegram.org/bots/api#update
 */
export function parseRawTelegramUpdate(raw: unknown): TelegramUpdate | undefined {
  if (
    !isPlainObject(raw) ||
    typeof raw["update_id"] !== "number" ||
    !Number.isSafeInteger(raw["update_id"])
  ) {
    return undefined;
  }

  const message = parseMessage(raw["message"], true);
  const editedMessage = parseMessage(raw["edited_message"], true);
  const channelPost = parseMessage(raw["channel_post"], true);
  const editedChannelPost = parseMessage(raw["edited_channel_post"], true);
  const stoppedGeneration = parseStoppedGeneration(raw["stopped_message_generation"]);

  return {
    update_id: raw["update_id"],
    ...(message !== undefined ? { message } : {}),
    ...(editedMessage !== undefined ? { edited_message: editedMessage } : {}),
    ...(channelPost !== undefined ? { channel_post: channelPost } : {}),
    ...(editedChannelPost !== undefined ? { edited_channel_post: editedChannelPost } : {}),
    ...(stoppedGeneration !== undefined ? { stopped_message_generation: stoppedGeneration } : {}),
  };
}

function normalizeBotUsername(username?: string): string | undefined {
  if (username === undefined) {
    return undefined;
  }
  const cleaned = username.trim().replace(/^@+/, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

function isUsernameBoundary(char: string | undefined): boolean {
  return char === undefined || !USERNAME_CHAR_PATTERN.test(char);
}

function containsTextualBotMention(text: string, botUsername: string): boolean {
  const target = `@${botUsername.toLowerCase()}`;
  let index = 0;
  while (index < text.length) {
    if (
      text[index] === "@" &&
      text.slice(index, index + target.length).toLowerCase() === target &&
      isUsernameBoundary(text[index + target.length])
    ) {
      return true;
    }
    index += 1;
  }
  return false;
}

/**
 * Evaluates Telegram `MessageEntity` UTF-16 `offset`/`length` entries (`mention`, `bot_command`,
 * `text_mention`) plus boundary-safe `@username` fallback.
 *
 * @see https://core.telegram.org/bots/api#messageentity
 */
function detectBotMention(
  text: string,
  entities: readonly TelegramMessageEntity[] | undefined,
  botId: number | undefined,
  botUsername: string | undefined,
): boolean {
  const lowerHandle = botUsername !== undefined ? `@${botUsername.toLowerCase()}` : undefined;

  if (entities !== undefined) {
    for (const entity of entities) {
      if (entity.offset < 0 || entity.length <= 0 || entity.offset + entity.length > text.length) {
        continue;
      }
      const segment = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (entity.type === "mention" && lowerHandle !== undefined && segment === lowerHandle) {
        return true;
      }
      if (
        entity.type === "bot_command" &&
        lowerHandle !== undefined &&
        segment.endsWith(lowerHandle)
      ) {
        return true;
      }
      if (entity.type === "text_mention" && botId !== undefined && entity.user?.id === botId) {
        return true;
      }
    }
  }

  if (botUsername !== undefined) {
    return containsTextualBotMention(text, botUsername);
  }

  return false;
}

function stripBotMention(text: string, botUsername: string | undefined): string {
  if (botUsername === undefined) {
    return text.trim();
  }
  const target = `@${botUsername.toLowerCase()}`;
  let out = "";
  let offset = 0;

  while (offset < text.length) {
    if (
      text[offset] === "@" &&
      text.slice(offset, offset + target.length).toLowerCase() === target &&
      isUsernameBoundary(text[offset + target.length])
    ) {
      const nextOffset = offset + target.length;
      if (out.endsWith(" ") && text[nextOffset] === " ") {
        offset = nextOffset + 1;
      } else {
        offset = nextOffset;
      }
      continue;
    }
    out += text[offset];
    offset += 1;
  }

  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : text.trim();
}

function matchesAllowlist(
  allowlist: ReadonlyArray<number | string> | undefined,
  numericId: number,
  username: string | undefined,
): boolean {
  if (allowlist === undefined || allowlist.length === 0) {
    return true;
  }
  const idStr = String(numericId);
  const handleLower = username !== undefined ? `@${username.toLowerCase()}` : undefined;
  const bareLower = username?.toLowerCase();

  for (const rawAllowed of allowlist) {
    const token = String(rawAllowed).trim().toLowerCase();
    if (token === idStr) {
      return true;
    }
    if (handleLower !== undefined && (token === handleLower || token === bareLower)) {
      return true;
    }
  }
  return false;
}

function formatUserDisplayName(user: TelegramUser): string {
  return [user.first_name, user.last_name]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .trim();
}

function extractReplyReference(message: TelegramMessage): {
  readonly replyToMessage: TelegramReceivePayload["replyToMessage"];
  readonly extractedContextId: ConnectorContextId | undefined;
} {
  const reply = message.reply_to_message;
  if (reply === undefined) {
    return { replyToMessage: undefined, extractedContextId: undefined };
  }

  const rawReplyText = reply.text ?? reply.caption;
  const markerResult =
    rawReplyText !== undefined
      ? extractContextMarker(rawReplyText)
      : { contextId: undefined, cleanedContent: "" };

  const fromName =
    reply.from !== undefined ? formatUserDisplayName(reply.from) : reply.sender_chat?.title?.trim();

  const cleanedReplyText = markerResult.cleanedContent.trim();
  const quoteText = message.quote?.text.trim();

  return {
    extractedContextId: markerResult.contextId,
    replyToMessage: {
      messageId: reply.message_id,
      ...(reply.from?.id !== undefined ? { fromId: reply.from.id } : {}),
      ...(reply.from?.username !== undefined ? { fromUsername: reply.from.username } : {}),
      ...(fromName !== undefined && fromName.length > 0 ? { fromName } : {}),
      isFromBot: reply.from?.is_bot === true,
      ...(cleanedReplyText.length > 0 ? { text: cleanedReplyText } : {}),
      ...(quoteText !== undefined && quoteText.length > 0 ? { quote: quoteText } : {}),
      date: reply.date,
    },
  };
}

/**
 * Normalizes a Telegram `Update` into a routed `NormalizedTelegramInbound` record, applying:
 * - Bot self-message and bot-account loop filtering
 * - Channel / automatic-forward / empty-message filtering
 * - Chat & user allowlists
 * - Private direct vs. group `@mention` / `text_mention` / `/cmd@bot` / reply-to-bot trigger gating
 * - Forum Topic `message_thread_id` context routing and context marker extraction
 * - `reply_to_message` & `TextQuote` citation provenance
 *
 * @see https://core.telegram.org/bots/api#update
 * @see https://core.telegram.org/bots/api#message
 */
export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  options: NormalizeTelegramUpdateOptions,
): NormalizedTelegramInbound | undefined {
  const message =
    update.message ?? (options.acceptEditedMessages === true ? update.edited_message : undefined);
  if (message === undefined || message.from === undefined) {
    return undefined;
  }

  if (message.is_automatic_forward === true) {
    return undefined;
  }

  const botId = options.botId;
  const botUsername = normalizeBotUsername(options.botUsername);

  // Anti-loop: unconditionally drop messages authored by bots or matching this bot's identity
  if (message.from.is_bot) {
    return undefined;
  }
  if (botId !== undefined && message.from.id === botId) {
    return undefined;
  }
  if (
    botUsername !== undefined &&
    message.from.username !== undefined &&
    message.from.username.toLowerCase() === botUsername.toLowerCase()
  ) {
    return undefined;
  }

  const chatType = message.chat.type;
  if (chatType !== "private" && chatType !== "group" && chatType !== "supergroup") {
    return undefined;
  }

  if (!matchesAllowlist(options.allowedChatIds, message.chat.id, message.chat.username)) {
    return undefined;
  }
  if (!matchesAllowlist(options.allowedUserIds, message.from.id, message.from.username)) {
    return undefined;
  }

  const rawText = message.text ?? message.caption ?? "";
  if (rawText.trim().length === 0) {
    return undefined;
  }

  const entities = message.text !== undefined ? message.entities : message.caption_entities;
  const mentionedBot = detectBotMention(rawText, entities, botId, botUsername);
  const repliedToBot =
    (botId !== undefined && message.reply_to_message?.from?.id === botId) ||
    (botUsername !== undefined &&
      message.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase());

  if (chatType === "group" || chatType === "supergroup") {
    const mode = options.groupTriggerMode ?? "mention";
    if (mode === "off") {
      return undefined;
    }
    if (mode === "mention" && !mentionedBot && !repliedToBot) {
      return undefined;
    }
  }

  const bodyMarker = extractContextMarker(rawText);
  const { replyToMessage, extractedContextId: replyContextId } = extractReplyReference(message);

  const messageThreadId =
    message.message_thread_id !== undefined &&
    Number.isSafeInteger(message.message_thread_id) &&
    message.message_thread_id > 0
      ? message.message_thread_id
      : undefined;

  const fallbackBusinessContextId = formatTelegramContextId({
    chatType,
    chatId: message.chat.id,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
  });

  const contextId = bodyMarker.contextId ?? replyContextId ?? fallbackBusinessContextId;
  const cleanedText = mentionedBot
    ? stripBotMention(bodyMarker.cleanedContent, botUsername)
    : bodyMarker.cleanedContent.trim();

  if (cleanedText.length === 0) {
    return undefined;
  }

  const senderDisplayName = formatUserDisplayName(message.from) || String(message.from.id);
  const baseTitle =
    chatType === "private"
      ? `[Telegram] ${senderDisplayName}`
      : `[Telegram] ${message.chat.title ?? String(message.chat.id)}`;
  const suggestedTitle =
    messageThreadId !== undefined ? `${baseTitle} #${messageThreadId}` : baseTitle;

  const payload: TelegramReceivePayload = {
    updateId: update.update_id,
    messageId: message.message_id,
    chatId: message.chat.id,
    chatType,
    ...(message.chat.title !== undefined ? { chatTitle: message.chat.title } : {}),
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    ...(message.is_topic_message !== undefined ? { isTopicMessage: message.is_topic_message } : {}),
    from: {
      id: message.from.id,
      isBot: message.from.is_bot,
      firstName: message.from.first_name,
      ...(message.from.last_name !== undefined ? { lastName: message.from.last_name } : {}),
      ...(message.from.username !== undefined ? { username: message.from.username } : {}),
    },
    text: cleanedText,
    rawText,
    date: message.date,
    mentionedBot,
    ...(replyToMessage !== undefined ? { replyToMessage } : {}),
  };

  const meta: InboundDeliveryMeta = {
    idempotencyKey: `${IDEMPOTENCY_PREFIX}:${message.chat.id}:${message.message_id}`,
    suggestedTitle,
    receivedAt: message.date * MS_PER_SECOND,
    deliveryMode: options.inboundDeliveryMode ?? "queue",
  };

  return {
    contextId,
    payload,
    meta,
  };
}

/**
 * Formats a normalized `TelegramReceivePayload` into a human- and LLM-readable
 * `ConnectorInboundPrompt`, preserving sender identity, Forum Topic thread context, and
 * `reply_to_message` / `quote` citation provenance.
 */
export function formatTelegramInboundPrompt(
  payload: TelegramReceivePayload,
  context: ConnectorContext,
): ConnectorInboundPrompt {
  const senderFullName = [payload.from.firstName, payload.from.lastName]
    .filter((item): item is string => item !== undefined && item.length > 0)
    .join(" ");
  const senderHandle = payload.from.username !== undefined ? ` (@${payload.from.username})` : "";
  const topicSuffix =
    payload.messageThreadId !== undefined ? ` | topic #${payload.messageThreadId}` : "";
  const titleBase =
    payload.chatType === "private"
      ? `[Telegram] ${senderFullName}`
      : `[Telegram] ${payload.chatTitle ?? String(payload.chatId)}`;
  const title =
    payload.messageThreadId !== undefined ? `${titleBase} #${payload.messageThreadId}` : titleBase;

  const lines: string[] = [
    `[Telegram ${payload.chatType} | chatId: ${payload.chatId}${topicSuffix} | messageId: ${payload.messageId} | contextId: ${context.contextId}]`,
    `From: ${senderFullName}${senderHandle} (userId: ${payload.from.id})`,
  ];

  if (payload.replyToMessage !== undefined) {
    const reply = payload.replyToMessage;
    const replyAuthor =
      reply.fromName ?? (reply.fromUsername !== undefined ? `@${reply.fromUsername}` : "unknown");
    lines.push(`Replying to message #${reply.messageId} from ${replyAuthor}:`);
    if (reply.quote !== undefined) {
      lines.push(`> [Selected quote] ${reply.quote}`);
    }
    if (reply.text !== undefined) {
      for (const quotedLine of reply.text.split("\n")) {
        lines.push(`> ${quotedLine}`);
      }
    }
  }

  lines.push("", payload.text);

  return {
    title,
    text: lines.join("\n"),
  };
}
