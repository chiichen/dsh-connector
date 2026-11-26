import { z } from "zod";
import {
  extractContextMarker,
  resolveInboundContextId,
  type ConnectorContextId,
} from "@dsh-connector/core";
import {
  SLACK_ALLOWED_SUBTYPE_FILE_SHARE,
  SLACK_CHANNEL_TYPE_CHANNEL,
  SLACK_CHANNEL_TYPE_GROUP,
  SLACK_CHANNEL_TYPE_IM,
  SLACK_CHANNEL_TYPE_MPIM,
  SLACK_CONTEXT_CHANNEL_KIND,
  SLACK_CONTEXT_DM_KIND,
  SLACK_EVENT_APP_MENTION,
  SLACK_EVENT_MESSAGE,
  SLACK_WEBHOOK_TYPE_EVENT_CALLBACK,
} from "./constants";
import { isValidSlackChannelId, isValidSlackTimestamp } from "./context-target";

export type SlackChannelType =
  | typeof SLACK_CHANNEL_TYPE_IM
  | typeof SLACK_CHANNEL_TYPE_MPIM
  | typeof SLACK_CHANNEL_TYPE_CHANNEL
  | typeof SLACK_CHANNEL_TYPE_GROUP;

export type SlackInboundEventType = typeof SLACK_EVENT_MESSAGE | typeof SLACK_EVENT_APP_MENTION;

/**
 * Policy controlling how channel/group thread replies (`message` events with `thread_ts`)
 * are accepted when they do not explicitly `@mention` the bot:
 * - `"all"`: Accept all valid user thread replies in channels/groups (stateless-friendly default).
 * - `"participating"`: Accept thread replies only in threads where the bot was previously mentioned or sent a message (or when an explicit context marker is present).
 * - `"mention-only"`: Only accept `app_mention` events in channels/groups (unless an explicit context marker is present).
 */
export type SlackThreadReplyPolicy = "all" | "participating" | "mention-only";

/**
 * Normalized inbound Slack message schema delivered to `ConnectorReceiverContext.onReceive`.
 *
 * @see https://docs.slack.dev/reference/events/message.im
 * @see https://docs.slack.dev/reference/events/app_mention/
 */
export const slackReceiveSchema = z.object({
  text: z.string(),
  channelId: z.string().min(1),
  channelType: z.enum([
    SLACK_CHANNEL_TYPE_IM,
    SLACK_CHANNEL_TYPE_MPIM,
    SLACK_CHANNEL_TYPE_CHANNEL,
    SLACK_CHANNEL_TYPE_GROUP,
  ]),
  userId: z.string().min(1),
  messageTs: z.string().min(1),
  threadTs: z.string().optional(),
  eventType: z.enum([SLACK_EVENT_MESSAGE, SLACK_EVENT_APP_MENTION]),
  eventId: z.string().min(1),
  teamId: z.string().optional(),
});

export type SlackReceiveParams = z.output<typeof slackReceiveSchema>;

export type SlackIgnoreReason =
  | "invalid_envelope"
  | "app_mismatch"
  | "bot_message"
  | "unsupported_subtype"
  | "missing_fields"
  | "self_message"
  | "unaddressed_channel_message"
  | "thread_policy_filtered"
  | "unsupported_event"
  | "empty_text";

export type ParsedSlackEventResult =
  | {
      readonly kind: "message";
      readonly contextId: ConnectorContextId;
      readonly params: SlackReceiveParams;
      readonly idempotencyKey: string;
      readonly suggestedTitle: string;
      readonly receivedAtMs?: number;
      readonly participatingThread?: {
        readonly channelId: string;
        readonly threadTs: string;
      };
    }
  | {
      readonly kind: "ignored";
      readonly reason: SlackIgnoreReason;
    };

export interface SlackEventParseOptions {
  readonly connectorName?: string;
  readonly botUserId?: string;
  readonly expectedAppId?: string;
  readonly threadReplyPolicy?: SlackThreadReplyPolicy;
  readonly isParticipatingThread?: (channelId: string, threadTs: string) => boolean;
}

const LEADING_USER_MENTION_RE = /^(?:<@[A-Z0-9]+>\s*)+/i;
const MILLISECONDS_IN_SECOND = 1_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Decodes Slack HTML entity escapes (`&lt;`, `&gt;`, `&amp;`) in inbound `event.text`.
 * Decoding `&gt;` before `extractContextMarker` allows quoted context markers
 * (`&gt; [#ctx:...]`) in Slack blockquotes to be recognized seamlessly.
 *
 * @see https://docs.slack.dev/messaging/formatting-message-text/
 */
export function decodeSlackEntities(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/**
 * Strips `<@BOT_USER_ID>` mentions from Slack message text.
 */
export function stripSlackBotMention(
  text: string,
  botUserId: string | undefined,
  stripLeadingFallback = false,
): string {
  if (botUserId !== undefined && botUserId.length > 0) {
    const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const botMentionRe = new RegExp(`<@${escaped}(?:\\|[^>]+)?>`, "gi");
    return text.replace(botMentionRe, "").trim();
  }
  if (stripLeadingFallback) {
    return text.replace(LEADING_USER_MENTION_RE, "").trim();
  }
  return text.trim();
}

function resolveAuthorizedBotUserId(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const authorizations = payload["authorizations"];
  if (!Array.isArray(authorizations)) {
    return undefined;
  }
  for (const entry of authorizations) {
    if (isPlainRecord(entry) && entry["is_bot"] === true) {
      const userId = nonEmptyString(entry["user_id"]);
      if (userId !== undefined) {
        return userId;
      }
    }
  }
  return undefined;
}

function inferSlackChannelType(rawChannelType: unknown, channelId: string): SlackChannelType {
  if (
    rawChannelType === SLACK_CHANNEL_TYPE_IM ||
    rawChannelType === SLACK_CHANNEL_TYPE_MPIM ||
    rawChannelType === SLACK_CHANNEL_TYPE_CHANNEL ||
    rawChannelType === SLACK_CHANNEL_TYPE_GROUP
  ) {
    return rawChannelType;
  }
  const upperPrefix = channelId.slice(0, 1).toUpperCase();
  if (upperPrefix === "D") {
    return SLACK_CHANNEL_TYPE_IM;
  }
  if (upperPrefix === "G") {
    return SLACK_CHANNEL_TYPE_GROUP;
  }
  return SLACK_CHANNEL_TYPE_CHANNEL;
}

/**
 * Parses and filters a Slack Events API `event_callback` wrapper payload.
 *
 * Handles:
 * - Bot self-message filtering (`bot_id`, `bot_profile`, `subtype`, and `user === botUserId`)
 * - Direct messages (`message.im`)
 * - Channel/group `@bot` mentions (`app_mention`, anchoring `thread_ts` to `event.thread_ts ?? event.ts`)
 * - Channel/group threaded replies (`message` with `thread_ts !== ts`)
 * - Context marker extraction (`extractContextMarker`) over Slack-decoded text
 *
 * @see https://docs.slack.dev/reference/events/message.im
 * @see https://docs.slack.dev/reference/events/app_mention/
 * @see https://docs.slack.dev/reference/events/message
 */
export function parseSlackEventCallback(
  payload: unknown,
  options?: SlackEventParseOptions,
): ParsedSlackEventResult {
  if (!isPlainRecord(payload) || payload["type"] !== SLACK_WEBHOOK_TYPE_EVENT_CALLBACK) {
    return { kind: "ignored", reason: "invalid_envelope" };
  }

  const eventId = nonEmptyString(payload["event_id"]);
  const event = payload["event"];
  if (eventId === undefined || !isPlainRecord(event)) {
    return { kind: "ignored", reason: "invalid_envelope" };
  }

  const apiAppId = nonEmptyString(payload["api_app_id"]);
  if (
    options?.expectedAppId !== undefined &&
    apiAppId !== undefined &&
    apiAppId !== options.expectedAppId
  ) {
    return { kind: "ignored", reason: "app_mismatch" };
  }

  // Filter bot-originated messages first to prevent infinite reply loops.
  if (nonEmptyString(event["bot_id"]) !== undefined || isPlainRecord(event["bot_profile"])) {
    return { kind: "ignored", reason: "bot_message" };
  }

  const subtype = nonEmptyString(event["subtype"]);
  if (subtype !== undefined && subtype !== SLACK_ALLOWED_SUBTYPE_FILE_SHARE) {
    return { kind: "ignored", reason: "unsupported_subtype" };
  }

  const channelId = nonEmptyString(event["channel"]);
  const userId = nonEmptyString(event["user"]);
  const messageTs = nonEmptyString(event["ts"]);
  if (
    channelId === undefined ||
    userId === undefined ||
    messageTs === undefined ||
    !isValidSlackChannelId(channelId) ||
    !isValidSlackTimestamp(messageTs)
  ) {
    return { kind: "ignored", reason: "missing_fields" };
  }

  const effectiveBotUserId = options?.botUserId ?? resolveAuthorizedBotUserId(payload);
  if (effectiveBotUserId !== undefined && userId === effectiveBotUserId) {
    return { kind: "ignored", reason: "self_message" };
  }

  const rawEventType = nonEmptyString(event["type"]);
  const channelType = inferSlackChannelType(event["channel_type"], channelId);
  const rawThreadTs = nonEmptyString(event["thread_ts"]);
  const validThreadTs =
    rawThreadTs !== undefined && isValidSlackTimestamp(rawThreadTs) ? rawThreadTs : undefined;

  const rawText = typeof event["text"] === "string" ? event["text"] : "";
  const decodedText = decodeSlackEntities(rawText);
  const { contextId: extractedMarkerId, cleanedContent } = extractContextMarker(decodedText);

  let eventType: SlackInboundEventType;
  let effectiveThreadTs: string | undefined;
  let participatingThread: { readonly channelId: string; readonly threadTs: string } | undefined;

  if (rawEventType === SLACK_EVENT_MESSAGE && channelType === SLACK_CHANNEL_TYPE_IM) {
    eventType = SLACK_EVENT_MESSAGE;
    effectiveThreadTs = validThreadTs;
  } else if (rawEventType === SLACK_EVENT_APP_MENTION) {
    eventType = SLACK_EVENT_APP_MENTION;
    effectiveThreadTs = validThreadTs ?? messageTs;
    const kind =
      channelType === SLACK_CHANNEL_TYPE_IM ? SLACK_CONTEXT_DM_KIND : SLACK_CONTEXT_CHANNEL_KIND;
    if (kind === SLACK_CONTEXT_CHANNEL_KIND) {
      participatingThread = { channelId, threadTs: effectiveThreadTs };
    }
  } else if (
    rawEventType === SLACK_EVENT_MESSAGE &&
    (channelType === SLACK_CHANNEL_TYPE_CHANNEL ||
      channelType === SLACK_CHANNEL_TYPE_GROUP ||
      channelType === SLACK_CHANNEL_TYPE_MPIM)
  ) {
    // Only threaded replies (thread_ts !== ts) are considered in channels/groups without app_mention.
    if (validThreadTs === undefined || validThreadTs === messageTs) {
      return { kind: "ignored", reason: "unaddressed_channel_message" };
    }

    const policy: SlackThreadReplyPolicy = options?.threadReplyPolicy ?? "all";
    if (extractedMarkerId === undefined) {
      if (policy === "mention-only") {
        return { kind: "ignored", reason: "thread_policy_filtered" };
      }
      if (
        policy === "participating" &&
        options?.isParticipatingThread?.(channelId, validThreadTs) !== true
      ) {
        return { kind: "ignored", reason: "thread_policy_filtered" };
      }
    }

    eventType = SLACK_EVENT_MESSAGE;
    effectiveThreadTs = validThreadTs;
  } else {
    return { kind: "ignored", reason: "unsupported_event" };
  }

  const normalizedText = stripSlackBotMention(
    cleanedContent,
    effectiveBotUserId,
    eventType === SLACK_EVENT_APP_MENTION,
  );

  if (normalizedText.length === 0) {
    return { kind: "ignored", reason: "empty_text" };
  }

  const contextId = resolveInboundContextId({
    messageId: `${channelId}:${messageTs}`,
    body: decodedText,
  });
  const teamId = nonEmptyString(payload["team_id"]) ?? nonEmptyString(event["team"]);
  const eventTimeSec =
    typeof payload["event_time"] === "number" && Number.isFinite(payload["event_time"])
      ? payload["event_time"]
      : undefined;

  const suggestedTitle =
    channelType === SLACK_CHANNEL_TYPE_IM
      ? `Slack DM ${channelId}`
      : `Slack ${channelId}${effectiveThreadTs !== undefined ? ` (${effectiveThreadTs})` : ""}`;

  return {
    kind: "message",
    contextId,
    params: {
      text: normalizedText,
      channelId,
      channelType,
      userId,
      messageTs,
      ...(effectiveThreadTs !== undefined ? { threadTs: effectiveThreadTs } : {}),
      eventType,
      eventId,
      ...(teamId !== undefined ? { teamId } : {}),
    },
    idempotencyKey: `${channelId}:${messageTs}`,
    suggestedTitle,
    ...(eventTimeSec !== undefined ? { receivedAtMs: eventTimeSec * MILLISECONDS_IN_SECOND } : {}),
    ...(participatingThread !== undefined ? { participatingThread } : {}),
  };
}
