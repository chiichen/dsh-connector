import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  assertNonEmptyContextId,
  type ConnectorContext,
  type ConnectorContextId,
} from "@dsh-connector/core";
import {
  TELEGRAM_CONTEXT_PREFIX_CHANNEL,
  TELEGRAM_CONTEXT_PREFIX_DIRECT,
  TELEGRAM_CONTEXT_PREFIX_GROUP,
  TELEGRAM_CONTEXT_PREFIX_P2P,
  TELEGRAM_CONTEXT_PREFIX_SUPERGROUP,
  TELEGRAM_CONTEXT_SEGMENT_DELIMITER,
  TELEGRAM_NUMERIC_ID_PATTERN,
  TELEGRAM_USERNAME_HANDLE_PATTERN,
} from "./constants";
import type { TelegramChatType } from "./types";

export type TelegramTargetScope = "p2p" | "group" | "channel";

/**
 * Normalized Telegram outbound destination (`chat_id` + optional Forum Topic `message_thread_id`).
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 */
export interface TelegramResolvedTarget {
  readonly chatId: number | string;
  readonly messageThreadId?: number;
  readonly scope?: TelegramTargetScope;
}

export interface FormatTelegramContextIdInput {
  readonly chatType: TelegramChatType;
  readonly chatId: number | string;
  readonly messageThreadId?: number;
}

export interface ExplicitTelegramTargetParams {
  readonly chatId?: number | string;
  readonly messageThreadId?: number;
}

const TARGET_FIELD_CHAT_ID = "chatId" as const;
const MIN_CONTEXT_SEGMENTS = 2 as const;
const MAX_CONTEXT_SEGMENTS = 3 as const;

function parseChatIdentifier(raw: string): number | string | undefined {
  if (TELEGRAM_NUMERIC_ID_PATTERN.test(raw)) {
    const numeric = Number(raw);
    if (Number.isSafeInteger(numeric) && numeric !== 0) {
      return numeric;
    }
    return undefined;
  }
  if (TELEGRAM_USERNAME_HANDLE_PATTERN.test(raw)) {
    return raw;
  }
  return undefined;
}

function parsePositiveSafeInt(raw: string): number | undefined {
  if (!/^\d{1,16}$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeScopePrefix(prefix: string): TelegramTargetScope | undefined {
  switch (prefix) {
    case TELEGRAM_CONTEXT_PREFIX_P2P:
    case TELEGRAM_CONTEXT_PREFIX_DIRECT:
      return "p2p";
    case TELEGRAM_CONTEXT_PREFIX_GROUP:
    case TELEGRAM_CONTEXT_PREFIX_SUPERGROUP:
      return "group";
    case TELEGRAM_CONTEXT_PREFIX_CHANNEL:
      return "channel";
    default:
      return undefined;
  }
}

/**
 * Encodes a Telegram chat + optional Forum Topic `message_thread_id` into a deterministic
 * `ConnectorContextId` (`p2p:<chatId>[:<threadId>]`, `group:<chatId>[:<threadId>]`, or `channel:<chatId>`).
 *
 * @see https://core.telegram.org/bots/api#message
 */
export function formatTelegramContextId(input: FormatTelegramContextIdInput): ConnectorContextId {
  const prefix =
    input.chatType === "private"
      ? TELEGRAM_CONTEXT_PREFIX_P2P
      : input.chatType === "channel"
        ? TELEGRAM_CONTEXT_PREFIX_CHANNEL
        : TELEGRAM_CONTEXT_PREFIX_GROUP;

  const base = `${prefix}${TELEGRAM_CONTEXT_SEGMENT_DELIMITER}${String(input.chatId)}`;
  const rawId =
    input.chatType !== "channel" &&
    input.messageThreadId !== undefined &&
    Number.isSafeInteger(input.messageThreadId) &&
    input.messageThreadId > 0
      ? `${base}${TELEGRAM_CONTEXT_SEGMENT_DELIMITER}${input.messageThreadId}`
      : base;

  assertNonEmptyContextId(rawId);
  return rawId;
}

/**
 * Parses a structured Telegram `ConnectorContextId` into a `TelegramResolvedTarget`.
 * Returns `undefined` for pre-allocated host UUIDs or unrecognized identifiers so a pure UUID
 * is never mistakenly transmitted as a Telegram `chat_id`.
 */
export function parseTelegramContextTarget(contextId: string): TelegramResolvedTarget | undefined {
  const segments = contextId.split(TELEGRAM_CONTEXT_SEGMENT_DELIMITER);
  if (segments.length < MIN_CONTEXT_SEGMENTS || segments.length > MAX_CONTEXT_SEGMENTS) {
    return undefined;
  }

  const scope = normalizeScopePrefix(segments[0] ?? "");
  if (scope === undefined) {
    return undefined;
  }

  const chatId = parseChatIdentifier(segments[1] ?? "");
  if (chatId === undefined) {
    return undefined;
  }

  if (segments.length === MAX_CONTEXT_SEGMENTS) {
    if (scope === "channel") {
      return undefined;
    }
    const threadId = parsePositiveSafeInt(segments[2] ?? "");
    if (threadId === undefined) {
      return undefined;
    }
    return {
      scope,
      chatId,
      messageThreadId: threadId,
    };
  }

  return {
    scope,
    chatId,
  };
}

/**
 * Resolves the outbound Telegram target following strict 3-tier priority:
 * 1. Explicit `params.chatId` (and optional `params.messageThreadId`)
 * 2. Structured business target parsed from `context.contextId`
 * 3. Throws `ConnectorTargetRequiredError(context.connectorName, "chatId")`
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 */
export function resolveTelegramSendTarget(
  context: ConnectorContext,
  params: ExplicitTelegramTargetParams,
): Omit<TelegramResolvedTarget, "scope"> {
  if (params.chatId !== undefined) {
    if (typeof params.chatId === "string") {
      const trimmed = params.chatId.trim();
      if (trimmed.length === 0) {
        throw new ConnectorValidationError("Telegram chatId must not be an empty string.", {
          connectorName: context.connectorName,
        });
      }
      return {
        chatId: trimmed,
        ...(params.messageThreadId !== undefined
          ? { messageThreadId: params.messageThreadId }
          : {}),
      };
    }

    if (!Number.isSafeInteger(params.chatId) || params.chatId === 0) {
      throw new ConnectorValidationError(
        "Telegram numeric chatId must be a non-zero safe integer.",
        {
          connectorName: context.connectorName,
        },
      );
    }

    return {
      chatId: params.chatId,
      ...(params.messageThreadId !== undefined ? { messageThreadId: params.messageThreadId } : {}),
    };
  }

  const fromContext = parseTelegramContextTarget(context.contextId);
  if (fromContext !== undefined) {
    const resolvedThreadId = params.messageThreadId ?? fromContext.messageThreadId;
    return {
      chatId: fromContext.chatId,
      ...(resolvedThreadId !== undefined ? { messageThreadId: resolvedThreadId } : {}),
    };
  }

  throw new ConnectorTargetRequiredError(context.connectorName, TARGET_FIELD_CHAT_ID);
}
