import {
  ConnectorValidationError,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorSender,
  type ConnectorSendOptions,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import { z } from "zod";
import type { TelegramApiClient } from "./api-client";
import { splitTelegramMessageText } from "./chunking";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "./constants";
import { resolveTelegramSendTarget } from "./context-target";
import {
  telegramSendSchema,
  type TelegramMessage,
  type TelegramSendParams,
  type TelegramSendResult,
} from "./types";

export interface TelegramSenderOptions<TName extends string = "telegram"> {
  readonly connectorName: TName;
  readonly apiClient: TelegramApiClient;
  readonly description?: string;
  readonly includeContextMarker?: boolean;
  readonly contextMarkerStyle?: ContextMarkerStyle;
  readonly maxMessageLength?: number;
}

/**
 * Outbound `ConnectorSender` for Telegram Bot API (`sendMessage`).
 * Resolves destination via 3-tier priority (`params.chatId` > structured `context.contextId` >
 * `ConnectorTargetRequiredError`), optionally prepends a stateless context marker, and safely
 * chunks messages exceeding 4096 characters while preserving `message_thread_id` and message handles.
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 * @see https://core.telegram.org/bots/api#replyparameters
 */
export class TelegramSender<TName extends string = "telegram"> implements ConnectorSender<
  typeof telegramSendSchema,
  TelegramSendResult,
  TName
> {
  readonly schema = telegramSendSchema;
  readonly description: string;

  private readonly connectorName: TName;
  private readonly apiClient: TelegramApiClient;
  private readonly includeContextMarker: boolean;
  private readonly contextMarkerStyle: ContextMarkerStyle;
  private readonly maxMessageLength: number;

  constructor(options: TelegramSenderOptions<TName>) {
    this.connectorName = options.connectorName;
    this.apiClient = options.apiClient;
    this.description =
      options.description ??
      "Send a text message to a Telegram private chat, group, or Forum Topic via Telegram Bot API.";
    this.includeContextMarker = options.includeContextMarker ?? false;
    this.contextMarkerStyle = options.contextMarkerStyle ?? "html-comment";
    this.maxMessageLength = options.maxMessageLength ?? TELEGRAM_MAX_MESSAGE_LENGTH;
  }

  async send(
    context: ConnectorContext<TName>,
    params: TelegramSendParams,
    options?: ConnectorSendOptions,
  ): Promise<TelegramSendResult> {
    const parsed = telegramSendSchema.safeParse(params);
    if (!parsed.success) {
      throw new ConnectorValidationError(
        `Invalid Telegram send parameters: ${z.prettifyError(parsed.error)}`,
        { connectorName: this.connectorName },
      );
    }

    const validParams = parsed.data;
    const target = resolveTelegramSendTarget(context, {
      chatId: validParams.chatId,
      messageThreadId: validParams.messageThreadId,
    });

    const decoratedText = this.includeContextMarker
      ? prependContextMarker(validParams.text, context.contextId, this.contextMarkerStyle)
      : validParams.text;

    const chunks = splitTelegramMessageText(
      decoratedText,
      this.maxMessageLength,
      this.connectorName,
    );

    const sentMessages: TelegramMessage[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkText = chunks[index]!;
      const sent = await this.apiClient.sendMessage(
        {
          chatId: target.chatId,
          text: chunkText,
          ...(target.messageThreadId !== undefined
            ? { messageThreadId: target.messageThreadId }
            : {}),
          ...(index === 0 && validParams.replyToMessageId !== undefined
            ? { replyToMessageId: validParams.replyToMessageId }
            : {}),
          ...(validParams.parseMode !== undefined ? { parseMode: validParams.parseMode } : {}),
          ...(validParams.disableNotification !== undefined
            ? { disableNotification: validParams.disableNotification }
            : {}),
          ...(validParams.protectContent !== undefined
            ? { protectContent: validParams.protectContent }
            : {}),
          ...(validParams.disableLinkPreview !== undefined
            ? { disableLinkPreview: validParams.disableLinkPreview }
            : {}),
        },
        options,
      );
      sentMessages.push(sent);
    }

    const primaryMessage = sentMessages[0]!;
    const messageIds = sentMessages.map((msg) => msg.message_id);
    const resolvedThreadId = target.messageThreadId ?? primaryMessage.message_thread_id;

    return {
      externalId: String(primaryMessage.message_id),
      messageId: primaryMessage.message_id,
      messageIds,
      chatId: target.chatId,
      ...(resolvedThreadId !== undefined ? { messageThreadId: resolvedThreadId } : {}),
      raw: sentMessages,
      summary:
        sentMessages.length === 1
          ? `Sent Telegram message ${primaryMessage.message_id} to chat ${String(target.chatId)}.`
          : `Sent Telegram message in ${sentMessages.length} chunks (${messageIds.join(", ")}) to chat ${String(target.chatId)}.`,
      data: {
        chatId: target.chatId,
        messageId: primaryMessage.message_id,
        messageIds,
        chunkCount: sentMessages.length,
        ...(resolvedThreadId !== undefined ? { messageThreadId: resolvedThreadId } : {}),
      },
    };
  }
}
