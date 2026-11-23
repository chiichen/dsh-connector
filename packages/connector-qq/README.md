# `@dsh-connector/connector-qq`

Official **QQ Bot Open Platform (QQ 机器人开放平台)** bidirectional connector for [`dsh-connector`](https://github.com/chiichen/dsh-connector), built with zero external SDK runtime dependencies on top of Node.js 24 native `fetch`, `WebSocket`, and `node:crypto` (Ed25519).

## Official Documentation Ground Truth

- Access Token & Auth Header (`Authorization: QQBot <access_token>`): [获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html) · [接口调用与鉴权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)
- WebSocket Gateway (`GET /gateway`, `OpCode 10/2/1/11/6/7/9`): [WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) · [OpCode 列表](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/opcode.html)
- HTTP Webhook (`OpCode 13` Challenge & Ed25519 Signature Verification): [Webhook 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html) · [安全和授权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)
- Inbound Message Events:
  - `C2C_MESSAGE_CREATE`: [单聊消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)
  - `GROUP_AT_MESSAGE_CREATE`: [群@机器人消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
  - `AT_MESSAGE_CREATE`: [频道消息事件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/event.html)
- Outbound Message APIs & Passive `msg_id` + `msg_seq` Rules:
  - C2C (`/v2/users/{user_openid}/messages`): [发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
  - Group (`/v2/groups/{group_openid}/messages`): [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
  - Channel (`/channels/{channel_id}/messages`): [发送子频道消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/send.html)
  - Overview & Passive Limits: [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- Streaming & Rich Media Extension Specifications:
  - C2C Streaming (`/v2/users/{user_openid}/stream_messages`): [流式发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
  - Rich Media (`msg_type=7`, `file_info`): [富媒体消息概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)

## Features

- **Dynamic Token Lifecycle (`QqAccessTokenManager`)**: Fetches `access_token` via `POST https://bots.qq.com/app/getAppAccessToken` (or unified 2026 `QQ_UNIFIED_TOKEN_URL` `https://api.bot.qq.com/app/getAppAccessToken`), deduplicates concurrent refreshes, refreshes 60 seconds prior to expiry, classifies HTTP-200 business error codes (`10004` / `100007` / `100016` vs `100001`), and retries once on OpenAPI `401`.
- **Dual Inbound Modes (`transport: "webhook" | "websocket" | "both"`)**:
  - **HTTP Webhook**: Verifies `X-Signature-Ed25519` + `X-Signature-Timestamp` over raw request bytes using the 32-byte seed repeated from `clientSecret`, answers `OpCode 13` callback URL verification, and returns `OpCode 12` (`{"op":12,"d":0}`) HTTP Callback ACK.
  - **WebSocket Gateway**: Discovers WSS gateway via `GET /gateway`, authenticates with `OpCode 2 Identify`, maintains `OpCode 1 / 11` heartbeats with zombie-connection detection, resumes with `OpCode 6 Resume` (`session_id` + `seq`), falls back to `Identify` on `OpCode 9 Invalid Session`, and halts cleanly on fatal close codes (`4914`, `4915`, `4014`).
- **3-Tier Target Addressing & Anti-Loop**:
  1. Explicit `params` target (`openId`, `groupOpenId`, or `channelId`)
  2. Structured business `context.contextId` (`c2c:<openId>`, `group:<groupOpenId>`, `channel:<guildId>:<channelId>`)
  3. Throws `ConnectorTargetRequiredError` when `context.contextId` is a pure outbound-allocated UUID
  - Automatically ignores self-bot messages (`author.bot === true` or known bot IDs), strips `<@!botId>` mentions, extracts quoted `[#ctx:...]` / `<!-- dsh-ctx:... -->` markers, and tracks passive `msg_id` + monotonic `msg_seq` per conversation.
- **Streaming Extension Seam (`src/streaming.ts`)**: Currently implements the non-streaming request/reply loop while reserving complete zero-`any` interfaces (`QqStreamingAdapter`, `QqStreamingOptions`, `QqStreamHandle`, `QqC2cStreamMessageRequest`, `QqPassiveContinuationState`, `QqRichMediaPayload`, `QqMarkdownPayload`) and `connector.getStreamingAdapter()` for future C2C `stream_messages` and multi-segment passive `msg_seq` updates.

## Quick Start

```ts
import {
  createQqConnector,
  QQ_UNIFIED_API_BASE_URL,
  QQ_UNIFIED_TOKEN_URL,
} from "@dsh-connector/connector-qq";

// HTTP Webhook mode (default)
const qqWebhook = createQqConnector({
  appId: process.env.QQ_APP_ID!,
  clientSecret: process.env.QQ_CLIENT_SECRET!,
  transport: "webhook",
});

// WebSocket Gateway mode (with optional 2026 unified domain override)
const qqGateway = createQqConnector({
  name: "qq-bot",
  appId: process.env.QQ_APP_ID!,
  clientSecret: process.env.QQ_CLIENT_SECRET!,
  transport: "websocket",
  apiBaseUrl: QQ_UNIFIED_API_BASE_URL,
  tokenUrl: QQ_UNIFIED_TOKEN_URL,
});
```
