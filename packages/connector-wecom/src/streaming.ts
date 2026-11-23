/**
 * Streaming extension seam and official Enterprise WeChat (WeCom) stream protocol types.
 *
 * Current non-streaming delivery does not invoke streaming logic at runtime, while
 * exposing full zero-`any` protocol contracts and adapter hooks for future integration of:
 * 1. Intelligent Bot HTTP passive stream replies (`msgtype: "stream"`, `msgtype: "stream_with_template_card"`)
 *    and WeCom's periodic `msgtype: "stream"` refresh polling callbacks (6-minute window).
 * 2. Intelligent Bot WebSocket active stream updates via `aibot_respond_msg` frames
 *    reusing `headers.req_id` + `stream.id` until `stream.finish = true` (10-minute window).
 *
 * @see https://developer.work.weixin.qq.com/document/path/100719 Intelligent Bot HTTP callback & stream refresh
 * @see https://developer.work.weixin.qq.com/document/path/101031 Intelligent Bot passive stream reply specification
 * @see https://developer.work.weixin.qq.com/document/path/101463 Intelligent Bot WebSocket stream reply mechanism
 */

import { WECOM_AIBOT_CMD_RESPOND_MSG } from "./constants";

/**
 * Image attachment entry permitted on the final (`finish: true`) passive stream reply frame.
 * Up to 10 JPG/PNG images (each <= 10 MB before Base64 encoding).
 *
 * @see https://developer.work.weixin.qq.com/document/path/101031
 */
export interface WeComStreamImagePayload {
  readonly base64: string;
  readonly md5: string;
}

export interface WeComStreamImageItem {
  readonly msgtype: "image";
  readonly image: WeComStreamImagePayload;
}

export interface WeComStreamFeedback {
  readonly id: string;
}

/**
 * Official WeCom `stream` object shared by HTTP passive replies and WebSocket `aibot_respond_msg`.
 * Note: WeCom replaces displayed content with the latest `content` snapshot (max 20,480 UTF-8 bytes).
 *
 * @see https://developer.work.weixin.qq.com/document/path/101031
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export interface WeComStreamBody {
  readonly id?: string;
  readonly finish?: boolean;
  readonly content?: string;
  readonly msg_item?: readonly WeComStreamImageItem[];
  readonly feedback?: WeComStreamFeedback;
}

/**
 * Encrypted HTTP passive reply or WebSocket `aibot_respond_msg.body` payload for `msgtype: "stream"`.
 *
 * @see https://developer.work.weixin.qq.com/document/path/101031
 */
export interface WeComPassiveStreamReplyPayload {
  readonly msgtype: "stream";
  readonly stream: WeComStreamBody;
  readonly to_ai_assistant?: Readonly<Record<string, unknown>>;
}

/**
 * Combined stream + template card passive reply payload (`msgtype: "stream_with_template_card"`).
 *
 * @see https://developer.work.weixin.qq.com/document/path/101031
 */
export interface WeComPassiveStreamWithCardReplyPayload {
  readonly msgtype: "stream_with_template_card";
  readonly stream: WeComStreamBody;
  readonly template_card?: Readonly<Record<string, unknown>>;
}

/**
 * Decrypted HTTP callback payload sent by WeCom when polling for stream updates (`msgtype: "stream"`).
 *
 * @see https://developer.work.weixin.qq.com/document/path/100719
 */
export interface WeComStreamRefreshCallbackPayload {
  readonly msgid: string;
  readonly aibotid: string;
  readonly chatid?: string;
  readonly chattype: "single" | "group";
  readonly from: {
    readonly userid: string;
  };
  readonly msgtype: "stream";
  readonly stream: {
    readonly id: string;
  };
}

/**
 * Intelligent Bot WebSocket `aibot_respond_msg` frame carrying a streaming update.
 * All frames for the same callback turn must echo the inbound `headers.req_id` and share `stream.id`.
 *
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export interface WeComWsStreamRespondFrame {
  readonly cmd: typeof WECOM_AIBOT_CMD_RESPOND_MSG;
  readonly headers: {
    readonly req_id: string;
  };
  readonly body: WeComPassiveStreamReplyPayload;
}

export type WeComStreamTransportMode = "webhook-passive" | "websocket";

export interface WeComStreamTarget {
  readonly transportMode: WeComStreamTransportMode;
  readonly chatType: "single" | "group";
  readonly userId: string;
  readonly chatId?: string;
  readonly botId?: string;
  readonly inboundMsgId?: string;
  readonly reqId?: string;
}

export interface WeComStreamHandle {
  readonly streamId: string;
  readonly target: WeComStreamTarget;
  readonly startedAt: number;
  readonly expiresAt: number;
}

export interface WeComStreamUpdatePatch {
  readonly content: string;
  readonly delta?: string;
  readonly thinkingContent?: string;
  readonly feedbackId?: string;
}

export interface WeComStreamCompletePayload {
  readonly content: string;
  readonly images?: readonly WeComStreamImagePayload[];
  readonly feedbackId?: string;
}

/**
 * Extension adapter contract reserved for host-driven WeCom streaming output.
 *
 * @see https://developer.work.weixin.qq.com/document/path/101031
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export interface WeComStreamingAdapter {
  startStream(
    target: WeComStreamTarget,
    options?: { readonly initialContent?: string; readonly signal?: AbortSignal },
  ): Promise<WeComStreamHandle>;

  updateStream(
    handle: WeComStreamHandle,
    patch: WeComStreamUpdatePatch,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;

  completeStream(
    handle: WeComStreamHandle,
    payload: WeComStreamCompletePayload,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;

  abortStream(
    handle: WeComStreamHandle,
    reason?: { readonly message?: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;

  /**
   * Optional snapshot lookup used by HTTP callback mode when WeCom polls with `msgtype: "stream"`.
   */
  getPassiveStreamSnapshot?(
    streamId: string,
    refresh: WeComStreamRefreshCallbackPayload,
  ):
    | Promise<WeComPassiveStreamReplyPayload | undefined>
    | WeComPassiveStreamReplyPayload
    | undefined;
}

export interface WeComStreamingOptions {
  readonly enabled?: boolean;
  readonly adapter?: WeComStreamingAdapter;
  readonly streamWindowMs?: number;
}

export interface BuildPassiveStreamReplyInput {
  readonly streamId: string;
  readonly content?: string;
  readonly finish: boolean;
  readonly feedbackId?: string;
  readonly images?: readonly WeComStreamImagePayload[];
}

/**
 * Constructs an official `msgtype: "stream"` reply payload compliant with WeCom's schema.
 *
 * @see https://developer.work.weixin.qq.com/document/path/101031
 */
export function buildPassiveStreamReplyPayload(
  input: BuildPassiveStreamReplyInput,
): WeComPassiveStreamReplyPayload {
  const msgItems: readonly WeComStreamImageItem[] | undefined =
    input.finish && input.images !== undefined && input.images.length > 0
      ? input.images.map((image) => ({
          msgtype: "image" as const,
          image: { base64: image.base64, md5: image.md5 },
        }))
      : undefined;

  return {
    msgtype: "stream",
    stream: {
      id: input.streamId,
      finish: input.finish,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(msgItems !== undefined ? { msg_item: msgItems } : {}),
      ...(input.feedbackId !== undefined ? { feedback: { id: input.feedbackId } } : {}),
    },
  };
}

/**
 * Constructs an Intelligent Bot WebSocket `aibot_respond_msg` stream frame.
 *
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export function buildWsStreamRespondFrame(
  reqId: string,
  input: BuildPassiveStreamReplyInput,
): WeComWsStreamRespondFrame {
  return {
    cmd: WECOM_AIBOT_CMD_RESPOND_MSG,
    headers: { req_id: reqId },
    body: buildPassiveStreamReplyPayload(input),
  };
}

export function resolveWeComStreamingAdapter(options: {
  readonly streaming?: WeComStreamingOptions;
  readonly streamingAdapter?: WeComStreamingAdapter;
}): WeComStreamingAdapter | undefined {
  return options.streamingAdapter ?? options.streaming?.adapter;
}
