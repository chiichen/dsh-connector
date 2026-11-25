/**
 * Outbound Feishu `ConnectorSender` implementation for non-streaming messages
 * (`POST /open-apis/im/v1/messages` and `POST /open-apis/im/v1/messages/:message_id/reply`),
 * returning rich structured `FeishuSendResult` handles ready for future in-place
 * card updates / streaming extensions.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/reply
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
 */

import type {
  ConnectorContext,
  ConnectorSender,
  ConnectorSendOptions,
  ConnectorSendResult,
} from "@dsh-connector/core";
import { DEFAULT_FEISHU_SEND_DESCRIPTION, FEISHU_CARD_SCHEMA_V2 } from "./constants";
import {
  applyOutboundContextMarker,
  feishuSendSchema,
  resolveFeishuSendTarget,
  type FeishuContextMarkerPolicy,
  type FeishuOutboundFormat,
  type FeishuReceiveIdType,
  type FeishuSendParams,
} from "./context";
import type {
  FeishuApiClient,
  FeishuOutboundMsgType,
  FeishuSendMessageApiData,
} from "./api-client";

/**
 * Structured send result returned by `FeishuConnector` outbound calls.
 * Preserves `messageId`, `chatId`, `rootId`, `parentId`, `threadId`, and `msgType`
 * so subsequent streaming/card-patch extensions can operate on the exact message handle.
 */
export interface FeishuSendResult extends ConnectorSendResult {
  readonly messageId: string;
  readonly externalId: string;
  readonly summary: string;
  readonly msgType: FeishuOutboundMsgType;
  readonly chatId?: string;
  readonly rootId?: string;
  readonly parentId?: string;
  readonly threadId?: string;
  readonly receiveId?: string;
  readonly receiveIdType?: FeishuReceiveIdType;
  readonly repliedToMessageId?: string;
  readonly raw: FeishuSendMessageApiData;
  readonly data: Record<string, unknown>;
}

export interface CreateFeishuSenderOptions<TName extends string = string> {
  readonly connectorName: TName;
  readonly apiClient: FeishuApiClient;
  readonly description?: string;
  readonly defaultOutboundFormat?: FeishuOutboundFormat;
  readonly contextMarker?: FeishuContextMarkerPolicy;
}

/**
 * Serialize plain text or Feishu Card JSON 2.0 Markdown (`update_multi: true`)
 * into `(msgType, content)` required by Feishu `im/v1/messages`.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
 */
export function buildFeishuOutboundContent(
  text: string,
  format: FeishuOutboundFormat = "text",
): { readonly msgType: FeishuOutboundMsgType; readonly content: string } {
  if (format === "markdown") {
    return {
      msgType: "interactive",
      content: JSON.stringify({
        schema: FEISHU_CARD_SCHEMA_V2,
        config: {
          update_multi: true,
        },
        body: {
          elements: [
            {
              tag: "markdown",
              content: text,
            },
          ],
        },
      }),
    };
  }

  return {
    msgType: "text",
    content: JSON.stringify({ text }),
  };
}

export function createFeishuSender<const TName extends string>(
  options: CreateFeishuSenderOptions<TName>,
): ConnectorSender<typeof feishuSendSchema, FeishuSendResult, TName> {
  const defaultFormat = options.defaultOutboundFormat ?? "text";
  const markerPolicy = options.contextMarker ?? "always";

  return {
    description: options.description ?? DEFAULT_FEISHU_SEND_DESCRIPTION,
    schema: feishuSendSchema,
    async send(
      context: ConnectorContext<TName>,
      params: FeishuSendParams,
      sendOptions?: ConnectorSendOptions,
    ): Promise<FeishuSendResult> {
      const target = resolveFeishuSendTarget(context, params);
      const format = params.format ?? defaultFormat;
      const wireText = applyOutboundContextMarker(params.text, context, markerPolicy);
      const { msgType, content } = buildFeishuOutboundContent(wireText, format);

      if (target.mode === "reply") {
        const raw = await options.apiClient.replyMessage(
          {
            messageId: target.replyToMessageId,
            msgType,
            content,
            replyInThread: target.replyInThread,
            ...(params.uuid !== undefined ? { uuid: params.uuid } : {}),
          },
          sendOptions,
        );

        const chatId = raw.chat_id ?? target.chatId;
        const data: Record<string, unknown> = {
          messageId: raw.message_id,
          msgType,
          repliedToMessageId: target.replyToMessageId,
          replyInThread: target.replyInThread,
          ...(chatId !== undefined ? { chatId } : {}),
          ...(raw.root_id !== undefined ? { rootId: raw.root_id } : {}),
          ...(raw.parent_id !== undefined ? { parentId: raw.parent_id } : {}),
          ...(raw.thread_id !== undefined ? { threadId: raw.thread_id } : {}),
        };

        return {
          messageId: raw.message_id,
          externalId: raw.message_id,
          summary: `Replied to Feishu message ${target.replyToMessageId} (messageId: ${raw.message_id})`,
          msgType,
          repliedToMessageId: target.replyToMessageId,
          ...(chatId !== undefined ? { chatId } : {}),
          ...(raw.root_id !== undefined ? { rootId: raw.root_id } : {}),
          ...(raw.parent_id !== undefined ? { parentId: raw.parent_id } : {}),
          ...(raw.thread_id !== undefined ? { threadId: raw.thread_id } : {}),
          raw,
          data,
        };
      }

      const raw = await options.apiClient.sendMessage(
        {
          receiveIdType: target.receiveIdType,
          receiveId: target.receiveId,
          msgType,
          content,
          ...(params.uuid !== undefined ? { uuid: params.uuid } : {}),
        },
        sendOptions,
      );

      const data: Record<string, unknown> = {
        messageId: raw.message_id,
        msgType,
        receiveId: target.receiveId,
        receiveIdType: target.receiveIdType,
        ...(raw.chat_id !== undefined ? { chatId: raw.chat_id } : {}),
        ...(raw.root_id !== undefined ? { rootId: raw.root_id } : {}),
        ...(raw.parent_id !== undefined ? { parentId: raw.parent_id } : {}),
        ...(raw.thread_id !== undefined ? { threadId: raw.thread_id } : {}),
      };

      return {
        messageId: raw.message_id,
        externalId: raw.message_id,
        summary: `Sent Feishu ${msgType} message to ${target.receiveIdType}:${target.receiveId} (messageId: ${raw.message_id})`,
        msgType,
        receiveId: target.receiveId,
        receiveIdType: target.receiveIdType,
        ...(raw.chat_id !== undefined ? { chatId: raw.chat_id } : {}),
        ...(raw.root_id !== undefined ? { rootId: raw.root_id } : {}),
        ...(raw.parent_id !== undefined ? { parentId: raw.parent_id } : {}),
        ...(raw.thread_id !== undefined ? { threadId: raw.thread_id } : {}),
        raw,
        data,
      };
    },
  };
}
