import type { ConnectorSendOptions } from "@dsh-connector/core";
import type { TelegramParseMode, TelegramSendResult } from "./types";

/**
 * Broadcast actions accepted by Telegram `sendChatAction` (status lasts up to 5 seconds
 * or until the bot sends a message).
 *
 * @see https://core.telegram.org/bots/api#sendchataction
 */
export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

/**
 * Official payload representation for Telegram `sendChatAction` (`typing` indicator).
 *
 * @see https://core.telegram.org/bots/api#sendchataction
 */
export interface TelegramSendChatActionParams {
  readonly chatId: number | string;
  readonly messageThreadId?: number;
  readonly action?: TelegramChatAction;
  readonly businessConnectionId?: string;
}

/**
 * Official payload representation for Telegram `editMessageText` in-place editing (`1..4096` chars).
 *
 * @see https://core.telegram.org/bots/api#editmessagetext
 */
export interface TelegramEditMessageTextParams {
  readonly chatId: number | string;
  readonly messageId: number;
  readonly text: string;
  readonly parseMode?: TelegramParseMode;
  readonly disableLinkPreview?: boolean;
  readonly businessConnectionId?: string;
}

/**
 * Official payload representation for Telegram Bot API `sendMessageDraft` (`0..4096` chars,
 * non-zero `draft_id`, temporary 30-second animated preview in private chats).
 * Once finalized, callers must persist the complete answer via `sendMessage`.
 *
 * @see https://core.telegram.org/bots/api#sendmessagedraft
 */
export interface TelegramSendMessageDraftParams {
  readonly chatId: number;
  readonly draftId: number;
  readonly messageThreadId?: number;
  readonly text?: string;
  readonly parseMode?: TelegramParseMode;
  readonly canStop?: boolean;
  readonly keepOnStop?: boolean;
}

/**
 * Normalized event corresponding to Telegram `Update.stopped_message_generation`
 * (`MessageGenerationStopped`) when `can_stop: true` was passed to `sendMessageDraft`.
 *
 * @see https://core.telegram.org/bots/api#messagegenerationstopped
 */
export interface TelegramMessageGenerationStoppedEvent {
  readonly chatId: number;
  readonly messageThreadId?: number;
  readonly draftId: number;
}

/**
 * Streaming transport strategies supported by Telegram Bot API:
 * - `"edit-message"`: send an initial placeholder via `sendMessage`, throttle `editMessageText`
 *   updates (`<=4096` chars), and finalize + split any overflow chunks via `sendMessage` (works in
 *   both private and group/forum chats).
 * - `"message-draft"`: stream partial previews via `sendMessageDraft` (`draft_id != 0`) in private
 *   chats and persist the final text via `sendMessage`.
 *
 * @see https://core.telegram.org/bots/api#editmessagetext
 * @see https://core.telegram.org/bots/api#sendmessagedraft
 */
export type TelegramStreamingMode = "edit-message" | "message-draft";

/**
 * Destination chat/topic coordinates for opening a Telegram streaming reply or `typing` indicator.
 */
export interface TelegramStreamTarget {
  readonly chatId: number | string;
  readonly messageThreadId?: number;
  readonly replyToMessageId?: number;
}

/**
 * Opaque-yet-typed handle tracking an active Telegram streaming session.
 */
export interface TelegramStreamHandle {
  readonly mode: TelegramStreamingMode;
  readonly chatId: number | string;
  readonly messageThreadId?: number;
  /** Sent placeholder `message_id` when `mode === "edit-message"`. */
  readonly anchorMessageId?: number;
  /** Non-zero `draft_id` when `mode === "message-draft"`. */
  readonly draftId?: number;
}

/**
 * Incremental update frame pushed to an active `TelegramStreamHandle`.
 */
export interface TelegramStreamUpdatePatch {
  readonly text: string;
  readonly parseMode?: TelegramParseMode;
  readonly canStop?: boolean;
  readonly keepOnStop?: boolean;
}

/**
 * Finalization payload committed when a Telegram streaming turn completes.
 */
export interface TelegramStreamFinalizeParams {
  readonly text: string;
  readonly parseMode?: TelegramParseMode;
  readonly disableLinkPreview?: boolean;
}

/**
 * Reserved extension seam for future host-driven Telegram streaming integration.
 * Not invoked during v0.1 non-streaming message send/receive loops, allowing future streaming
 * rollout without breaking `TelegramConnectorOptions` or `TelegramConnector` public signatures.
 *
 * @see https://core.telegram.org/bots/api#editmessagetext
 * @see https://core.telegram.org/bots/api#sendchataction
 * @see https://core.telegram.org/bots/api#sendmessagedraft
 */
export interface TelegramStreamingAdapter {
  /**
   * Broadcast `sendChatAction` (`action = "typing"`) before or during a long-running turn.
   *
   * @see https://core.telegram.org/bots/api#sendchataction
   */
  sendTypingIndicator?(target: TelegramStreamTarget, options?: ConnectorSendOptions): Promise<void>;

  /**
   * Start a streaming reply (`sendMessage` placeholder or initial `sendMessageDraft`).
   */
  startStream(
    target: TelegramStreamTarget,
    initial?: TelegramStreamUpdatePatch,
    options?: ConnectorSendOptions,
  ): Promise<TelegramStreamHandle>;

  /**
   * Push an updated partial snapshot via `editMessageText` or `sendMessageDraft`.
   */
  updateStream(
    handle: TelegramStreamHandle,
    patch: TelegramStreamUpdatePatch,
    options?: ConnectorSendOptions,
  ): Promise<TelegramStreamHandle>;

  /**
   * Finalize the streamed reply (`editMessageText` + overflow `sendMessage`, or final `sendMessage`
   * after `sendMessageDraft`) and return the persisted `TelegramSendResult`.
   */
  completeStream(
    handle: TelegramStreamHandle,
    finalMessage: TelegramStreamFinalizeParams,
    options?: ConnectorSendOptions,
  ): Promise<TelegramSendResult>;

  /**
   * Abort or clean up an interrupted stream (e.g. `deleteMessage` or error notice edit).
   *
   * @see https://core.telegram.org/bots/api#deletemessage
   */
  abortStream?(
    handle: TelegramStreamHandle,
    reason?: { readonly kind: "cancelled" | "error"; readonly message?: string },
    options?: ConnectorSendOptions,
  ): Promise<void>;

  /**
   * Optional hook invoked when Telegram delivers `Update.stopped_message_generation`.
   *
   * @see https://core.telegram.org/bots/api#messagegenerationstopped
   */
  onGenerationStopped?(event: TelegramMessageGenerationStoppedEvent): Promise<void> | void;
}

/**
 * Streaming configuration block reserved on `TelegramConnectorOptions`.
 */
export interface TelegramStreamingOptions {
  readonly preferredMode?: TelegramStreamingMode;
  readonly throttleIntervalMs?: number;
  readonly typingKeepaliveIntervalMs?: number;
  readonly adapter?: TelegramStreamingAdapter;
}
