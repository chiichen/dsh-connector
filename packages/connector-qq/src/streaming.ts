import type {
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  QQ_FILE_TYPE_VIDEO,
  QQ_FILE_TYPE_VOICE,
  QQ_STREAM_INPUT_STATE_COMPLETED,
  QQ_STREAM_INPUT_STATE_GENERATING,
} from "./constants";
import type { QqMessageFormat, QqRawSendResponse, QqSendResult, QqTarget } from "./types";

/**
 * Streaming and multi-segment reply delivery modes reserved for future host-driven
 * turn streaming integration on QQ Official Bot:
 * - `"c2c-native-stream"`: C2C native `POST /v2/users/{user_openid}/stream_messages`
 *   using shared `stream_msg_id` and monotonic `index` (`0..N`) with `input_state` `1 -> 10`.
 * - `"passive-msg-seq"`: Multi-segment continuation sharing a single passive `msg_id`
 *   with monotonically increasing `msg_seq` (`1..4` in C2C, `1..5` or `1..50` in Group)
 *   for group chats and rich media / Markdown delivery where `stream_messages` is unavailable.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 */
export type QqStreamingDeliveryMode = "c2c-native-stream" | "passive-msg-seq";

export type QqC2cStreamInputMode = "append" | "replace";

export type QqC2cStreamInputState =
  | typeof QQ_STREAM_INPUT_STATE_GENERATING
  | typeof QQ_STREAM_INPUT_STATE_COMPLETED;

export type QqC2cStreamContentType = "text" | "markdown";

/**
 * Official request payload for `POST /v2/users/{user_openid}/stream_messages`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
 */
export interface QqC2cStreamMessageRequest {
  readonly input_mode?: QqC2cStreamInputMode;
  readonly input_state: QqC2cStreamInputState;
  readonly index: number;
  readonly content_type?: QqC2cStreamContentType;
  readonly content_raw: string;
  readonly msg_id?: string;
  readonly event_id?: string;
  readonly stream_msg_id?: string;
  readonly msg_seq?: number;
  readonly is_wakeup?: boolean;
}

/**
 * Official response payload for `POST /v2/users/{user_openid}/stream_messages`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
 */
export interface QqC2cStreamMessageResponse extends QqRawSendResponse {
  readonly remain_msg_len?: number;
}

/**
 * Official `file_type` enum for rich media upload (`/v2/users/{openid}/files`, `/v2/groups/{group_openid}/files`).
 * `1` = image, `2` = video, `3` = voice (SILK), `4` = generic file.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
 */
export type QqRichMediaFileType =
  | typeof QQ_FILE_TYPE_IMAGE
  | typeof QQ_FILE_TYPE_VIDEO
  | typeof QQ_FILE_TYPE_VOICE
  | typeof QQ_FILE_TYPE_FILE;

/**
 * Rich media attachment payload (`msg_type=7`) referencing an uploaded `file_info` handle.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
 */
export interface QqRichMediaPayload {
  readonly fileType: QqRichMediaFileType;
  readonly fileInfo: string;
  readonly ttlSeconds?: number;
}

/**
 * Structured Markdown message payload (`msg_type=2`), supporting either raw Markdown
 * `content` or template-based `custom_template_id` + `params`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 */
export interface QqMarkdownPayload {
  readonly content?: string;
  readonly customTemplateId?: string;
  readonly params?: ReadonlyArray<{
    readonly key: string;
    readonly values: readonly string[];
  }>;
}

/**
 * C2C typing / input status indicator payload (`msg_type=6`, `input_notify`).
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 */
export interface QqInputNotifyPayload {
  readonly inputType: number;
  readonly inputSecond: number;
}

/**
 * Target descriptor for initiating a streaming or multi-segment passive reply turn.
 */
export interface QqStreamTarget {
  readonly target: QqTarget;
  readonly passiveMsgId?: string;
  readonly eventId?: string;
  readonly initialMsgSeq?: number;
}

/**
 * Tracks multi-segment continuation state sharing the same passive `msg_id` with
 * strictly increasing `msg_seq` values.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 */
export interface QqPassiveContinuationState {
  readonly passiveMsgId: string;
  readonly lastMsgSeq: number;
  readonly sentSegments: number;
  readonly maxPassiveSegments?: number;
}

/**
 * Immutable handle representing an in-flight QQ streaming or multi-segment reply session.
 */
export interface QqStreamHandle {
  readonly streamId: string;
  readonly target: QqTarget;
  readonly mode: QqStreamingDeliveryMode;
  readonly streamMsgId?: string;
  readonly passiveMsgId?: string;
  readonly nextIndex: number;
  readonly msgSeq: number;
  readonly passiveContinuation?: QqPassiveContinuationState;
}

/**
 * Incremental update payload passed to `QqStreamingAdapter.updateStream`.
 */
export interface QqStreamChunkUpdate {
  readonly accumulatedText: string;
  readonly deltaText?: string;
  readonly format?: QqMessageFormat;
  readonly markdown?: QqMarkdownPayload;
  readonly media?: QqRichMediaPayload;
}

/**
 * Finalization payload passed to `QqStreamingAdapter.completeStream`.
 */
export interface QqStreamCompletion {
  readonly finalText: string;
  readonly format?: QqMessageFormat;
  readonly markdown?: QqMarkdownPayload;
  readonly media?: readonly QqRichMediaPayload[];
}

/**
 * Optional configuration reserved on `QqConnectorOptions` for future streaming support.
 */
export interface QqStreamingOptions {
  readonly enabled?: boolean;
  readonly preferredMode?: QqStreamingDeliveryMode;
  readonly c2cInputMode?: QqC2cStreamInputMode;
  readonly throttleMs?: number;
  readonly enableTypingIndicator?: boolean;
}

/**
 * Extension adapter contract reserved for future QQ streaming & multi-segment delivery.
 * Not invoked during current non-streaming send/receive operation.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
 */
export interface QqStreamingAdapter {
  sendTypingIndicator?(
    target: Extract<QqTarget, { readonly scene: "c2c" }>,
    payload?: QqInputNotifyPayload,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;

  startStream(
    streamTarget: QqStreamTarget,
    initial?: QqStreamChunkUpdate,
    options?: { readonly signal?: AbortSignal },
  ): Promise<QqStreamHandle>;

  updateStream(
    handle: QqStreamHandle,
    update: QqStreamChunkUpdate,
    options?: { readonly signal?: AbortSignal },
  ): Promise<QqStreamHandle>;

  appendPassiveSegment?(
    handle: QqStreamHandle,
    segment: QqStreamChunkUpdate,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly handle: QqStreamHandle; readonly result: QqSendResult }>;

  completeStream(
    handle: QqStreamHandle,
    completion: QqStreamCompletion,
    options?: { readonly signal?: AbortSignal },
  ): Promise<QqSendResult>;

  abortStream(
    handle: QqStreamHandle,
    reason?: { readonly kind: "cancelled" | "error"; readonly message?: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}
