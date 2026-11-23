/**
 * Discord Snowflake validation, structured `ConnectorContextId` encoding/decoding,
 * three-level target resolution, and mention stripping helpers.
 *
 * @see https://discord.com/developers/docs/reference#snowflakes
 * @see https://discord.com/developers/docs/reference#message-formatting
 * @see https://discord.com/developers/docs/resources/channel
 */

import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  type ConnectorContext,
  type ConnectorContextId,
} from "@dsh-connector/core";
import {
  DISCORD_CONTEXT_PREFIX_CHANNEL,
  DISCORD_CONTEXT_PREFIX_DM,
  DISCORD_CONTEXT_PREFIX_THREAD,
  DISCORD_CONTEXT_PREFIX_USER,
  DISCORD_MAX_SNOWFLAKE_LENGTH,
  DISCORD_MIN_SNOWFLAKE_LENGTH,
} from "./constants";
import type { DiscordResolvedTarget, DiscordSendParams } from "./types";

const DISCORD_SNOWFLAKE_RE = new RegExp(
  `^\\d{${DISCORD_MIN_SNOWFLAKE_LENGTH},${DISCORD_MAX_SNOWFLAKE_LENGTH}}$`,
);

/**
 * Checks whether `value` is a valid numeric Discord Snowflake ID string.
 * @see https://discord.com/developers/docs/reference#snowflakes
 */
export function isDiscordSnowflake(value: string): boolean {
  return typeof value === "string" && DISCORD_SNOWFLAKE_RE.test(value.trim());
}

/**
 * Validates and trims a Discord Snowflake ID, throwing `ConnectorValidationError` when invalid.
 * @see https://discord.com/developers/docs/reference#snowflakes
 */
export function assertDiscordSnowflake(
  value: string,
  fieldName: string,
  connectorName?: string,
): string {
  const trimmed = value.trim();
  if (!isDiscordSnowflake(trimmed)) {
    throw new ConnectorValidationError(
      `Invalid Discord snowflake for "${fieldName}": expected 1..${DISCORD_MAX_SNOWFLAKE_LENGTH} ASCII digits, got "${value}".`,
      { connectorName },
    );
  }
  return trimmed;
}

export function formatDiscordDmContextId(
  dmChannelId: string,
  connectorName?: string,
): ConnectorContextId {
  const id = assertDiscordSnowflake(dmChannelId, "dmChannelId", connectorName);
  return `${DISCORD_CONTEXT_PREFIX_DM}:${id}` as ConnectorContextId;
}

export function formatDiscordUserContextId(
  userId: string,
  connectorName?: string,
): ConnectorContextId {
  const id = assertDiscordSnowflake(userId, "userId", connectorName);
  return `${DISCORD_CONTEXT_PREFIX_USER}:${id}` as ConnectorContextId;
}

export function formatDiscordChannelContextId(
  channelId: string,
  connectorName?: string,
): ConnectorContextId {
  const id = assertDiscordSnowflake(channelId, "channelId", connectorName);
  return `${DISCORD_CONTEXT_PREFIX_CHANNEL}:${id}` as ConnectorContextId;
}

export function formatDiscordThreadContextId(
  threadId: string,
  parentChannelId?: string,
  connectorName?: string,
): ConnectorContextId {
  const normalizedThreadId = assertDiscordSnowflake(threadId, "threadId", connectorName);
  if (parentChannelId !== undefined && parentChannelId.trim().length > 0) {
    const normalizedParentId = assertDiscordSnowflake(
      parentChannelId,
      "parentChannelId",
      connectorName,
    );
    return `${DISCORD_CONTEXT_PREFIX_THREAD}:${normalizedParentId}:${normalizedThreadId}` as ConnectorContextId;
  }
  return `${DISCORD_CONTEXT_PREFIX_THREAD}:${normalizedThreadId}` as ConnectorContextId;
}

/**
 * Parses a structured Discord `ConnectorContextId` into a `DiscordResolvedTarget`.
 * Returns `undefined` when `contextId` is a pre-allocated outbound UUID or unrecognized format,
 * preventing accidental transmission of host UUIDs as Discord channel IDs.
 */
export function parseDiscordContextTarget(contextId: string): DiscordResolvedTarget | undefined {
  const parts = contextId.trim().split(":");
  if (parts.length === 2) {
    const [prefix, id] = parts;
    if (id === undefined || !isDiscordSnowflake(id)) {
      return undefined;
    }
    if (prefix === DISCORD_CONTEXT_PREFIX_DM) {
      return { kind: "dm", channelId: id };
    }
    if (prefix === DISCORD_CONTEXT_PREFIX_USER) {
      return { kind: "user", userId: id };
    }
    if (prefix === DISCORD_CONTEXT_PREFIX_CHANNEL) {
      return { kind: "channel", channelId: id };
    }
    if (prefix === DISCORD_CONTEXT_PREFIX_THREAD) {
      return { kind: "thread", channelId: id, threadId: id };
    }
    return undefined;
  }

  if (parts.length === 3) {
    const [prefix, parentId, threadId] = parts;
    if (
      (prefix === DISCORD_CONTEXT_PREFIX_THREAD || prefix === DISCORD_CONTEXT_PREFIX_CHANNEL) &&
      parentId !== undefined &&
      threadId !== undefined &&
      isDiscordSnowflake(parentId) &&
      isDiscordSnowflake(threadId)
    ) {
      return {
        kind: "thread",
        channelId: threadId,
        threadId,
        parentChannelId: parentId,
      };
    }
  }

  return undefined;
}

/**
 * Resolves the outbound target using the strict three-level priority:
 * 1. Explicit target fields in `params` (`threadId` > `channelId` > `userId`)
 * 2. Structured business target in `context.contextId`
 * 3. Throws `ConnectorTargetRequiredError`
 */
export function resolveDiscordSendTarget<TName extends string>(
  context: ConnectorContext<TName>,
  params: Partial<Pick<DiscordSendParams, "text" | "channelId" | "threadId" | "userId">>,
): DiscordResolvedTarget {
  if (params.threadId !== undefined) {
    const threadId = assertDiscordSnowflake(params.threadId, "threadId", context.connectorName);
    const parentChannelId =
      params.channelId !== undefined
        ? assertDiscordSnowflake(params.channelId, "channelId", context.connectorName)
        : undefined;
    return {
      kind: "thread",
      channelId: threadId,
      threadId,
      parentChannelId,
    };
  }

  if (params.channelId !== undefined) {
    const channelId = assertDiscordSnowflake(params.channelId, "channelId", context.connectorName);
    return {
      kind: "channel",
      channelId,
    };
  }

  if (params.userId !== undefined) {
    const userId = assertDiscordSnowflake(params.userId, "userId", context.connectorName);
    return {
      kind: "user",
      userId,
    };
  }

  const fromContext = parseDiscordContextTarget(context.contextId);
  if (fromContext !== undefined) {
    return fromContext;
  }

  throw new ConnectorTargetRequiredError(context.connectorName, "channelId");
}

/**
 * Strips `<@botId>` and deprecated `<@!botId>` mention tokens from inbound Discord message text.
 * @see https://discord.com/developers/docs/reference#message-formatting-formats
 */
export function stripDiscordBotMentions(content: string, botUserId: string): string {
  const trimmedBotId = botUserId.trim();
  if (trimmedBotId.length === 0) {
    return content.trim();
  }
  const escapedId = trimmedBotId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`\\s*<@!?${escapedId}>\\s*`, "g");
  return content
    .replace(mentionPattern, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
