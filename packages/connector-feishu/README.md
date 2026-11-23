# `@dsh-connector/connector-feishu`

Feishu / Lark (`open.feishu.cn` & `open.larksuite.com`) IM connector implementing `@dsh-connector/core`'s `Connector` contract with zero third-party runtime SDK dependencies (`@dsh-connector/core` + `zod` only).

## Features

- **Outbound REST Messaging (`im/v1/messages`)**:
  - Automatic `tenant_access_token` acquisition, early refresh buffer, single-flight concurrency deduplication, and single-retry recovery on expired token error codes (`99991663` / `99991664`).
  - Supports both `POST /open-apis/im/v1/messages?receive_id_type=...` (`open_id` / `chat_id` / `user_id` / `union_id` / `email`) and `POST /open-apis/im/v1/messages/:message_id/reply` (`reply_in_thread`).
  - Plain text (`msg_type: "text"`) and Feishu Card JSON 2.0 Markdown (`msg_type: "interactive"`, `schema: "2.0"`).
- **3-Tier Outbound Target Addressing**:
  1. Explicit `params` target (`replyToMessageId`, `receiveId`, `chatId`, `openId`, `userId`, `unionId`, `email`).
  2. Structured business conversation ID parsed from `context.contextId` (`p2p:<open_id>`, `p2p:user:<user_id>`, `group:<chat_id>`, `group:<chat_id>:topic:<root_message_id>`).
  3. Throws `ConnectorTargetRequiredError` when invoked with an unbound local UUID `contextId` and no explicit recipient.
- **Inbound Event Subscription v2.0 (HTTP Webhook & WebSocket Long Connection)**:
  - HTTP Webhook (`handleWebhook`): `url_verification` challenge handshake, `Encrypt Key` AES-256-CBC (`SHA-256(encryptKey)` + 16-byte IV + PKCS#7) decryption, constant-time `X-Lark-Signature` verification, and `Verification Token` check.
  - Persistent WebSocket Long Connection (`mode: "websocket"` or `"both"`): `POST /callback/ws/endpoint` bootstrap, native Protobuf `pbbp2.Frame` binary codec, `ping`/`pong` heartbeat, `(sum, seq)` multi-fragment reassembly, and `{ code: 200 }` + `biz_rt` acknowledgement frames.
- **Conversation Hygiene & Session Routing**:
  - Filters bot/app self-messages (`sender_type === "app" | "bot"`, `botOpenId`, `appId`) to prevent echo loops.
  - Direct messages (`p2p`) respond directly; group chats (`group`) require `@Bot` mention by default (`groupMentionPolicy: "mention-required"`), stripping the bot's `@_user_N` placeholder while preserving human `@Name` mentions.
  - Correlates user quote-replies back to outbound-first sessions via `[#ctx:<contextId>]` markers (inline or via `GET /open-apis/im/v1/messages/:parent_id`).
- **Reserved Streaming Extension Seam (`src/streaming.ts`)**:
  - Current runtime implements the complete **non-streaming** receive/send closed loop.
  - Full TypeScript contracts and helper builders are reserved in `src/streaming.ts` and `FeishuConnectorOptions.streaming` / `streamingAdapter` for future **CardKit v1** streaming updates (`POST /open-apis/cardkit/v1/cards`, `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content`, `PATCH /open-apis/cardkit/v1/cards/:card_id/settings`) and message card patching (`PATCH /open-apis/im/v1/messages/:message_id`).

## Quick Start

### 1. HTTP Webhook Mode

```ts
import { createFeishuConnector } from "@dsh-connector/connector-feishu";

const feishu = createFeishuConnector({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
  domain: "feishu", // or "lark" for https://open.larksuite.com
  encryptKey: process.env.FEISHU_ENCRYPT_KEY,
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
  botOpenId: process.env.FEISHU_BOT_OPEN_ID,
});
```

### 2. Persistent WebSocket Long-Connection Mode

```ts
import { createFeishuConnector } from "@dsh-connector/connector-feishu";

const feishu = createFeishuConnector({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
  mode: "websocket",
  resolveBotInfoOnStart: true,
});

await feishu.start();
```

## Official Feishu Open Platform References

- [Custom App `tenant_access_token`](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)
- [Send Message (`POST /open-apis/im/v1/messages`)](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [Reply Message (`POST /open-apis/im/v1/messages/:message_id/reply`)](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/reply)
- [Receive Message Event v2.0 (`im.message.receive_v1`)](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [Event Encryption (`Encrypt Key` AES-256-CBC & `X-Lark-Signature`)](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case)
- [WebSocket Long Connection (`POST /callback/ws/endpoint`)](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
- [CardKit v1 Streaming Card Updates](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)
- [Patch Message Card (`PATCH /open-apis/im/v1/messages/:message_id`)](https://open.feishu.cn/document/server-docs/im-v1/message/patch)
