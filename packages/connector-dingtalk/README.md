# `@dsh-connector/connector-dingtalk`

DingTalk (钉钉) robot connector for `@dsh-connector/core` and `dsh-connector-plugin`, implemented strictly against the official DingTalk Open Platform v1.0 specifications using Node.js 24 native `fetch`, `WebSocket`, and `node:crypto` (zero external runtime SDK dependencies).

## Capabilities

- **OAuth2 Access Token Management**: Acquires and caches internal app `accessToken` via `POST https://api.dingtalk.com/v1.0/oauth2/accessToken` with concurrent request deduplication, proactive pre-expiry refresh, and automatic one-time invalidation/retry on `HTTP 401`.
- **Stream Mode Long Connection (Recommended)**: Registers one-time connection tickets via `POST https://api.dingtalk.com/v1.0/gateway/connections/open`, connects over `WebSocket` (`GET /connect?ticket=...`), responds to `SYSTEM` `ping` frames (echoing `opaque`), handles `SYSTEM` `disconnect` rebalancing without spurious ACKs, acknowledges `/v1.0/im/bot/messages/get` `CALLBACK` and `EVENT` frames, and reconnects with exponential backoff.
- **HTTP Outgoing Robot Webhook**: Verifies `timestamp` (`<= 1h` clock skew) + `sign` (`Base64(HMAC-SHA256(secret, timestamp + "\n" + secret))`) using constant-time comparison, and also supports Custom Robot Outgoing `token` header verification.
- **Non-Streaming Outbound Delivery**:
  - Proactive 1:1 robot messages via `POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend` (`sampleText` / `sampleMarkdown`, up to 20 `userIds`).
  - Proactive group robot messages via `POST https://api.dingtalk.com/v1.0/robot/groupMessages/send` (`sampleText` / `sampleMarkdown`, optional `coolAppCode`).
  - Direct session replies via validated HTTPS `*.dingtalk.com` `sessionWebhook` URLs (explicit or cached from recent inbound messages, supporting `@` mentions).
- **Loop Prevention & Context Binding**: Filters bot self-messages (`senderId === chatbotUserId`, `botUserIds`, `botStaffIds`), extracts quoted/inline context markers (`prependContextMarker` / `extractContextMarker`), and binds conversations to stable `p2p:<staffId>`, `p2p-id:<senderId>`, or `group:<openConversationId>` context IDs.
- **Reserved Streaming Extension Seam (`src/streaming.ts`)**: Provides zero-`any` TypeScript contracts, `openSpaceId` helpers, and connector extension slots (`streaming` / `streamingAdapter` / `getStreamingAdapter()`) for DingTalk AI Card & Interactive Card typewriter streaming (`POST /v1.0/card/instances`, `POST /v1.0/card/instances/createAndDeliver`, `PUT /v1.0/card/streaming`, `PUT /v1.0/card/instances`). Streaming execution logic is intentionally not enabled in this phase.

## Quick Start

### 1. Stream Mode + OpenAPI v1.0

```ts
import { createDingTalkConnector } from "@dsh-connector/connector-dingtalk";
import { createConnectorContext } from "@dsh-connector/core";

const dingtalk = createDingTalkConnector({
  name: "dingtalk",
  clientId: process.env.DINGTALK_CLIENT_ID,
  clientSecret: process.env.DINGTALK_CLIENT_SECRET,
  inboundMode: "stream",
});

// Outbound send via structured contextId or explicit target fields
const sender = dingtalk.getSender();
await sender.send(createConnectorContext(dingtalk, "p2p:manager1234"), {
  text: "### Deployment Ready\nAll checks passed.",
  format: "markdown",
  title: "Deployment Ready",
});
```

### 2. HTTP Outgoing Webhook Mode

```ts
import { createDingTalkConnector } from "@dsh-connector/connector-dingtalk";

const dingtalkWebhook = createDingTalkConnector({
  name: "dingtalk-webhook",
  webhookSigningSecret: process.env.DINGTALK_APP_SECRET,
  inboundMode: "webhook",
});
```

## Target Resolution Priority

`DingTalkSender.send(context, params)` resolves the target in strict 3-tier order:

1. **Explicit `params` target**: `params.sessionWebhook`, `params.openConversationId`, or `params.userId` / `params.userIds` (conflicting explicit targets throw `ConnectorValidationError`).
2. **Structured `context.contextId`**:
   - `p2p:<staffId>` -> `POST /v1.0/robot/oToMessages/batchSend` (or cached unexpired `sessionWebhook` when `preferSessionWebhook: true` or in webhook-only mode).
   - `group:<openConversationId>` -> `POST /v1.0/robot/groupMessages/send` (or cached unexpired `sessionWebhook` when `preferSessionWebhook: true` or in webhook-only mode).
   - `p2p-id:<encryptedSenderId>` -> cached unexpired `sessionWebhook`.
3. **Unresolved (e.g. pre-allocated UUID `contextId`)**: throws `ConnectorTargetRequiredError` from `@dsh-connector/core`.

## Reserved AI Card Streaming Extension Seam

`src/streaming.ts` exports complete contracts for plugging in DingTalk AI Card streaming in future iterations without breaking `DingTalkConnectorOptions`:

- `DingTalkStreamingAdapter` (`startStream` / `updateStream` / `completeStream` / `abortStream` / `sendThinkingReaction`)
- `DingTalkStreamingOptions`, `DingTalkStreamTarget`, `DingTalkStreamHandle`
- `DingTalkCreateCardInstanceRequest`, `DingTalkCardStreamingUpdateRequest`, `DingTalkUpdateCardInstanceRequest`
- `formatDingTalkCardOpenSpaceId(target)` (`dtv1.card//IM_GROUP.<openConversationId>` / `dtv1.card//IM_ROBOT.<userId>`)

## Official DingTalk Documentation References

- [Obtain Internal App Access Token (`POST /v1.0/oauth2/accessToken`)](https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app.md)
- [Stream Mode Protocol Access Description (`POST /v1.0/gateway/connections/open`)](https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description)
- [Robot Receive Message & Outgoing Signature Verification](https://open.dingtalk.com/document/orgapp/receive-message.md)
- [Batch Send One-on-One Robot Messages (`POST /v1.0/robot/oToMessages/batchSend`)](https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches.md)
- [Robot Send Group Message (`POST /v1.0/robot/groupMessages/send`)](https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message.md)
- [Create & Deliver Card Instances (`POST /v1.0/card/instances/createAndDeliver`)](https://open.dingtalk.com/document/development/create-and-deliver-cards.md)
- [AI Card Streaming Update (`PUT /v1.0/card/streaming`)](https://open.dingtalk.com/document/development/api-streamingupdate.md)
