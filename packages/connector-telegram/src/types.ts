import type { ConnectorLogger, ConnectorSendResult, ContextMarkerStyle } from "@dsh-connector/core";
import { z } from "zod";
import type { TelegramStreamingAdapter, TelegramStreamingOptions } from "./streaming";

/**
 * Telegram entity formatting modes supported by `sendMessage`, `editMessageText`, and `sendMessageDraft`.
 *
 * @see https://core.telegram.org/bots/api#formatting-options
 */
export type TelegramParseMode = "MarkdownV2" | "HTML" | "Markdown";

/**
 * Telegram `Chat.type` enumeration.
 *
 * @see https://core.telegram.org/bots/api#chat
 */
export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

/**
 * Telegram `User` object subset used by `@dsh-connector/connector-telegram`.
 *
 * @see https://core.telegram.org/bots/api#user
 */
export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
}

/**
 * Telegram `Chat` object subset.
 *
 * @see https://core.telegram.org/bots/api#chat
 */
export interface TelegramChat {
  readonly id: number;
  readonly type: TelegramChatType;
  readonly title?: string;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly is_forum?: boolean;
}

/**
 * Telegram `MessageEntity` object (`offset` and `length` are UTF-16 code units).
 *
 * @see https://core.telegram.org/bots/api#messageentity
 */
export interface TelegramMessageEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
  readonly url?: string;
  readonly user?: TelegramUser;
  readonly language?: string;
  readonly custom_emoji_id?: string;
}

/**
 * Telegram `TextQuote` object describing a quoted substring of `reply_to_message`.
 *
 * @see https://core.telegram.org/bots/api#textquote
 */
export interface TelegramTextQuote {
  readonly text: string;
  readonly entities?: readonly TelegramMessageEntity[];
  readonly position: number;
  readonly is_manual?: boolean;
}

/**
 * Telegram `Message` object subset for inbound routing, Forum Topic threading, and reply provenance.
 *
 * @see https://core.telegram.org/bots/api#message
 */
export interface TelegramMessage {
  readonly message_id: number;
  readonly message_thread_id?: number;
  readonly from?: TelegramUser;
  readonly sender_chat?: TelegramChat;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly is_topic_message?: boolean;
  readonly is_automatic_forward?: boolean;
  readonly reply_to_message?: TelegramMessage;
  readonly quote?: TelegramTextQuote;
  readonly text?: string;
  readonly entities?: readonly TelegramMessageEntity[];
  readonly caption?: string;
  readonly caption_entities?: readonly TelegramMessageEntity[];
}

/**
 * Telegram `MessageGenerationStopped` update payload emitted when a user taps Stop on `sendMessageDraft`.
 *
 * @see https://core.telegram.org/bots/api#messagegenerationstopped
 */
export interface TelegramRawMessageGenerationStopped {
  readonly chat: TelegramChat;
  readonly message_thread_id?: number;
  readonly draft_id: number;
}

/**
 * Telegram `Update` envelope delivered via `getUpdates` long polling or HTTPS Webhook POST.
 *
 * @see https://core.telegram.org/bots/api#update
 */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly channel_post?: TelegramMessage;
  readonly edited_channel_post?: TelegramMessage;
  readonly stopped_message_generation?: TelegramRawMessageGenerationStopped;
}

/**
 * Telegram `ResponseParameters` returned when `ok: false` (e.g., `retry_after` on HTTP 429).
 *
 * @see https://core.telegram.org/bots/api#responseparameters
 */
export interface TelegramResponseParameters {
  readonly migrate_to_chat_id?: number;
  readonly retry_after?: number;
}

/**
 * Standard JSON envelope returned by all Telegram Bot API HTTPS requests.
 *
 * @see https://core.telegram.org/bots/api#making-requests
 */
export interface TelegramApiEnvelope<TResult> {
  readonly ok: boolean;
  readonly result?: TResult;
  readonly error_code?: number;
  readonly description?: string;
  readonly parameters?: TelegramResponseParameters;
}

/**
 * Resolved identity of the authenticated Telegram bot (`getMe`).
 *
 * @see https://core.telegram.org/bots/api#getme
 */
export interface TelegramBotIdentity {
  readonly id: number;
  readonly username?: string;
  readonly firstName?: string;
}

/**
 * Outbound sender schema for `@dsh-connector/connector-telegram`.
 * Root is `z.object({ text: z.string().min(1), ... })` with all target/option fields optional
 * for seamless compatibility with DSH host event-driven and tool-driven outbound delivery.
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 * @see https://core.telegram.org/bots/api#replyparameters
 */
export const telegramSendSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "Text message to send via Telegram Bot API (automatically split safely into <=4096-character chunks).",
    ),
  chatId: z
    .union([z.number().int(), z.string().min(1)])
    .optional()
    .describe(
      "Target Telegram chat_id (numeric ID or @channelusername). Optional when replying within a bound Telegram conversation context.",
    ),
  messageThreadId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional Forum Topic message_thread_id for forum supergroups or topic-enabled private chats.",
    ),
  replyToMessageId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional Telegram message_id to quote/reply to via reply_parameters."),
  parseMode: z
    .enum(["MarkdownV2", "HTML", "Markdown"])
    .optional()
    .describe("Optional Telegram entity parse_mode."),
  disableNotification: z
    .boolean()
    .optional()
    .describe("Send the message silently without notification sound."),
  protectContent: z
    .boolean()
    .optional()
    .describe("Protect the sent message from forwarding and saving."),
  disableLinkPreview: z
    .boolean()
    .optional()
    .describe("Disable URL link preview generation (defaults to true)."),
});

export type TelegramSendParams = z.output<typeof telegramSendSchema>;

/**
 * Normalized inbound event schema delivered to `onReceive` and `formatInbound`.
 *
 * @see https://core.telegram.org/bots/api#update
 * @see https://core.telegram.org/bots/api#message
 */
export const telegramReceiveSchema = z.object({
  updateId: z.number().int(),
  messageId: z.number().int(),
  chatId: z.number().int(),
  chatType: z.enum(["private", "group", "supergroup", "channel"]),
  chatTitle: z.string().optional(),
  messageThreadId: z.number().int().positive().optional(),
  isTopicMessage: z.boolean().optional(),
  from: z.object({
    id: z.number().int(),
    isBot: z.boolean(),
    firstName: z.string(),
    lastName: z.string().optional(),
    username: z.string().optional(),
  }),
  text: z.string(),
  rawText: z.string(),
  date: z.number().int(),
  mentionedBot: z.boolean(),
  replyToMessage: z
    .object({
      messageId: z.number().int(),
      fromId: z.number().int().optional(),
      fromUsername: z.string().optional(),
      fromName: z.string().optional(),
      isFromBot: z.boolean(),
      text: z.string().optional(),
      quote: z.string().optional(),
      date: z.number().int().optional(),
    })
    .optional(),
});

export type TelegramReceivePayload = z.output<typeof telegramReceiveSchema>;

/**
 * Structured `ConnectorSendResult` returned by `TelegramSender.send()`.
 * Preserves `messageId`, `messageIds`, `chatId`, `messageThreadId`, and `raw` Telegram `Message`
 * handles required for subsequent in-place `editMessageText` or thread follow-ups.
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 * @see https://core.telegram.org/bots/api#editmessagetext
 */
export interface TelegramSendResult extends ConnectorSendResult {
  readonly externalId: string;
  readonly messageId: number;
  readonly messageIds: readonly number[];
  readonly chatId: number | string;
  readonly messageThreadId?: number;
  readonly raw: readonly TelegramMessage[];
  readonly summary: string;
  readonly data: {
    readonly chatId: number | string;
    readonly messageId: number;
    readonly messageIds: readonly number[];
    readonly chunkCount: number;
    readonly messageThreadId?: number;
  };
}

/**
 * Cursor persistence contract for `getUpdates` `offset` management across restarts.
 *
 * @see https://core.telegram.org/bots/api#getupdates
 */
export interface TelegramOffsetStore {
  getOffset(): Promise<number | undefined> | number | undefined;
  setOffset(offset: number): Promise<void> | void;
}

/**
 * Group chat wake-up policy:
 * - `"mention"` (default): wake only on `@botUsername`, `text_mention`, `/cmd@botUsername`, or reply to a bot message
 * - `"all"`: wake on every non-bot text/caption message in the group
 * - `"off"`: ignore group and supergroup messages
 */
export type TelegramGroupTriggerMode = "mention" | "all" | "off";

/**
 * Inbound transport mode for `TelegramConnector`.
 * Note that Telegram Bot API forbids calling `getUpdates` while an outgoing webhook is active.
 *
 * @see https://core.telegram.org/bots/api#getting-updates
 */
export type TelegramTransportMode = "polling" | "webhook" | "passive";

/**
 * Long-polling configuration for Telegram `getUpdates`.
 *
 * @see https://core.telegram.org/bots/api#getupdates
 */
export interface TelegramPollingOptions {
  readonly timeoutSeconds?: number;
  readonly limit?: number;
  readonly allowedUpdates?: readonly string[];
  readonly initialOffset?: number;
  readonly dropPendingUpdatesOnStart?: boolean;
  readonly offsetStore?: TelegramOffsetStore;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly onUpdateError?: "retry" | "skip";
}

/**
 * Injectable delay function signature for deterministic testing of rate-limit & polling backoff.
 */
export type TelegramSleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Configuration options for `TelegramConnector` / `createTelegramConnector`.
 *
 * @see https://core.telegram.org/bots/api
 */
export interface TelegramConnectorOptions<TName extends string = "telegram"> {
  readonly name?: TName;
  readonly displayName?: string;
  readonly description?: string;
  readonly botToken: string;
  readonly logger?: ConnectorLogger;
  readonly apiBaseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly sleepFn?: TelegramSleepFn;
  readonly requestTimeoutMs?: number;
  readonly maxSendRetries?: number;
  readonly maxRetryAfterMs?: number;

  /**
   * Optional known bot identity (`id` and/or `username` without `@`).
   * When omitted in `"polling"` mode, `start()` automatically queries `getMe` to populate it.
   *
   * @see https://core.telegram.org/bots/api#getme
   */
  readonly botId?: number;
  readonly botUsername?: string;

  /**
   * Transport mode (`"polling"` | `"webhook"` | `"passive"`).
   * Defaults to `"webhook"` when `webhookSecretToken` is set (and `polling` is not),
   * otherwise defaults to `"polling"`.
   *
   * @see https://core.telegram.org/bots/api#getting-updates
   */
  readonly mode?: TelegramTransportMode;
  readonly polling?: TelegramPollingOptions;

  /**
   * Secret token verified in constant time against HTTP header `X-Telegram-Bot-Api-Secret-Token`.
   *
   * @see https://core.telegram.org/bots/api#setwebhook
   */
  readonly webhookSecretToken?: string;
  /**
   * Whether `handleWebhook` requires `webhookSecretToken` authentication (defaults to `true`).
   * Set `false` only in trusted local/reverse-proxy environments without a secret token.
   */
  readonly requireWebhookSecretToken?: boolean;

  /**
   * Group wake-up rule (defaults to `"mention"`).
   */
  readonly groupTriggerMode?: TelegramGroupTriggerMode;
  readonly allowedChatIds?: ReadonlyArray<number | string>;
  readonly allowedUserIds?: ReadonlyArray<number | string>;
  readonly acceptEditedMessages?: boolean;
  readonly inboundDeliveryMode?: "queue" | "steer";

  /**
   * Optional outbound context marker embedding (defaults to `false` so human IM chats stay clean;
   * inbound `extractContextMarker` is always active for reply provenance).
   */
  readonly includeContextMarker?: boolean;
  readonly contextMarkerStyle?: ContextMarkerStyle;
  readonly maxMessageLength?: number;

  /**
   * Reserved streaming extension configuration & adapter slot (no runtime streaming executed in v0.1).
   *
   * @see https://core.telegram.org/bots/api#editmessagetext
   * @see https://core.telegram.org/bots/api#sendchataction
   * @see https://core.telegram.org/bots/api#sendmessagedraft
   */
  readonly streaming?: TelegramStreamingOptions;
  readonly streamingAdapter?: TelegramStreamingAdapter;
}
