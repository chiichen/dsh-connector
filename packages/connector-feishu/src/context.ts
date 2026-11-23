/**
 * Feishu (Lark) Zod schemas, structured conversation context IDs, and 3-tier
 * outbound target resolution.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/reply
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 */

import { z } from "zod";
import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorContextId,
} from "@dsh-connector/core";
import {
  FEISHU_CHAT_ID_PREFIX,
  FEISHU_GROUP_CONTEXT_PREFIX,
  FEISHU_MAX_DEDUP_UUID_LEN,
  FEISHU_OPEN_API_BASE_URL,
  FEISHU_OPEN_ID_PREFIX,
  FEISHU_P2P_CONTEXT_PREFIX,
  FEISHU_P2P_USER_CONTEXT_PREFIX,
  FEISHU_TARGET_REQUIRED_FIELD_HINT,
  FEISHU_THREAD_CONTEXT_INFIX,
  FEISHU_TOPIC_CONTEXT_INFIX,
  FEISHU_UNION_ID_PREFIX,
  LARK_OPEN_API_BASE_URL,
} from "./constants";

/**
 * Supported `receive_id_type` query parameter values for `POST /open-apis/im/v1/messages`.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 */
export const feishuReceiveIdTypeSchema = z.enum([
  "open_id",
  "chat_id",
  "user_id",
  "union_id",
  "email",
]);

export type FeishuReceiveIdType = z.infer<typeof feishuReceiveIdTypeSchema>;

export const feishuOutboundFormatSchema = z.enum(["text", "markdown"]);

export type FeishuOutboundFormat = z.infer<typeof feishuOutboundFormatSchema>;

export type FeishuContextMarkerPolicy = "auto" | "always" | "never";

/**
 * Outbound tool/sender schema for `@dsh-connector/connector-feishu`.
 * Uses `text` as the primary required content field while keeping all target
 * addressing fields optional for seamless host/LLM invocation.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/reply
 */
export const feishuSendSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe("Message content to send (plain text or Feishu Card JSON 2.0 Markdown)"),
  format: feishuOutboundFormatSchema
    .optional()
    .describe("Outbound message format: 'text' (default) or 'markdown' (interactive Card 2.0)"),
  receiveId: z
    .string()
    .min(1)
    .optional()
    .describe("Explicit Feishu recipient ID matching receiveIdType"),
  receiveIdType: feishuReceiveIdTypeSchema
    .optional()
    .describe("Recipient ID category when using receiveId"),
  chatId: z
    .string()
    .min(1)
    .optional()
    .describe("Explicit Feishu chat_id (e.g. oc_xxx) for group or direct chat"),
  openId: z.string().min(1).optional().describe("Explicit Feishu user open_id (e.g. ou_xxx)"),
  userId: z.string().min(1).optional().describe("Explicit Feishu tenant user_id"),
  unionId: z.string().min(1).optional().describe("Explicit Feishu union_id (e.g. on_xxx)"),
  email: z.string().min(1).optional().describe("Explicit recipient email address"),
  replyToMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("Feishu message_id (e.g. om_xxx) to reply to via im/v1/messages/:message_id/reply"),
  replyInThread: z
    .boolean()
    .optional()
    .describe("Whether to reply inside a topic thread when replyToMessageId is set"),
  uuid: z
    .string()
    .min(1)
    .max(FEISHU_MAX_DEDUP_UUID_LEN)
    .optional()
    .describe("Optional idempotent deduplication UUID (1..50 chars, valid for 1 hour)"),
});

export type FeishuSendParams = z.output<typeof feishuSendSchema>;
export type FeishuSendInput = z.input<typeof feishuSendSchema>;

/**
 * Normalized inbound message payload validated by `ConnectorReceiver.schema`.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 */
export const feishuReceiveSchema = z.object({
  eventId: z.string().min(1).optional(),
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.enum(["p2p", "group"]),
  messageType: z.string().min(1),
  text: z.string().min(1),
  senderOpenId: z.string().min(1).optional(),
  senderUserId: z.string().min(1).optional(),
  senderUnionId: z.string().min(1).optional(),
  tenantKey: z.string().min(1).optional(),
  rootId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  createTimeMs: z.number().int().nonnegative().optional(),
  mentionedBot: z.boolean(),
});

export type FeishuInboundMessage = z.output<typeof feishuReceiveSchema>;

export type FeishuResolvedSendTarget =
  | {
      readonly mode: "send";
      readonly receiveIdType: FeishuReceiveIdType;
      readonly receiveId: string;
    }
  | {
      readonly mode: "reply";
      readonly replyToMessageId: string;
      readonly replyInThread: boolean;
      readonly chatId?: string;
    };

export interface FeishuConversationDescriptor {
  readonly chatType: "p2p" | "group";
  readonly chatId?: string;
  readonly senderOpenId?: string;
  readonly senderUserId?: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
}

/**
 * Resolve `"feishu"`, `"lark"`, or a custom `https://` / `http://` OpenAPI base URL.
 *
 * @see https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-
 */
export function resolveFeishuApiBaseUrl(domain?: string): string {
  if (domain === undefined || domain === "feishu") {
    return FEISHU_OPEN_API_BASE_URL;
  }
  if (domain === "lark") {
    return LARK_OPEN_API_BASE_URL;
  }
  const trimmed = domain.trim();
  if (trimmed.length === 0) {
    throw new ConnectorValidationError("Feishu domain must not be an empty string.");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch (cause) {
    throw new ConnectorValidationError(
      `Invalid Feishu domain "${domain}": expected "feishu", "lark", or a valid HTTP(S) base URL.`,
      { cause },
    );
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new ConnectorValidationError(
      `Unsupported Feishu base URL protocol "${parsedUrl.protocol}": expected https: or http:.`,
    );
  }
  return trimmed.replace(/\/+$/, "");
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Construct a deterministic unprefixed `ConnectorContextId` encoding Feishu conversation topology:
 * - Direct chat (`p2p`): `p2p:<open_id>` (or `p2p:user:<user_id>` / `p2p:<chat_id>`)
 * - Regular group chat: `group:<chat_id>`
 * - Topic group thread: `group:<chat_id>:topic:<root_message_id>` (or `group:<chat_id>:thread:<thread_id>`)
 */
export function buildFeishuConversationContextId(
  descriptor: FeishuConversationDescriptor,
): ConnectorContextId {
  if (descriptor.chatType === "p2p") {
    const openId = nonEmptyTrimmed(descriptor.senderOpenId);
    if (openId !== undefined) {
      return `${FEISHU_P2P_CONTEXT_PREFIX}${openId}` as ConnectorContextId;
    }
    const userId = nonEmptyTrimmed(descriptor.senderUserId);
    if (userId !== undefined) {
      return `${FEISHU_P2P_USER_CONTEXT_PREFIX}${userId}` as ConnectorContextId;
    }
    const chatId = nonEmptyTrimmed(descriptor.chatId);
    if (chatId !== undefined) {
      return `${FEISHU_P2P_CONTEXT_PREFIX}${chatId}` as ConnectorContextId;
    }
    throw new ConnectorValidationError(
      "Feishu p2p message event requires sender open_id, user_id, or chat_id.",
    );
  }

  const chatId = nonEmptyTrimmed(descriptor.chatId);
  if (chatId === undefined) {
    throw new ConnectorValidationError("Feishu group message event requires chat_id.");
  }

  const threadId = nonEmptyTrimmed(descriptor.threadId);
  if (threadId !== undefined) {
    const rootMsgId = nonEmptyTrimmed(descriptor.rootMessageId);
    if (rootMsgId !== undefined) {
      return `${FEISHU_GROUP_CONTEXT_PREFIX}${chatId}${FEISHU_TOPIC_CONTEXT_INFIX}${rootMsgId}` as ConnectorContextId;
    }
    return `${FEISHU_GROUP_CONTEXT_PREFIX}${chatId}${FEISHU_THREAD_CONTEXT_INFIX}${threadId}` as ConnectorContextId;
  }

  return `${FEISHU_GROUP_CONTEXT_PREFIX}${chatId}` as ConnectorContextId;
}

/**
 * Infer Feishu `receive_id_type` from well-known Feishu ID prefixes (`oc_`, `ou_`, `on_`, email `@`).
 */
export function inferFeishuReceiveIdType(receiveId: string): FeishuReceiveIdType | undefined {
  const trimmed = receiveId.trim();
  if (trimmed.startsWith(FEISHU_CHAT_ID_PREFIX)) return "chat_id";
  if (trimmed.startsWith(FEISHU_OPEN_ID_PREFIX)) return "open_id";
  if (trimmed.startsWith(FEISHU_UNION_ID_PREFIX)) return "union_id";
  if (trimmed.includes("@")) return "email";
  return undefined;
}

/**
 * Parse a structured Feishu business target from `context.contextId`.
 * Returns `undefined` when `contextId` is a pre-allocated outbound UUID or unrecognized format.
 */
export function parseFeishuContextTarget(
  contextId: ConnectorContextId | string,
): FeishuResolvedSendTarget | undefined {
  const trimmed = contextId.trim();

  if (trimmed.startsWith(FEISHU_P2P_USER_CONTEXT_PREFIX)) {
    const userId = nonEmptyTrimmed(trimmed.slice(FEISHU_P2P_USER_CONTEXT_PREFIX.length));
    if (userId === undefined) return undefined;
    return { mode: "send", receiveIdType: "user_id", receiveId: userId };
  }

  if (trimmed.startsWith(FEISHU_P2P_CONTEXT_PREFIX)) {
    const peerId = nonEmptyTrimmed(trimmed.slice(FEISHU_P2P_CONTEXT_PREFIX.length));
    if (peerId === undefined) return undefined;
    const receiveIdType: FeishuReceiveIdType = peerId.startsWith(FEISHU_CHAT_ID_PREFIX)
      ? "chat_id"
      : "open_id";
    return { mode: "send", receiveIdType, receiveId: peerId };
  }

  if (trimmed.startsWith(FEISHU_GROUP_CONTEXT_PREFIX)) {
    const rest = trimmed.slice(FEISHU_GROUP_CONTEXT_PREFIX.length);
    const topicIdx = rest.indexOf(FEISHU_TOPIC_CONTEXT_INFIX);
    if (topicIdx > 0) {
      const chatId = nonEmptyTrimmed(rest.slice(0, topicIdx));
      const rootMessageId = nonEmptyTrimmed(
        rest.slice(topicIdx + FEISHU_TOPIC_CONTEXT_INFIX.length),
      );
      if (chatId === undefined || rootMessageId === undefined) return undefined;
      return {
        mode: "reply",
        replyToMessageId: rootMessageId,
        replyInThread: true,
        chatId,
      };
    }

    const threadIdx = rest.indexOf(FEISHU_THREAD_CONTEXT_INFIX);
    if (threadIdx > 0) {
      const chatId = nonEmptyTrimmed(rest.slice(0, threadIdx));
      const threadId = nonEmptyTrimmed(rest.slice(threadIdx + FEISHU_THREAD_CONTEXT_INFIX.length));
      if (chatId === undefined || threadId === undefined) return undefined;
      return { mode: "send", receiveIdType: "chat_id", receiveId: chatId };
    }

    const chatId = nonEmptyTrimmed(rest);
    if (chatId === undefined || chatId.includes(":")) return undefined;
    return { mode: "send", receiveIdType: "chat_id", receiveId: chatId };
  }

  return undefined;
}

/**
 * Resolve outbound target strictly following 3-tier priority:
 * 1. Explicit target fields in `params` (`replyToMessageId`, `receiveId`, `chatId`, `openId`, `userId`, `unionId`, `email`)
 * 2. Structured conversation target parsed from `context.contextId` (`p2p:...` / `group:...`)
 * 3. Throw `ConnectorTargetRequiredError` (never treat a pre-allocated UUID `contextId` as a Feishu ID)
 */
export function resolveFeishuSendTarget(
  context: ConnectorContext,
  params: FeishuSendParams,
): FeishuResolvedSendTarget {
  const replyToMessageId = nonEmptyTrimmed(params.replyToMessageId);
  if (replyToMessageId !== undefined) {
    return {
      mode: "reply",
      replyToMessageId,
      replyInThread: params.replyInThread ?? false,
    };
  }

  const explicitReceiveId = nonEmptyTrimmed(params.receiveId);
  if (explicitReceiveId !== undefined) {
    const inferredType = params.receiveIdType ?? inferFeishuReceiveIdType(explicitReceiveId);
    if (inferredType === undefined) {
      throw new ConnectorValidationError(
        `Unable to infer Feishu receiveIdType for receiveId "${explicitReceiveId}". Specify receiveIdType explicitly ("open_id" | "chat_id" | "user_id" | "union_id" | "email").`,
        { connectorName: context.connectorName },
      );
    }
    return {
      mode: "send",
      receiveIdType: inferredType,
      receiveId: explicitReceiveId,
    };
  }

  const chatId = nonEmptyTrimmed(params.chatId);
  if (chatId !== undefined) {
    return { mode: "send", receiveIdType: "chat_id", receiveId: chatId };
  }

  const openId = nonEmptyTrimmed(params.openId);
  if (openId !== undefined) {
    return { mode: "send", receiveIdType: "open_id", receiveId: openId };
  }

  const userId = nonEmptyTrimmed(params.userId);
  if (userId !== undefined) {
    return { mode: "send", receiveIdType: "user_id", receiveId: userId };
  }

  const unionId = nonEmptyTrimmed(params.unionId);
  if (unionId !== undefined) {
    return { mode: "send", receiveIdType: "union_id", receiveId: unionId };
  }

  const email = nonEmptyTrimmed(params.email);
  if (email !== undefined) {
    return { mode: "send", receiveIdType: "email", receiveId: email };
  }

  const fallbackContextTarget = parseFeishuContextTarget(context.contextId);
  if (fallbackContextTarget !== undefined) {
    return fallbackContextTarget;
  }

  throw new ConnectorTargetRequiredError(context.connectorName, FEISHU_TARGET_REQUIRED_FIELD_HINT);
}

/**
 * Conditionally prepend `[#ctx:<contextId>]` marker to outbound text:
 * - `"never"`: never prepend
 * - `"always"`: always prepend `[#ctx:<contextId>]`
 * - `"auto"` (default): prepend only when `context.contextId` is NOT an already-structured
 *   `p2p:` / `group:` chat target (e.g. outbound-first local session UUIDs), so user replies
 *   to proactive messages correlate back to the originating session while chat-started turns stay clean.
 */
export function applyOutboundContextMarker(
  text: string,
  context: ConnectorContext,
  policy: FeishuContextMarkerPolicy = "auto",
): string {
  if (policy === "never") {
    return text;
  }
  if (policy === "auto" && parseFeishuContextTarget(context.contextId) !== undefined) {
    return text;
  }
  return prependContextMarker(text, context.contextId, "bracket");
}
