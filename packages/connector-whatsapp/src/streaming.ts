import {
  DEFAULT_WHATSAPP_STATUS_REACTIONS,
  WHATSAPP_MESSAGING_PRODUCT,
  WHATSAPP_READ_STATUS,
  WHATSAPP_TYPING_INDICATOR_TYPE,
} from "./constants";
import type { WhatsAppRecipientType, WhatsAppSendResult } from "./types";

/**
 * Streaming and turn-progress extension seam for Meta WhatsApp Business Cloud API.
 *
 * Note on official Cloud API capabilities:
 * Unlike unofficial WhatsApp Web (Baileys), Meta's official WhatsApp Business Cloud API does not
 * currently expose a general-purpose `editMessage` endpoint for arbitrary text messages. Instead,
 * turn-progress and progressive streaming UX on official Cloud API combines:
 * 1. Marking incoming messages as read with an active typing indicator (`status: "read"` +
 *    `typing_indicator: { type: "text" }`, auto-dismissed after 25s or on reply),
 * 2. Lifecycle emoji reactions (`processing` -> `success` | `error` | clear `""`), and
 * 3. Progressive segmented text delivery via `WhatsAppStreamingAdapter`.
 *
 * Only non-streaming request/response delivery is wired by default in this phase; these types and
 * payload builders reserve a zero-breaking-change extension seam for future host-driven streaming.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/reaction-messages
 */

export type WhatsAppTypingIndicatorType = typeof WHATSAPP_TYPING_INDICATOR_TYPE;

export type WhatsAppStatusReactionPhase = "processing" | "success" | "error" | "clear";

export interface WhatsAppStatusReactionEmojiMap {
  readonly processing?: string;
  readonly success?: string;
  readonly error?: string;
}

/**
 * Official Cloud API request payload to mark an incoming message as read, with an optional
 * typing indicator (`typing_indicator: { type: "text" }`).
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read
 */
export interface WhatsAppMarkReadPayload {
  readonly messaging_product: "whatsapp";
  readonly status: "read";
  readonly message_id: string;
  readonly typing_indicator?: {
    readonly type: WhatsAppTypingIndicatorType;
  };
}

/**
 * Response returned by Cloud API mark-as-read / typing indicator requests.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators#response
 */
export interface WhatsAppStatusActionResponse {
  readonly success: boolean;
}

/**
 * Official Cloud API request payload to apply or clear (`emoji: ""`) a reaction on a message.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/reaction-messages
 */
export interface WhatsAppReactionMessagePayload {
  readonly messaging_product: "whatsapp";
  readonly recipient_type: WhatsAppRecipientType;
  readonly to: string;
  readonly type: "reaction";
  readonly reaction: {
    readonly message_id: string;
    readonly emoji: string;
  };
}

export interface WhatsAppStreamTarget {
  readonly phoneNumberId: string;
  readonly to: string;
  readonly recipientType: WhatsAppRecipientType;
  readonly inboundMessageId?: string;
  readonly replyToMessageId?: string;
}

export interface WhatsAppStreamHandle {
  readonly streamId: string;
  readonly target: WhatsAppStreamTarget;
  readonly startedAt: number;
  readonly sentMessageIds: readonly string[];
}

export interface WhatsAppStreamUpdate {
  readonly delta?: string;
  readonly accumulatedText: string;
  readonly statusReaction?: WhatsAppStatusReactionPhase;
}

export interface WhatsAppStreamCompletion {
  readonly finalText: string;
  readonly previewUrl?: boolean;
  readonly statusReaction?: Extract<WhatsAppStatusReactionPhase, "success" | "clear">;
}

export interface WhatsAppStreamAbortReason {
  readonly kind: "cancelled" | "error";
  readonly message?: string;
}

/**
 * Pluggable adapter contract for turn-progress indicators and progressive response streaming
 * over Meta WhatsApp Business Cloud API.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/reaction-messages
 */
export interface WhatsAppStreamingAdapter {
  markReadAndTyping?(
    target: WhatsAppStreamTarget,
    options?: { readonly includeTypingIndicator?: boolean; readonly signal?: AbortSignal },
  ): Promise<WhatsAppStatusActionResponse>;

  setStatusReaction?(
    target: WhatsAppStreamTarget,
    phase: WhatsAppStatusReactionPhase,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;

  startStream(
    target: WhatsAppStreamTarget,
    options?: { readonly initialText?: string; readonly signal?: AbortSignal },
  ): Promise<WhatsAppStreamHandle>;

  updateStream(
    handle: WhatsAppStreamHandle,
    update: WhatsAppStreamUpdate,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WhatsAppStreamHandle>;

  completeStream(
    handle: WhatsAppStreamHandle,
    completion: WhatsAppStreamCompletion,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WhatsAppSendResult>;

  abortStream(
    handle: WhatsAppStreamHandle,
    reason: WhatsAppStreamAbortReason,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

/**
 * Streaming and status-indicator options reserved on `WhatsAppConnectorOptions`.
 */
export interface WhatsAppStreamingOptions {
  readonly enabled?: boolean;
  readonly markAsReadOnReceive?: boolean;
  readonly sendTypingIndicator?: boolean;
  readonly typingKeepaliveIntervalMs?: number;
  readonly segmentFlushMinChars?: number;
  readonly statusReactions?: WhatsAppStatusReactionEmojiMap;
  readonly adapter?: WhatsAppStreamingAdapter;
}

/**
 * Builds an official Cloud API `status: "read"` payload for `POST /{version}/{phone-number-id}/messages`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read
 */
export function buildMarkReadPayload(messageId: string): WhatsAppMarkReadPayload {
  return {
    messaging_product: WHATSAPP_MESSAGING_PRODUCT,
    status: WHATSAPP_READ_STATUS,
    message_id: messageId,
  };
}

/**
 * Builds an official Cloud API `status: "read"` + `typing_indicator: { type: "text" }` payload
 * for `POST /{version}/{phone-number-id}/messages`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 */
export function buildTypingIndicatorPayload(messageId: string): WhatsAppMarkReadPayload {
  return {
    messaging_product: WHATSAPP_MESSAGING_PRODUCT,
    status: WHATSAPP_READ_STATUS,
    message_id: messageId,
    typing_indicator: {
      type: WHATSAPP_TYPING_INDICATOR_TYPE,
    },
  };
}

/**
 * Builds an official Cloud API `type: "reaction"` payload for `POST /{version}/{phone-number-id}/messages`.
 * Passing `emoji: ""` removes a previously applied reaction.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/reaction-messages
 */
export function buildReactionPayload(params: {
  readonly to: string;
  readonly recipientType: WhatsAppRecipientType;
  readonly messageId: string;
  readonly emoji: string;
}): WhatsAppReactionMessagePayload {
  return {
    messaging_product: WHATSAPP_MESSAGING_PRODUCT,
    recipient_type: params.recipientType,
    to: params.to,
    type: "reaction",
    reaction: {
      message_id: params.messageId,
      emoji: params.emoji,
    },
  };
}

/**
 * Resolves the emoji string for a lifecycle reaction phase (`""` clears the reaction).
 */
export function resolveStatusReactionEmoji(
  phase: WhatsAppStatusReactionPhase,
  overrides?: WhatsAppStatusReactionEmojiMap,
): string {
  if (phase === "clear") {
    return "";
  }
  return overrides?.[phase] ?? DEFAULT_WHATSAPP_STATUS_REACTIONS[phase];
}
