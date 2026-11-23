/**
 * Feishu (Lark) inbound `im.message.receive_v1` event parser, bot self-message
 * loop guard, `p2p` / `group` `@` mention filter, and `text` / `post` / `interactive`
 * content extractor.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/intro
 */

import { FEISHU_AT_ALL_MENTION_KEY } from "./constants";
import type { FeishuFetchedMessageItem } from "./api-client";
import type { FeishuInboundMessage } from "./context";

export type FeishuGroupMentionPolicy = "mention-required" | "all";

export interface FeishuMessageFilterOptions {
  readonly appId?: string;
  readonly botOpenId?: string;
  readonly botName?: string;
  readonly allowedOpenIds?: readonly string[];
  readonly groupMentionPolicy?: FeishuGroupMentionPolicy;
  readonly allowAtAllInGroup?: boolean;
}

export type FeishuParsedEventOutcome =
  | {
      readonly accepted: true;
      readonly message: FeishuInboundMessage;
    }
  | {
      readonly accepted: false;
      readonly reason:
        | "invalid_event_payload"
        | "bot_self_message"
        | "sender_not_allowed"
        | "group_not_mentioned"
        | "empty_or_unsupported_message";
    };

interface NormalizedMention {
  readonly key: string;
  readonly openId?: string;
  readonly userId?: string;
  readonly name?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (isPlainRecord(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMentions(rawMentions: unknown): NormalizedMention[] {
  if (!Array.isArray(rawMentions)) return [];
  const list: NormalizedMention[] = [];
  for (const item of rawMentions) {
    if (!isPlainRecord(item)) continue;
    const key = nonEmptyTrimmed(item["key"]);
    if (key === undefined) continue;
    const rawId = item["id"];
    let openId: string | undefined;
    let userId: string | undefined;
    if (typeof rawId === "string") {
      openId = nonEmptyTrimmed(rawId);
    } else if (isPlainRecord(rawId)) {
      openId = nonEmptyTrimmed(rawId["open_id"]);
      userId = nonEmptyTrimmed(rawId["user_id"]);
    }
    const name = nonEmptyTrimmed(item["name"]);
    list.push({
      key,
      ...(openId !== undefined ? { openId } : {}),
      ...(userId !== undefined ? { userId } : {}),
      ...(name !== undefined ? { name } : {}),
    });
  }
  return list;
}

function isBotMention(
  mention: NormalizedMention,
  options: {
    readonly botOpenId?: string;
    readonly botName?: string;
    readonly allowAtAll?: boolean;
  },
): boolean {
  if (mention.key === FEISHU_AT_ALL_MENTION_KEY) {
    return options.allowAtAll === true;
  }
  if (options.botOpenId !== undefined) {
    return mention.openId === options.botOpenId;
  }
  if (options.botName !== undefined) {
    return mention.name === options.botName;
  }
  return true;
}

function applyMentionReplacements(
  rawText: string,
  mentions: readonly NormalizedMention[],
  options: {
    readonly botOpenId?: string;
    readonly botName?: string;
    readonly allowAtAll?: boolean;
  },
): string {
  let text = rawText;
  const hasExplicitBotIdentity = options.botOpenId !== undefined || options.botName !== undefined;

  for (const mention of mentions) {
    if (mention.key === FEISHU_AT_ALL_MENTION_KEY) {
      text = text.replaceAll(mention.key, "");
      continue;
    }
    if (!hasExplicitBotIdentity || isBotMention(mention, options)) {
      text = text.replaceAll(mention.key, "");
    } else if (mention.name !== undefined) {
      text = text.replaceAll(mention.key, `@${mention.name}`);
    } else {
      text = text.replaceAll(mention.key, "");
    }
  }
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

function extractPostParagraphs(
  postRoot: Record<string, unknown>,
  mentions: readonly NormalizedMention[],
  mentionOpts: {
    readonly botOpenId?: string;
    readonly botName?: string;
    readonly allowAtAll?: boolean;
  },
): string {
  // Official Feishu `post` messages may either carry `{ title, content }` directly
  // or nest localized blocks `{ zh_cn: { title, content }, en_us: ... }`.
  let activeBlock: Record<string, unknown> = postRoot;
  if (!Array.isArray(postRoot["content"])) {
    const localizedCandidate =
      (isPlainRecord(postRoot["zh_cn"]) ? postRoot["zh_cn"] : undefined) ??
      (isPlainRecord(postRoot["en_us"]) ? postRoot["en_us"] : undefined) ??
      Object.values(postRoot).find(
        (v): v is Record<string, unknown> => isPlainRecord(v) && Array.isArray(v["content"]),
      );
    if (localizedCandidate !== undefined) {
      activeBlock = localizedCandidate;
    }
  }

  const lines: string[] = [];
  const rawTitle = nonEmptyTrimmed(activeBlock["title"]);
  if (rawTitle !== undefined) {
    const cleanedTitle = applyMentionReplacements(rawTitle, mentions, mentionOpts);
    if (cleanedTitle.length > 0) {
      lines.push(cleanedTitle);
    }
  }

  const paragraphs = Array.isArray(activeBlock["content"]) ? activeBlock["content"] : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    let lineAcc = "";
    for (const elem of paragraph) {
      if (!isPlainRecord(elem)) continue;
      const tag = typeof elem["tag"] === "string" ? elem["tag"].toLowerCase() : "";
      if (tag === "text" || tag === "a" || tag === "link" || tag === "code_block") {
        if (typeof elem["text"] === "string") {
          lineAcc += elem["text"];
        }
      } else if (tag === "at") {
        const userId = nonEmptyTrimmed(elem["user_id"]);
        const userName = nonEmptyTrimmed(elem["user_name"]);
        if (
          userId !== undefined &&
          userId !== FEISHU_AT_ALL_MENTION_KEY &&
          mentionOpts.botOpenId !== undefined &&
          userId !== mentionOpts.botOpenId &&
          userName !== undefined
        ) {
          lineAcc += `@${userName}`;
        }
      }
    }
    const cleanedLine = applyMentionReplacements(lineAcc, mentions, mentionOpts);
    if (cleanedLine.length > 0) {
      lines.push(cleanedLine);
    }
  }

  return lines.join("\n").trim();
}

const MAX_CARD_DEPTH = 10 as const;

function collectCardVisibleText(node: unknown, depth = 0): string {
  if (depth > MAX_CARD_DEPTH) return "";
  if (Array.isArray(node)) {
    return node
      .map((child) => collectCardVisibleText(child, depth + 1))
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (!isPlainRecord(node)) return "";

  const tag = typeof node["tag"] === "string" ? node["tag"].toLowerCase() : "";
  if (tag === "markdown" || tag === "lark_md" || tag === "plain_text" || tag === "text") {
    const content = nonEmptyTrimmed(node["content"]) ?? nonEmptyTrimmed(node["text"]);
    return content ?? "";
  }

  if (tag === "div") {
    const divText = collectCardVisibleText(node["text"], depth + 1);
    const divFields = collectCardVisibleText(node["fields"], depth + 1);
    return [divText, divFields].filter((p) => p.length > 0).join("\n");
  }

  const containerKeys = ["elements", "columns", "fields", "children"] as const;
  return containerKeys
    .map((k) => collectCardVisibleText(node[k], depth + 1))
    .filter((p) => p.length > 0)
    .join("\n");
}

function extractInteractiveCardText(parsedContent: Record<string, unknown>): string {
  const cardRoot =
    parseJsonObject(parsedContent["json_card"]) ??
    parseJsonObject(parsedContent["card"]) ??
    parsedContent;

  const header = isPlainRecord(cardRoot["header"]) ? cardRoot["header"] : undefined;
  const titleText =
    (header !== undefined ? collectCardVisibleText(header["title"]) : "") ||
    (nonEmptyTrimmed(cardRoot["title"]) ?? "");
  const body = isPlainRecord(cardRoot["body"]) ? cardRoot["body"] : undefined;
  const elements = body?.["elements"] ?? cardRoot["elements"];
  const bodyText = collectCardVisibleText(elements);

  return [titleText, bodyText]
    .filter((p) => p.length > 0)
    .join("\n")
    .trim();
}

function extractMessageTextByType(
  messageType: string,
  rawContent: unknown,
  mentions: readonly NormalizedMention[],
  mentionOpts: {
    readonly botOpenId?: string;
    readonly botName?: string;
    readonly allowAtAll?: boolean;
  },
): string {
  const parsed = parseJsonObject(rawContent);
  if (parsed === undefined) return "";

  if (messageType === "text") {
    const rawText = typeof parsed["text"] === "string" ? parsed["text"] : "";
    return applyMentionReplacements(rawText, mentions, mentionOpts);
  }
  if (messageType === "post") {
    return extractPostParagraphs(parsed, mentions, mentionOpts);
  }
  if (messageType === "interactive") {
    return extractInteractiveCardText(parsed);
  }
  return "";
}

/**
 * Extract readable text from a message item returned by `GET /open-apis/im/v1/messages/:message_id`.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/get
 */
export function extractTextFromFetchedMessage(item: FeishuFetchedMessageItem): string {
  const msgType = nonEmptyTrimmed(item.msg_type) ?? "";
  const mentions = normalizeMentions(item.mentions);
  return extractMessageTextByType(msgType, item.body?.content, mentions, {});
}

/**
 * Parse and filter a Feishu v2.0 `im.message.receive_v1` event envelope.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 */
export function parseFeishuMessageReceiveEvent(
  envelope: Record<string, unknown>,
  filterOptions: FeishuMessageFilterOptions = {},
): FeishuParsedEventOutcome {
  const header = isPlainRecord(envelope["header"]) ? envelope["header"] : undefined;
  const event = isPlainRecord(envelope["event"]) ? envelope["event"] : undefined;
  if (event === undefined) {
    return { accepted: false, reason: "invalid_event_payload" };
  }

  const sender = isPlainRecord(event["sender"]) ? event["sender"] : undefined;
  const message = isPlainRecord(event["message"]) ? event["message"] : undefined;
  if (sender === undefined || message === undefined) {
    return { accepted: false, reason: "invalid_event_payload" };
  }

  const senderType = nonEmptyTrimmed(sender["sender_type"])?.toLowerCase();
  const senderIdObj = isPlainRecord(sender["sender_id"]) ? sender["sender_id"] : undefined;
  const senderOpenId = nonEmptyTrimmed(senderIdObj?.["open_id"]);
  const senderUserId = nonEmptyTrimmed(senderIdObj?.["user_id"]);
  const senderUnionId = nonEmptyTrimmed(senderIdObj?.["union_id"]);
  const legacySenderId = nonEmptyTrimmed(sender["id"]);
  const legacySenderIdType = nonEmptyTrimmed(sender["id_type"]);

  // 1. Bot self-message / loop guard
  const botOpenId = nonEmptyTrimmed(filterOptions.botOpenId);
  const appId = nonEmptyTrimmed(filterOptions.appId);
  const botName = nonEmptyTrimmed(filterOptions.botName);

  if (
    senderType === "app" ||
    senderType === "bot" ||
    (botOpenId !== undefined && senderOpenId === botOpenId) ||
    (appId !== undefined && legacySenderIdType === "app_id" && legacySenderId === appId)
  ) {
    return { accepted: false, reason: "bot_self_message" };
  }

  // 2. Optional sender open_id allowlist
  const allowedList = filterOptions.allowedOpenIds;
  if (allowedList !== undefined && allowedList.length > 0 && !allowedList.includes("*")) {
    if (senderOpenId === undefined || !allowedList.includes(senderOpenId)) {
      return { accepted: false, reason: "sender_not_allowed" };
    }
  }

  // 3. Validate required message identifiers and chat_type ("p2p" | "group")
  const messageId = nonEmptyTrimmed(message["message_id"]);
  const chatId = nonEmptyTrimmed(message["chat_id"]);
  const rawChatType = nonEmptyTrimmed(message["chat_type"]);
  const messageType = nonEmptyTrimmed(message["message_type"]);

  if (
    messageId === undefined ||
    chatId === undefined ||
    (rawChatType !== "p2p" && rawChatType !== "group") ||
    messageType === undefined
  ) {
    return { accepted: false, reason: "invalid_event_payload" };
  }

  const mentions = normalizeMentions(message["mentions"]);
  const mentionMatchOptions = {
    ...(botOpenId !== undefined ? { botOpenId } : {}),
    ...(botName !== undefined ? { botName } : {}),
    ...(filterOptions.allowAtAllInGroup !== undefined
      ? { allowAtAll: filterOptions.allowAtAllInGroup }
      : {}),
  };

  const mentionedBot = mentions.some((m) => isBotMention(m, mentionMatchOptions));

  // 4. Group @bot mention gating
  const groupPolicy = filterOptions.groupMentionPolicy ?? "mention-required";
  if (rawChatType === "group" && groupPolicy === "mention-required" && !mentionedBot) {
    return { accepted: false, reason: "group_not_mentioned" };
  }

  // 5. Extract readable text and strip mention placeholders
  const text = extractMessageTextByType(
    messageType,
    message["content"],
    mentions,
    mentionMatchOptions,
  );
  if (text.length === 0) {
    return { accepted: false, reason: "empty_or_unsupported_message" };
  }

  const eventId = nonEmptyTrimmed(header?.["event_id"]);
  const tenantKey =
    nonEmptyTrimmed(sender["tenant_key"]) ?? nonEmptyTrimmed(header?.["tenant_key"]);
  const rootId = nonEmptyTrimmed(message["root_id"]);
  const parentId = nonEmptyTrimmed(message["parent_id"]);
  const threadId = nonEmptyTrimmed(message["thread_id"]);
  const rawCreateTime =
    nonEmptyTrimmed(message["create_time"]) ?? nonEmptyTrimmed(header?.["create_time"]);
  const parsedCreateTime = rawCreateTime !== undefined ? Number(rawCreateTime) : Number.NaN;
  const createTimeMs =
    Number.isSafeInteger(parsedCreateTime) && parsedCreateTime >= 0 ? parsedCreateTime : undefined;

  return {
    accepted: true,
    message: {
      ...(eventId !== undefined ? { eventId } : {}),
      messageId,
      chatId,
      chatType: rawChatType,
      messageType,
      text,
      ...(senderOpenId !== undefined ? { senderOpenId } : {}),
      ...(senderUserId !== undefined ? { senderUserId } : {}),
      ...(senderUnionId !== undefined ? { senderUnionId } : {}),
      ...(tenantKey !== undefined ? { tenantKey } : {}),
      ...(rootId !== undefined ? { rootId } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(createTimeMs !== undefined ? { createTimeMs } : {}),
      mentionedBot,
    },
  };
}
