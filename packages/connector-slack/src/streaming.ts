/**
 * Extension seam types and adapter contracts reserved for Slack in-place message updates,
 * AI Assistant thread status indicators, and native Slack streaming conversations.
 *
 * NOTE: Outbound/inbound Slack delivery in Phase 2 runs in non-streaming mode via
 * `chat.postMessage`. These interfaces reserve zero-breaking-change extension points
 * so future host-driven streaming (`ConnectorReplyHandler`) can plug into Slack's
 * native streaming and message editing APIs directly.
 *
 * @see https://docs.slack.dev/reference/methods/chat.update
 * @see https://docs.slack.dev/reference/methods/assistant.threads.setStatus
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 * @see https://docs.slack.dev/reference/methods/chat.appendStream
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 */

/**
 * Strategy used to render progressive assistant output in Slack:
 * - `"native-stream"`: Slack native `chat.startStream` -> `chat.appendStream` -> `chat.stopStream`
 * - `"chat-update"`: Initial `chat.postMessage` placeholder followed by throttled `chat.update`
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 * @see https://docs.slack.dev/reference/methods/chat.update
 */
export type SlackStreamMode = "native-stream" | "chat-update";

/**
 * Task display mode for `chat.startStream` task chunks.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 */
export type SlackStreamTaskDisplayMode = "timeline" | "plan";

/**
 * Status of an individual task card inside Slack streaming `chunks`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 */
export type SlackStreamTaskStatus = "pending" | "in_progress" | "complete" | "error";

/**
 * Agent session status set upon finalizing a Slack stream via `chat.stopStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 * @see https://docs.slack.dev/ai/agent-sessions/
 */
export type SlackAgentSessionStatus = "active" | "processing" | "suspended" | "closed";

/**
 * Structured chunk union accepted by `chat.startStream`, `chat.appendStream`, and `chat.stopStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 * @see https://docs.slack.dev/reference/methods/chat.appendStream
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 */
export type SlackStreamChunk =
  | {
      readonly type: "markdown_text";
      readonly text: string;
    }
  | {
      readonly type: "task_update";
      readonly id: string;
      readonly title: string;
      readonly status: SlackStreamTaskStatus;
      readonly details?: string;
      readonly output?: string;
    }
  | {
      readonly type: "plan_update";
      readonly title: string;
    };

/**
 * Request payload for `POST https://slack.com/api/chat.update`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.update
 */
export interface SlackChatUpdateParams {
  readonly channel: string;
  readonly ts: string;
  readonly text?: string;
  readonly markdown_text?: string;
  readonly blocks?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly as_user?: boolean;
  readonly link_names?: boolean;
}

/**
 * Response payload from `POST https://slack.com/api/chat.update`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.update
 */
export interface SlackChatUpdateResult {
  readonly ok: true;
  readonly channel: string;
  readonly ts: string;
  readonly text?: string;
}

/**
 * Request payload for `POST https://slack.com/api/assistant.threads.setStatus`.
 * Passing an empty string in `status` clears the active assistant status indicator.
 *
 * @see https://docs.slack.dev/reference/methods/assistant.threads.setStatus
 */
export interface SlackAssistantThreadStatusParams {
  readonly channel_id: string;
  readonly thread_ts: string;
  readonly status: string;
  readonly loading_messages?: readonly string[];
}

/**
 * Response payload from `POST https://slack.com/api/assistant.threads.setStatus`.
 *
 * @see https://docs.slack.dev/reference/methods/assistant.threads.setStatus
 */
export interface SlackAssistantThreadStatusResult {
  readonly ok: true;
}

/**
 * Request payload for `POST https://slack.com/api/chat.startStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 */
export interface SlackStartStreamParams {
  readonly channel: string;
  readonly thread_ts?: string;
  readonly markdown_text?: string;
  readonly chunks?: readonly SlackStreamChunk[];
  readonly recipient_user_id?: string;
  readonly recipient_team_id?: string;
  readonly task_display_mode?: SlackStreamTaskDisplayMode;
}

/**
 * Response payload from `POST https://slack.com/api/chat.startStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 */
export interface SlackStartStreamResult {
  readonly ok: true;
  readonly channel: string;
  readonly ts: string;
}

/**
 * Request payload for `POST https://slack.com/api/chat.appendStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.appendStream
 */
export interface SlackAppendStreamParams {
  readonly channel: string;
  readonly ts: string;
  readonly markdown_text?: string;
  readonly chunks?: readonly SlackStreamChunk[];
}

/**
 * Response payload from `POST https://slack.com/api/chat.appendStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.appendStream
 */
export interface SlackAppendStreamResult {
  readonly ok: true;
  readonly channel: string;
  readonly ts: string;
}

/**
 * Request payload for `POST https://slack.com/api/chat.stopStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 */
export interface SlackStopStreamParams {
  readonly channel: string;
  readonly ts: string;
  readonly markdown_text?: string;
  readonly chunks?: readonly SlackStreamChunk[];
  readonly blocks?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly session_status?: SlackAgentSessionStatus;
}

/**
 * Response payload from `POST https://slack.com/api/chat.stopStream`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 */
export interface SlackStopStreamResult {
  readonly ok: true;
  readonly channel: string;
  readonly ts: string;
}

/**
 * Target conversation metadata required to initiate a Slack stream.
 * Note: `recipientUserId` and `recipientTeamId` are required by Slack `chat.startStream`
 * when streaming into public or private channels.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 */
export interface SlackStreamTarget {
  readonly channelId: string;
  readonly threadTs?: string;
  readonly recipientUserId?: string;
  readonly recipientTeamId?: string;
}

/**
 * Opaque handle representing an active Slack streaming message (`native-stream` or `chat-update`).
 */
export interface SlackStreamHandle {
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly mode: SlackStreamMode;
}

/**
 * Pluggable Slack streaming & in-place message update adapter interface.
 *
 * @see https://docs.slack.dev/reference/methods/chat.update
 * @see https://docs.slack.dev/reference/methods/assistant.threads.setStatus
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 * @see https://docs.slack.dev/reference/methods/chat.appendStream
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 */
export interface SlackStreamingAdapter {
  /**
   * Sets or clears (via `status: ""`) the AI Assistant thread status indicator.
   *
   * @see https://docs.slack.dev/reference/methods/assistant.threads.setStatus
   */
  setAssistantThreadStatus?(
    params: SlackAssistantThreadStatusParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SlackAssistantThreadStatusResult>;

  /**
   * Performs an in-place edit of an existing bot-authored Slack message via `chat.update`.
   *
   * @see https://docs.slack.dev/reference/methods/chat.update
   */
  updateMessage?(
    params: SlackChatUpdateParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SlackChatUpdateResult>;

  /**
   * Opens a new Slack streaming message (`chat.startStream` or placeholder `chat.postMessage`).
   *
   * @see https://docs.slack.dev/reference/methods/chat.startStream
   */
  startStream(
    target: SlackStreamTarget,
    initial?: {
      readonly markdownText?: string;
      readonly chunks?: readonly SlackStreamChunk[];
      readonly taskDisplayMode?: SlackStreamTaskDisplayMode;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<SlackStreamHandle>;

  /**
   * Appends incremental markdown/chunks (`chat.appendStream`) or updates text (`chat.update`).
   *
   * @see https://docs.slack.dev/reference/methods/chat.appendStream
   */
  appendStream(
    handle: SlackStreamHandle,
    update: {
      readonly markdownText?: string;
      readonly chunks?: readonly SlackStreamChunk[];
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<SlackAppendStreamResult | SlackChatUpdateResult>;

  /**
   * Finalizes an open Slack stream (`chat.stopStream` or final `chat.update`).
   *
   * @see https://docs.slack.dev/reference/methods/chat.stopStream
   */
  completeStream(
    handle: SlackStreamHandle,
    final?: {
      readonly markdownText?: string;
      readonly chunks?: readonly SlackStreamChunk[];
      readonly blocks?: ReadonlyArray<Readonly<Record<string, unknown>>>;
      readonly sessionStatus?: SlackAgentSessionStatus;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<SlackStopStreamResult | SlackChatUpdateResult>;

  /**
   * Cancels/aborts an open Slack stream and clears any active status indicator.
   *
   * @see https://docs.slack.dev/reference/methods/chat.stopStream
   */
  abortStream?(
    handle: SlackStreamHandle,
    reason?: {
      readonly message?: string;
      readonly sessionStatus?: SlackAgentSessionStatus;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

/**
 * Reserved streaming configuration slot on `SlackConnectorOptions`.
 */
export interface SlackStreamingOptions {
  readonly preferredMode?: SlackStreamMode;
  readonly throttleMs?: number;
  readonly defaultLoadingMessages?: readonly string[];
  readonly adapter?: SlackStreamingAdapter;
}
