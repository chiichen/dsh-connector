/**
 * Reserved streaming extension seam for `@dsh-connector/connector-discord`.
 *
 * NOTE: Per current phase specification, `@dsh-connector/connector-discord` only
 * implements the non-streaming send/receive loop. This module defines the
 * strongly-typed contracts, endpoint path builders, and optional adapter hooks for:
 *
 * 1. In-place message editing via `PATCH /channels/{channel.id}/messages/{message.id}`
 * 2. Original interaction response editing via `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original`
 * 3. Typing indicator triggers via `POST /channels/{channel.id}/typing`
 *
 * @see https://discord.com/developers/docs/resources/message#edit-message
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response
 * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
 */

import { ConnectorValidationError } from "@dsh-connector/core";
import { DISCORD_CONNECTOR_DEFAULT_NAME } from "./constants";
import { assertDiscordSnowflake } from "./context-target";
import type { DiscordAllowedMentions, DiscordEmbed, DiscordSendResult } from "./types";

/**
 * Payload contract for Discord REST v10 `PATCH /channels/{channel.id}/messages/{message.id}`.
 *
 * @see https://discord.com/developers/docs/resources/message#edit-message
 */
export interface DiscordChannelEditMessageRequest {
  readonly channelId: string;
  readonly messageId: string;
  readonly content?: string | null;
  readonly embeds?: readonly DiscordEmbed[] | null;
  readonly allowed_mentions?: DiscordAllowedMentions | null;
  readonly flags?: number | null;
}

/**
 * Payload contract for Discord REST v10
 * `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original`.
 *
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response
 * @see https://discord.com/developers/docs/resources/webhook#edit-webhook-message
 */
export interface DiscordInteractionEditOriginalRequest {
  readonly applicationId: string;
  readonly interactionToken: string;
  readonly threadId?: string;
  readonly withComponents?: boolean;
  readonly content?: string | null;
  readonly embeds?: readonly DiscordEmbed[] | null;
  readonly allowed_mentions?: DiscordAllowedMentions | null;
}

/**
 * Target descriptor for Discord REST v10 `POST /channels/{channel.id}/typing`.
 *
 * Discord typing indicators remain active for up to 10 seconds or until the bot
 * posts a message in the channel.
 *
 * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
 */
export interface DiscordTypingIndicatorTarget {
  readonly channelId: string;
}

/**
 * Discriminated target union for initiating a Discord streaming output session.
 *
 * - `"channel-message"`: Creates/edits a message in a channel or thread via
 *   `POST /channels/{channel.id}/messages` + `PATCH /channels/{channel.id}/messages/{message.id}`.
 * - `"interaction-response"`: Updates a deferred interaction response (`type: 5`) via
 *   `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original`.
 *
 * @see https://discord.com/developers/docs/resources/message#edit-message
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response
 */
export type DiscordStreamTarget =
  | {
      readonly mode: "channel-message";
      readonly channelId: string;
      readonly threadId?: string;
      readonly replyToMessageId?: string;
      readonly placeholderText?: string;
    }
  | {
      readonly mode: "interaction-response";
      readonly applicationId: string;
      readonly interactionToken: string;
      readonly channelId?: string;
      readonly threadId?: string;
    };

/**
 * Immutable/serializable handle representing an in-flight Discord stream session.
 */
export interface DiscordStreamHandle {
  readonly streamId: string;
  readonly target: DiscordStreamTarget;
  readonly messageId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly startedAt: number;
}

/**
 * Incremental update patch pushed to an active `DiscordStreamHandle`.
 */
export interface DiscordStreamUpdatePatch {
  readonly text: string;
  readonly embeds?: readonly DiscordEmbed[];
  readonly cursorSuffix?: string;
}

/**
 * Finalization payload for completing an active `DiscordStreamHandle`.
 */
export interface DiscordStreamCompleteInput {
  readonly finalText: string;
  readonly embeds?: readonly DiscordEmbed[];
}

/**
 * Structured abort reason when an in-flight Discord stream is cancelled or fails.
 */
export interface DiscordStreamAbortReason {
  readonly code: "cancelled" | "timeout" | "upstream_error" | "rate_limited";
  readonly message?: string;
  readonly fallbackText?: string;
}

/**
 * Reserved configuration options for future Discord streaming output orchestration.
 *
 * @see https://discord.com/developers/docs/topics/rate-limits
 * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
 */
export interface DiscordStreamingOptions {
  /** Whether streaming output is enabled (reserved; defaults to `false`). */
  readonly enabled?: boolean;
  /** Minimum interval in milliseconds between `PATCH` message edits to respect per-channel rate limits. */
  readonly editThrottleMs?: number;
  /** Interval in milliseconds for refreshing `POST /channels/{channel.id}/typing` (Discord expires typing after ~10s). */
  readonly typingRefreshIntervalMs?: number;
  /** Optional initial placeholder content when creating a channel stream message. */
  readonly placeholderText?: string;
}

/**
 * Pluggable adapter interface for Discord streaming output.
 *
 * Host plugins or future milestones can supply an implementation without changing
 * `DiscordConnectorOptions` or `DiscordSendResult` wire contracts.
 *
 * @see https://discord.com/developers/docs/resources/message#edit-message
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response
 * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
 */
export interface DiscordStreamingAdapter {
  startStream(target: DiscordStreamTarget, signal?: AbortSignal): Promise<DiscordStreamHandle>;
  updateStream(
    handle: DiscordStreamHandle,
    patch: DiscordStreamUpdatePatch,
    signal?: AbortSignal,
  ): Promise<DiscordStreamHandle>;
  completeStream(
    handle: DiscordStreamHandle,
    input: DiscordStreamCompleteInput,
    signal?: AbortSignal,
  ): Promise<DiscordSendResult>;
  abortStream?(
    handle: DiscordStreamHandle,
    reason: DiscordStreamAbortReason,
    signal?: AbortSignal,
  ): Promise<void>;
  sendTypingIndicator?(target: DiscordTypingIndicatorTarget, signal?: AbortSignal): Promise<void>;
}

/**
 * Builds the relative REST v10 endpoint path for editing a channel message:
 * `channels/{channel.id}/messages/{message.id}`.
 *
 * @see https://discord.com/developers/docs/resources/message#edit-message
 */
export function buildEditChannelMessagePath(
  channelId: string,
  messageId: string,
  connectorName: string = DISCORD_CONNECTOR_DEFAULT_NAME,
): string {
  const validChannelId = assertDiscordSnowflake(channelId, "channelId", connectorName);
  const validMessageId = assertDiscordSnowflake(messageId, "messageId", connectorName);
  return `channels/${validChannelId}/messages/${validMessageId}`;
}

/**
 * Builds the relative REST v10 endpoint path for editing the original interaction response:
 * `webhooks/{application.id}/{interaction.token}/messages/@original`.
 *
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response
 */
export function buildEditOriginalInteractionPath(
  applicationId: string,
  interactionToken: string,
  query?: {
    readonly threadId?: string;
    readonly withComponents?: boolean;
  },
  connectorName: string = DISCORD_CONNECTOR_DEFAULT_NAME,
): string {
  const validAppId = assertDiscordSnowflake(applicationId, "applicationId", connectorName);
  const token = interactionToken.trim();
  if (!token || token.includes("/")) {
    throw new ConnectorValidationError(
      "Invalid Discord interactionToken for @original webhook path",
      { connectorName },
    );
  }

  const params = new URLSearchParams();
  if (query?.threadId !== undefined) {
    params.set("thread_id", assertDiscordSnowflake(query.threadId, "threadId", connectorName));
  }
  if (query?.withComponents !== undefined) {
    params.set("with_components", String(query.withComponents));
  }
  const qs = params.toString();
  return `webhooks/${validAppId}/${encodeURIComponent(token)}/messages/@original${qs ? `?${qs}` : ""}`;
}

/**
 * Builds the relative REST v10 endpoint path for triggering a channel typing indicator:
 * `channels/{channel.id}/typing`.
 *
 * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
 */
export function buildTriggerTypingPath(
  channelId: string,
  connectorName: string = DISCORD_CONNECTOR_DEFAULT_NAME,
): string {
  const validChannelId = assertDiscordSnowflake(channelId, "channelId", connectorName);
  return `channels/${validChannelId}/typing`;
}
