/**
 * Reserved streaming, typing indicator, and progressive segment continuation types for WeChat.
 *
 * Note: Official Account Customer Service API (`message/custom/send`) does not support in-place
 * editing of already delivered messages, so future streaming integrations on WeChat rely on:
 * 1. Sending and refreshing the official Customer Service typing indicator (`message/custom/typing`)
 *    within the 30-second active interaction window; and
 * 2. Progressive segment flushing / AI message context (`aimsgcontext`) continuation or rich-media
 *    follow-ups via `message/custom/send` (or iLink `sendtyping` + `sendmessage`).
 *
 * Streaming runtime execution is intentionally NOT implemented in this phase; these zero-`any`
 * types and adapter seams reserve a stable extension surface without breaking public APIs later.
 *
 * @see https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 */

/**
 * Official WeChat Customer Service typing command (`POST /cgi-bin/message/custom/typing`).
 *
 * - `"Typing"`: Deliver "typing..." indicator to the user (requires message interaction within 30s).
 * - `"CancelTyping"`: Cancel the active typing indicator for the user.
 *
 * @see https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html
 */
export type WeixinTypingCommand = "Typing" | "CancelTyping";

/**
 * Official request payload for `POST https://api.weixin.qq.com/cgi-bin/message/custom/typing`.
 *
 * @see https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html
 */
export interface WeixinCustomTypingPayload {
  readonly touser: string;
  readonly command: WeixinTypingCommand;
  readonly businessid?: string;
}

/**
 * Optional `aimsgcontext` metadata accepted by official `POST /cgi-bin/message/custom/send`.
 *
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 */
export interface WeixinAiMsgContext {
  readonly [key: string]: string | number | boolean | undefined;
}

/**
 * Target coordinates for starting a WeChat typing / progressive reply stream.
 */
export interface WeixinStreamTarget {
  readonly mode: "official-account" | "ilink";
  readonly openId: string;
  readonly kfAccount?: string;
  readonly businessId?: string;
  readonly contextToken?: string;
  readonly typingTicket?: string;
}

/**
 * Handle tracking an in-flight WeChat progressive / typing-assisted reply turn.
 */
export interface WeixinStreamHandle {
  readonly streamId: string;
  readonly target: WeixinStreamTarget;
  readonly startedAt: number;
  readonly chunkSeq: number;
  readonly messageIds: readonly string[];
  readonly typingActive: boolean;
}

/**
 * Incremental update payload pushed during an active assistant turn.
 */
export interface WeixinStreamUpdatePatch {
  readonly delta?: string;
  readonly accumulatedText?: string;
  readonly statusText?: string;
}

/**
 * Finalization payload when an assistant reply turn completes.
 */
export interface WeixinStreamCompleteInput {
  readonly text: string;
  readonly format?: "plain" | "markdown";
  readonly aiMsgContext?: WeixinAiMsgContext;
}

/**
 * Reason payload when an in-flight stream is cancelled or fails.
 */
export interface WeixinStreamAbortReason {
  readonly kind: "cancelled" | "error";
  readonly message?: string;
}

export interface WeixinStreamCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * Pluggable adapter interface reserved for future WeChat typing keepalive & segmented streaming.
 *
 * @see https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html
 * @see https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
 */
export interface WeixinStreamingAdapter {
  sendTypingIndicator?(
    target: WeixinStreamTarget,
    command: WeixinTypingCommand,
    options?: WeixinStreamCallOptions,
  ): Promise<void>;

  startStream(
    target: WeixinStreamTarget,
    options?: WeixinStreamCallOptions,
  ): Promise<WeixinStreamHandle>;

  updateStream(
    handle: WeixinStreamHandle,
    patch: WeixinStreamUpdatePatch,
    options?: WeixinStreamCallOptions,
  ): Promise<WeixinStreamHandle | void>;

  completeStream(
    handle: WeixinStreamHandle,
    result: WeixinStreamCompleteInput,
    options?: WeixinStreamCallOptions,
  ): Promise<void>;

  abortStream(
    handle: WeixinStreamHandle,
    reason: WeixinStreamAbortReason,
    options?: WeixinStreamCallOptions,
  ): Promise<void>;
}

/**
 * Reserved streaming configuration block on `WeixinConnectorOptions`.
 */
export interface WeixinStreamingOptions {
  readonly enabled?: boolean;
  readonly typingKeepaliveMs?: number;
  readonly segmentFlushChars?: number;
  readonly adapter?: WeixinStreamingAdapter;
}
