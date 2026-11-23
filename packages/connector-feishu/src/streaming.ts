/**
 * Reserved streaming extension seam for `@dsh-connector/connector-feishu`.
 *
 * NOTE: The current package intentionally implements non-streaming inbound/outbound
 * closed-loop messaging only. These strongly typed interfaces, official OpenAPI
 * payload contracts, and pure helper functions reserve clean extension slots for:
 *
 * 1. **Feishu CardKit v1 Streaming Card Updates (`cardkit/v1/cards`)**:
 *    - Create card entity (`streaming_mode: true`): `POST /open-apis/cardkit/v1/cards`
 *    - Stream element text (typewriter effect with strictly increasing `sequence`):
 *      `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content`
 *    - Update full element: `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id`
 *    - Close/update card streaming config (`streaming_mode: false`):
 *      `PATCH /open-apis/cardkit/v1/cards/:card_id/settings`
 *
 * 2. **Feishu Sent Message Card In-Place Edit (`im/v1/messages`)**:
 *    - Patch interactive message card (`update_multi: true`, <= 5 QPS per message):
 *      `PATCH /open-apis/im/v1/messages/:message_id`
 *
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 * @see https://open.feishu.cn/document/cardkit-v1/card/create
 * @see https://open.feishu.cn/document/cardkit-v1/card-element/content
 * @see https://open.feishu.cn/document/cardkit-v1/card-element/update
 * @see https://open.feishu.cn/document/cardkit-v1/card/settings
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
 */

import {
  ConnectorValidationError,
  type ConnectorContext,
  type ConnectorSendOptions,
} from "@dsh-connector/core";
import {
  CARDKIT_MAX_INT32_SEQUENCE,
  CARDKIT_MIN_SEQUENCE,
  DEFAULT_CARDKIT_STREAM_ELEMENT_ID,
  FEISHU_CARD_SCHEMA_V2,
} from "./constants";
import type { FeishuResolvedSendTarget } from "./context";

export type FeishuStreamingStrategy = "cardkit-v1" | "message-card-patch";

/**
 * Per-client-platform typewriter rendering numbers in Feishu Card JSON 2.0 `streaming_config`.
 *
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 */
export interface FeishuCardPlatformNumbers {
  readonly default: number;
  readonly android?: number;
  readonly ios?: number;
  readonly pc?: number;
}

/**
 * Feishu Card JSON 2.0 `config.streaming_config` parameters.
 *
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 */
export interface FeishuCardStreamingConfig {
  readonly print_frequency_ms?: FeishuCardPlatformNumbers;
  readonly print_step?: FeishuCardPlatformNumbers;
  readonly print_strategy?: "fast" | "delay";
}

/**
 * Official request body for `POST /open-apis/cardkit/v1/cards`.
 *
 * @see https://open.feishu.cn/document/cardkit-v1/card/create
 */
export interface FeishuCreateCardEntityRequest {
  readonly type: "card_json" | "template";
  /** Escaped JSON string of Card JSON 2.0 (`schema: "2.0"`) or template payload. */
  readonly data: string;
}

/**
 * Official `data` response structure from `POST /open-apis/cardkit/v1/cards`.
 *
 * @see https://open.feishu.cn/document/cardkit-v1/card/create
 */
export interface FeishuCreateCardEntityResponseData {
  readonly card_id: string;
}

/**
 * Official request body for `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content`.
 * Note: `content` is the full accumulated text prefix; `sequence` must strictly increase (`1..2147483647`).
 *
 * @see https://open.feishu.cn/document/cardkit-v1/card-element/content
 */
export interface FeishuStreamCardElementContentRequest {
  readonly content: string;
  readonly sequence: number;
  readonly uuid?: string;
}

/**
 * Official request body for `PATCH /open-apis/cardkit/v1/cards/:card_id/settings`
 * (e.g. toggling `config.streaming_mode` to `false` when streaming finishes).
 *
 * @see https://open.feishu.cn/document/cardkit-v1/card/settings
 */
export interface FeishuUpdateCardSettingsRequest {
  /** Escaped JSON string containing `{ config: { streaming_mode: boolean, ... }, card_link?: ... }`. */
  readonly settings: string;
  readonly sequence: number;
  readonly uuid?: string;
}

/**
 * Official request body for `PATCH /open-apis/im/v1/messages/:message_id`
 * to update a previously sent `interactive` card (`config.update_multi: true`).
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
 */
export interface FeishuPatchMessageCardRequest {
  /** Escaped JSON string of the updated interactive card content. */
  readonly content: string;
}

export type FeishuStreamTarget = FeishuResolvedSendTarget;

/**
 * Immutable handle tracking an in-progress or completed Feishu streaming reply.
 */
export interface FeishuStreamHandle {
  readonly streamId: string;
  readonly strategy: FeishuStreamingStrategy;
  readonly messageId: string;
  readonly chatId?: string;
  readonly threadId?: string;
  readonly cardId?: string;
  readonly elementId?: string;
  /** Latest CardKit v1 operation sequence number (`0` if not yet incremented). */
  readonly sequence: number;
}

export interface FeishuStreamStartInput {
  readonly target: FeishuStreamTarget;
  readonly initialText?: string;
  readonly title?: string;
  readonly elementId?: string;
  readonly streamingConfig?: FeishuCardStreamingConfig;
}

export interface FeishuStreamUpdateInput {
  /** Full accumulated text content (enables Feishu CardKit typewriter prefix diffing). */
  readonly content: string;
  readonly delta?: string;
  readonly uuid?: string;
}

export interface FeishuStreamCompleteInput {
  readonly finalContent: string;
  readonly summary?: string;
  readonly uuid?: string;
}

export interface FeishuStreamAbortInput {
  readonly reason: "cancelled" | "error";
  readonly fallbackContent?: string;
  readonly errorMessage?: string;
}

/**
 * Pluggable Feishu streaming adapter contract for future host-driven turn streaming
 * (`ConnectorReplyHandler`) without breaking `FeishuConnector` constructor or sender APIs.
 *
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
 */
export interface FeishuStreamingAdapter<TName extends string = string> {
  readonly strategy: FeishuStreamingStrategy;

  startStream(
    context: ConnectorContext<TName>,
    input: FeishuStreamStartInput,
    options?: ConnectorSendOptions,
  ): Promise<FeishuStreamHandle>;

  updateStream(
    handle: FeishuStreamHandle,
    input: FeishuStreamUpdateInput,
    options?: ConnectorSendOptions,
  ): Promise<FeishuStreamHandle>;

  completeStream(
    handle: FeishuStreamHandle,
    input: FeishuStreamCompleteInput,
    options?: ConnectorSendOptions,
  ): Promise<FeishuStreamHandle>;

  abortStream(
    handle: FeishuStreamHandle,
    input: FeishuStreamAbortInput,
    options?: ConnectorSendOptions,
  ): Promise<void>;

  patchMessageCard?(
    messageId: string,
    request: FeishuPatchMessageCardRequest,
    options?: ConnectorSendOptions,
  ): Promise<void>;
}

/**
 * Streaming configuration slot on `FeishuConnectorOptions`.
 */
export interface FeishuStreamingOptions<TName extends string = string> {
  readonly adapter?: FeishuStreamingAdapter<TName>;
  readonly preferredStrategy?: FeishuStreamingStrategy;
  readonly defaultElementId?: string;
  readonly streamingConfig?: FeishuCardStreamingConfig;
  readonly throttleIntervalMs?: number;
}

/**
 * Compute and validate the next strictly increasing positive int32 `sequence`
 * required by Feishu CardKit v1 streaming APIs (`1..2147483647`).
 *
 * @see https://open.feishu.cn/document/cardkit-v1/card-element/content
 */
export function nextCardKitSequence(currentSequence: number): number {
  if (!Number.isInteger(currentSequence) || currentSequence < 0) {
    throw new ConnectorValidationError(
      `Invalid CardKit current sequence ${currentSequence}: expected a non-negative integer.`,
    );
  }
  const next = currentSequence + 1;
  if (next < CARDKIT_MIN_SEQUENCE || next > CARDKIT_MAX_INT32_SEQUENCE) {
    throw new ConnectorValidationError(
      `CardKit sequence ${next} exceeds int32 range (${CARDKIT_MIN_SEQUENCE}..${CARDKIT_MAX_INT32_SEQUENCE}).`,
    );
  }
  return next;
}

/**
 * Build a serialized Feishu Card JSON 2.0 payload configured with `streaming_mode: true`
 * and `update_multi: true` for `POST /open-apis/cardkit/v1/cards`.
 *
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 * @see https://open.feishu.cn/document/cardkit-v1/card/create
 */
export function buildStreamingCardJsonV2(options: {
  readonly initialContent?: string;
  readonly title?: string;
  readonly elementId?: string;
  readonly streamingConfig?: FeishuCardStreamingConfig;
}): string {
  const elementId = options.elementId ?? DEFAULT_CARDKIT_STREAM_ELEMENT_ID;
  const card: Record<string, unknown> = {
    schema: FEISHU_CARD_SCHEMA_V2,
    config: {
      update_multi: true,
      streaming_mode: true,
      ...(options.streamingConfig !== undefined
        ? { streaming_config: options.streamingConfig }
        : {}),
    },
    ...(options.title !== undefined
      ? {
          header: {
            title: {
              tag: "plain_text",
              content: options.title,
            },
          },
        }
      : {}),
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: elementId,
          content: options.initialContent ?? "",
        },
      ],
    },
  };
  return JSON.stringify(card);
}

export function resolveFeishuStreamingAdapter<TName extends string>(
  streaming?: FeishuStreamingOptions<TName>,
  directAdapter?: FeishuStreamingAdapter<TName>,
): FeishuStreamingAdapter<TName> | undefined {
  return streaming?.adapter ?? directAdapter;
}
