# `@dsh-connector/connector-wecom`

Enterprise WeChat (WeCom / 企业微信) connector for DeepSeek Harness (`dsh`), built on native Node.js 24 (`fetch`, `WebSocket`, `node:crypto`) with zero third-party transport dependencies and full alignment with the official Enterprise WeChat Developer Center specifications (`developer.work.weixin.qq.com`).

## Supported Channels & Protocol Coverage

1. **Self-Built Enterprise Application (`app` / `appchat`)**
   - Inbound HTTP callback GET `echostr` URL verification and POST encrypted XML message ingestion (`WXBizMsgCrypt`: SHA-1 `msg_signature` + AES-256-CBC with 32-byte PKCS#7 padding).
   - Outbound `GET /cgi-bin/gettoken` in-memory token caching, concurrent request coalescing, and automatic refresh retry on `40001` / `40014` / `42001`.
   - Outbound `POST /cgi-bin/message/send` (`touser` / `toparty` / `totag`) and `POST /cgi-bin/appchat/send` (`chatid`), with Unicode code-point-safe UTF-8 splitting at `2,048` bytes.
2. **Group Custom Webhook Bot (`webhook`)**
   - Outbound `POST /cgi-bin/webhook/send?key=...` supporting `text` (`2,048` UTF-8 bytes, `mentioned_list`, `mentioned_mobile_list`), `markdown` (`4,096` UTF-8 bytes), and `markdown_v2` (`4,096` UTF-8 bytes).
3. **Intelligent Bot (`智能机器人` / `aibot`)**
   - **WebSocket Long Connection (`wss://openws.work.weixin.qq.com`)**: `aibot_subscribe` handshake, `30s` `ping` heartbeat, `aibot_msg_callback` / `aibot_event_callback` ingestion, `disconnected_event` kick protection, exponential backoff reconnection, and `aibot_send_msg` / `aibot_respond_msg` outbound delivery (`20,480` UTF-8 bytes).
   - **HTTP Callback Mode**: Encrypted JSON callback ingestion (`receiveId = ""`) and single-use 1-hour `response_url` reply correlation.

## Quick Start

### 1. Self-Built Application (HTTP Callback + REST Outbound)

```ts
import { createWeComConnector } from "@dsh-connector/connector-wecom";

const wecomApp = createWeComConnector({
  name: "wecom-app",
  app: {
    corpId: process.env.WECOM_CORP_ID!,
    corpSecret: process.env.WECOM_CORP_SECRET!,
    agentId: process.env.WECOM_AGENT_ID!,
  },
  callback: {
    token: process.env.WECOM_CALLBACK_TOKEN!,
    encodingAesKey: process.env.WECOM_ENCODING_AES_KEY!,
  },
});
```

### 2. Intelligent Bot (`智能机器人`) via WebSocket Long Connection

```ts
import { createWeComConnector } from "@dsh-connector/connector-wecom";

const wecomBot = createWeComConnector({
  name: "wecom-bot",
  aibotWs: {
    botId: process.env.WECOM_AIBOT_ID!,
    secret: process.env.WECOM_AIBOT_SECRET!,
  },
  botMentionNames: ["DeepSeek助手"],
  requireMentionInGroup: true,
});
```

### 3. Group Webhook Bot

```ts
import { createConnectorContext } from "@dsh-connector/core";
import { createWeComConnector } from "@dsh-connector/connector-wecom";

const wecomWebhook = createWeComConnector({ name: "wecom-webhook" });
await wecomWebhook.getSender().send(createConnectorContext(wecomWebhook, "webhook:693a91f6-xxxx"), {
  text: "## 构建完成\n所有检查已通过",
  format: "markdown_v2",
});
```

## Target Addressing & Session Context

`WeComSender.send(context, params)` enforces strict 3-tier target resolution:

1. **Explicit target fields in `params`**: `webhookKey`, `responseUrl`, `reqId`, `chatId`, `toUser` / `toParty` / `toTag`.
2. **Structured business target in `context.contextId`**:
   - `app:p2p:<userId>` / `app:group:<chatId>`
   - `aibot:p2p:<userId>` / `aibot:group:<chatId>`
   - `webhook:<webhookKey>`
   - Generic shorthand `p2p:<userId>` / `group:<chatId>`
3. **Throws `ConnectorTargetRequiredError`** when `context.contextId` is a pre-allocated session UUID without an explicit target parameter.

## Reserved Streaming Extension Seam (`src/streaming.ts`)

Current runtime delivery implements the complete **non-streaming** send/receive closed loop. To support future host-driven streaming turns without breaking public signatures:

- **`WeComSendResult`** preserves `messageId`, `channel`, `target`, `reqId`, `streamId`, `responseCode`, `chunkCount`, and `raw` provider responses.
- **`src/streaming.ts`** exports strongly-typed zero-`any` contracts and frame builders (`WeComStreamingAdapter`, `WeComStreamTarget`, `WeComStreamHandle`, `WeComPassiveStreamReplyPayload`, `WeComStreamRefreshCallbackPayload`, `WeComWsStreamRespondFrame`, `buildPassiveStreamReplyPayload`, `buildWsStreamRespondFrame`) covering both Intelligent Bot HTTP passive stream polling (`msgtype: "stream"` within the 6-minute window) and WebSocket active stream updates (`aibot_respond_msg` within the 10-minute window).
- **`WeComConnectorOptions.streaming` / `streamingAdapter`** and **`connector.getStreamingAdapter()`** expose the adapter slot ready for future host `ConnectorReplyHandler` integration.

## Official Enterprise WeChat Documentation References

- [Callback Configuration & URL Verification (`echostr`)](https://developer.work.weixin.qq.com/document/path/90930)
- [Message Encryption & Decryption Specification (`WXBizMsgCrypt`)](https://developer.work.weixin.qq.com/document/path/91144)
- [Access Token Acquisition (`cgi-bin/gettoken`)](https://developer.work.weixin.qq.com/document/path/91039)
- [Self-Built App Message Sending (`cgi-bin/message/send`)](https://developer.work.weixin.qq.com/document/path/96458)
- [App Group Chat Message Sending (`cgi-bin/appchat/send`)](https://developer.work.weixin.qq.com/document/path/90248)
- [Group Webhook Bot Configuration (`cgi-bin/webhook/send`)](https://developer.work.weixin.qq.com/document/path/99110)
- [Intelligent Bot HTTP Callback Format](https://developer.work.weixin.qq.com/document/path/100719)
- [Intelligent Bot Passive Stream Reply (`msgtype: "stream"`)](https://developer.work.weixin.qq.com/document/path/101031)
- [Intelligent Bot Active Reply (`response_url`)](https://developer.work.weixin.qq.com/document/path/101138)
- [Intelligent Bot WebSocket Long Connection](https://developer.work.weixin.qq.com/document/path/101463)
