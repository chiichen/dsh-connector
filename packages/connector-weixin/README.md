# `@dsh-connector/connector-weixin`

WeChat (`微信`) bidirectional connector for [`dsh-connector`](../../README.md), built on Node.js 24 native `fetch` and `node:crypto` with zero external runtime SDK dependencies.

## Features

- **Dual-Mode Official & Bot Protocol Support**:
  - **`"official-account"` mode (default)**: Standard WeChat Official Account / Service Account / Customer Service HTTP callback (`GET` SHA-1 `echostr` verification, `POST` Plaintext / Compatible / Safe `WXBizMsgCrypt` AES-256-CBC decryption for XML & JSON payloads) paired with `POST /cgi-bin/stable_token` (or `GET /cgi-bin/token`) `access_token` lifecycle management and `POST /cgi-bin/message/custom/send` outbound delivery.
  - **`"ilink"` mode**: WeChat iLink Bot HTTPS long-polling (`ilink/bot/getupdates` + `ilink/bot/sendmessage`), compatible with `xmanrui/dsh-im` Weixin channel deployments, including deterministic `seq` / `create_time_ms` batch ordering and per-user `context_token` caching.
- **3-Tier Outbound Target Addressing**:
  1. Explicit `params.openId` / `params.toUserId`
  2. Structured `p2p:<userId>` parsed from `context.contextId`
  3. Throws `ConnectorTargetRequiredError` (never mistakes pre-allocated UUID `contextId` values for real WeChat OpenIDs)
- **Reliability & Loop Prevention**:
  - Deterministic bounded deduplication by `MsgId` / `message_id` and `idempotencyKey` forwarding to `ConnectorManager`
  - Self-message / bot-echo filtering (`accountId`, `FromUserName === ToUserName`, iLink `message_type === 2`, and tracked outbound message IDs)
  - Optional context marker embedding and extraction (`prependContextMarker` / `extractContextMarker`)
  - Safe outbound text splitting (`splitWeixinText`) enforcing both character (`1800`) and UTF-8 byte (`2000`, below WeChat's 2048-byte `errcode=45002` limit) budgets without corrupting surrogate pairs or fenced Markdown code blocks
- **Reserved Streaming & Typing Extension Seam (`src/streaming.ts`)**:
  - Exports zero-`any` `WeixinStreamingAdapter`, `WeixinStreamingOptions`, `WeixinStreamTarget`, `WeixinStreamHandle`, `WeixinTypingCommand`, and `WeixinCustomTypingPayload` for future `POST /cgi-bin/message/custom/typing` and segmented reply streaming without breaking public APIs.

## Official WeChat Documentation References

- [Server Callback Configuration & `echostr` Verification](https://developers.weixin.qq.com/doc/service/guide/dev/push/)
- [Message Encryption & Decryption (`WXBizMsgCrypt` AES-256-CBC)](https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html)
- [Receiving Standard Messages (`text` / `voice` XML & JSON)](https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.html)
- [Stable Access Token (`POST /cgi-bin/stable_token`)](https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html)
- [Classic Access Token (`GET /cgi-bin/token`)](https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken.html)
- [Send Customer Service Message (`POST /cgi-bin/message/custom/send`)](https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html)
- [Customer Service Typing Indicator (`POST /cgi-bin/message/custom/typing`)](https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_typing.html)
- [Global Error Codes](https://developers.weixin.qq.com/doc/oplatform/developers/errCode/)

## Quick Start

### 1. Official Account / Service Account Mode (Webhook + `message/custom/send`)

```ts
import { createWeixinConnector } from "@dsh-connector/connector-weixin";

const weixin = createWeixinConnector({
  name: "weixin",
  mode: "official-account",
  appId: process.env.WEIXIN_APP_ID!,
  appSecret: process.env.WEIXIN_APP_SECRET!,
  token: process.env.WEIXIN_CALLBACK_TOKEN!,
  encodingAesKey: process.env.WEIXIN_ENCODING_AES_KEY, // Optional 43-char AES key for Safe/Compatible mode
  accountId: process.env.WEIXIN_ORIGINAL_ID, // Optional `gh_xxx` for self-echo filtering
});
```

Mount with `dsh-connector-plugin` to expose `/webhooks/weixin` for WeChat `GET` (`echostr`) and `POST` callbacks, and register the `connector_send_weixin` tool (`{ text, openId?, kfAccount? }`).

### 2. iLink Bot Mode (HTTPS Long-Polling)

```ts
import { createWeixinConnector } from "@dsh-connector/connector-weixin";

const weixinBot = createWeixinConnector({
  name: "weixin",
  mode: "ilink",
  botToken: process.env.WEIXIN_ILINK_BOT_TOKEN!,
  initialUpdatesBuf: "",
  onUpdatesBufChange: async (cursor) => {
    // Optionally persist cursor across restarts
  },
});
```

### 3. Streaming & Typing Extension Seam (Reserved)

Streaming output is intentionally not executed in this phase, while three extension layers are ready for future host-driven reply streaming:

1. **Structured `WeixinSendResult`**: `sender.send()` returns `{ messageId, messageIds, openId, chunkCount, mode, contextToken, raw }`.
2. **Typed Adapter Contract (`src/streaming.ts`)**: `WeixinStreamingAdapter` (`sendTypingIndicator`, `startStream`, `updateStream`, `completeStream`, `abortStream`) aligned with WeChat `message/custom/typing` (`Typing` / `CancelTyping`) and `message/custom/send` (`aimsgcontext`).
3. **Connector Slot**: Pass `streamingAdapter` (or `streaming.adapter`) in `WeixinConnectorOptions` and inspect via `connector.getStreamingAdapter()`.
