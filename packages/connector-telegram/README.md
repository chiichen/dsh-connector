# `@dsh-connector/connector-telegram`

Official [Telegram Bot API](https://core.telegram.org/bots/api) connector for `@dsh-connector/core`, built with zero external HTTP/SDK runtime dependencies on top of Node.js 24 native `fetch` and `node:crypto`.

## Features

- **Dual Inbound Transport (`getUpdates` & HTTPS Webhook)**:
  - [`getUpdates`](https://core.telegram.org/bots/api#getupdates) long polling with deterministic `offset` cursor persistence (`TelegramOffsetStore`), optional `dropPendingUpdatesOnStart`, and `429 retry_after` / exponential backoff recovery.
  - [`setWebhook`](https://core.telegram.org/bots/api#setwebhook) HTTPS POST handler with SHA-256 + `crypto.timingSafeEqual` constant-time verification of `X-Telegram-Bot-Api-Secret-Token`.
- **Conversation Topology & Forum Topic Routing**:
  - Private direct chats (`p2p:<chatId>` and topic-enabled private chats `p2p:<chatId>:<messageThreadId>`).
  - Group and supergroup chats (`group:<chatId>`) and Forum Topics (`group:<chatId>:<messageThreadId>`) via [`Message.message_thread_id`](https://core.telegram.org/bots/api#message).
  - Group wake-up gating (`"mention"` by default): triggers on `@botUsername` [`MessageEntity`](https://core.telegram.org/bots/api#messageentity) (`mention`, `bot_command` `/cmd@bot`, `text_mention` by `botId`), or replies to bot messages.
- **Anti-Loop & Citation Provenance**:
  - Unconditionally filters bot-authored and self-authored messages (`from.is_bot`, `botId`, `botUsername`) and channel automatic forwards.
  - Extracts [`reply_to_message`](https://core.telegram.org/bots/api#message) and partial [`TextQuote`](https://core.telegram.org/bots/api#textquote) (`quote`) provenance, plus stateless `@dsh-connector/core` context markers (`extractContextMarker` / `prependContextMarker`).
- **Safe Outbound `sendMessage` Delivery**:
  - Strict 3-tier target resolution: explicit `params.chatId` > structured `context.contextId` > `ConnectorTargetRequiredError` (never leaks pre-allocated host UUIDs as `chat_id`).
  - Paragraph/line/word-aware splitting within Telegram's [`4096`-character limit](https://core.telegram.org/bots/api#sendmessage) without severing UTF-16 surrogate pairs.
  - Preserves `message_thread_id` across all chunks and attaches [`reply_parameters`](https://core.telegram.org/bots/api#replyparameters) to the root chunk.
  - Bounded `429 Too Many Requests` retries respecting [`ResponseParameters.retry_after`](https://core.telegram.org/bots/api#responseparameters).
- **Streaming Extension Seam Reserved**:
  - Non-streaming closed loop in v0.1, with complete zero-`any` contracts and `TelegramApiClient` primitives reserved in `src/streaming.ts` for [`editMessageText`](https://core.telegram.org/bots/api#editmessagetext), [`sendChatAction`](https://core.telegram.org/bots/api#sendchataction) (`typing`), and [`sendMessageDraft`](https://core.telegram.org/bots/api#sendmessagedraft) (`MessageGenerationStopped`).

## Quick Start

### 1. Long-Polling Mode (`getUpdates`)

```ts
import { createTelegramConnector } from "@dsh-connector/connector-telegram";

const telegram = createTelegramConnector({
  name: "telegram",
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  mode: "polling",
  polling: {
    timeoutSeconds: 25,
    dropPendingUpdatesOnStart: true,
    offsetStore: {
      getOffset: () => persistedOffset,
      setOffset: (offset) => {
        persistedOffset = offset;
      },
    },
  },
});
```

### 2. HTTPS Webhook Mode (`X-Telegram-Bot-Api-Secret-Token`)

```ts
import { createTelegramConnector } from "@dsh-connector/connector-telegram";

const telegram = createTelegramConnector({
  name: "telegram",
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  botId: 123456789,
  botUsername: "my_dsh_bot",
  mode: "webhook",
  webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET!,
});
```

### 3. Outbound `sender.schema` Parameters

`telegramSendSchema` uses `text` as its required primary field and keeps all routing/formatting fields optional:

| Field                 | Type                                   | Required | Description                                                                            |
| --------------------- | -------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `text`                | `string`                               | Yes      | Message text (automatically chunked safely at `<= 4096` UTF-16 code units).            |
| `chatId`              | `number \| string`                     | No       | Target `chat_id` or `@channelusername` (falls back to structured `context.contextId`). |
| `messageThreadId`     | `number`                               | No       | Forum Topic `message_thread_id` (falls back to topic encoded in `context.contextId`).  |
| `replyToMessageId`    | `number`                               | No       | Quoted message ID sent via `reply_parameters`.                                         |
| `parseMode`           | `"MarkdownV2" \| "HTML" \| "Markdown"` | No       | Entity formatting mode.                                                                |
| `disableNotification` | `boolean`                              | No       | Silent delivery without notification sound.                                            |
| `protectContent`      | `boolean`                              | No       | Prevent forwarding/saving of the sent message.                                         |
| `disableLinkPreview`  | `boolean`                              | No       | Disable link preview generation (defaults to `true`).                                  |

## Streaming Extension Seam (`src/streaming.ts`)

Current runtime execution intentionally operates in non-streaming mode, while reserving three extension layers so future host-driven streaming requires zero breaking API changes:

1. **Structured `TelegramSendResult` Handles**: `send()` returns `{ messageId, messageIds, chatId, messageThreadId, raw, externalId, summary, data }`, retaining the exact platform handles needed for subsequent `editMessageText` calls.
2. **Typed Streaming Contracts (`TelegramStreamingAdapter`)**:
   - `"edit-message"` mode: `sendMessage` placeholder + throttled [`editMessageText`](https://core.telegram.org/bots/api#editmessagetext) updates + overflow chunking (private & group/forum chats).
   - `"message-draft"` mode: animated [`sendMessageDraft`](https://core.telegram.org/bots/api#sendmessagedraft) (`draft_id != 0`) previews in private chats + [`stopped_message_generation`](https://core.telegram.org/bots/api#messagegenerationstopped) hook + final `sendMessage`.
   - `sendTypingIndicator`: [`sendChatAction`](https://core.telegram.org/bots/api#sendchataction) (`action = "typing"`).
3. **Connector Options & Accessors**: `TelegramConnectorOptions.streaming` / `streamingAdapter` and `connector.getStreamingAdapter()` / `connector.getStreamingOptions()`.
