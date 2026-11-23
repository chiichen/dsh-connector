# `@dsh-connector/connector-slack`

Slack bidirectional connector for `dsh-connector`, built strictly against the official Slack Platform documentation with **zero external runtime dependencies** beyond `@dsh-connector/core` and `zod` (powered by Node.js 24 native `fetch`, `WebSocket`, and `node:crypto`).

## Features

- **Events API HTTP Webhook Receiver (`handleWebhook`)**
  - Verifies `X-Slack-Signature` (`v0=<hex>`) HMAC-SHA256 signatures and `X-Slack-Request-Timestamp` anti-replay bounds (default 300s) via constant-time `timingSafeEqual`.
  - Completes Slack `url_verification` challenge handshakes automatically.
  - Parses direct messages (`message.im`), channel/group `@bot` mentions (`app_mention`), and threaded replies (`message` with `thread_ts`).
  - Filters bot-originated messages (`bot_id`, `bot_profile`, `bot_message` subtype, and `botUserId` self-messages) to prevent infinite reply loops.
- **Socket Mode WebSocket Receiver (`start` / `stop`)**
  - Requests dynamic `wss://` ticket URLs via `POST https://slack.com/api/apps.connections.open` using an app-level token (`xapp-...`).
  - Awaits Slack's `hello` handshake, immediately acknowledges incoming envelopes with `{"envelope_id":"..."}`, and handles `disconnect` (`refresh_requested` / `warning`) and transient drops with bounded exponential backoff reconnection.
- **Web API Outbound Sender (`chat.postMessage`)**
  - Unified `sender.schema` root `{ text, channelId?, threadTs?, replyBroadcast?, mrkdwn? }`.
  - Strict 3-tier target resolution: explicit `params` (`channelId` / `threadTs`) -> structured `context.contextId` (`dm:<channelId>` or `channel:<channelId>:<threadTs>`) -> `ConnectorTargetRequiredError`.
  - Preserves `thread_ts` thread affinity and returns structured `SlackSendResult` (`channelId`, `messageTs`, `threadTs`, `raw`) for downstream editing/streaming extensions.
  - Supports optional context markers (`prependContextMarker` / `extractContextMarker`) including quoted Slack blockquotes (`&gt; [#ctx:...]`).
- **Streaming & In-Place Update Extension Seam (`src/streaming.ts`)**
  - Phase 2 executes non-streaming request/reply delivery while reserving full zero-`any` TypeScript contracts and Connector adapter slots (`streaming` / `streamingAdapter` / `getStreamingAdapter()`) for:
    - In-place message editing (`chat.update`)
    - AI Assistant thread status indicators (`assistant.threads.setStatus`)
    - Native Slack streaming conversations (`chat.startStream` / `chat.appendStream` / `chat.stopStream`)

## Installation

```bash
pnpm add @dsh-connector/connector-slack @dsh-connector/core zod
```

## Quick Start

### 1. Socket Mode (No Public Webhook URL Required)

```ts
import { createSlackConnector } from "@dsh-connector/connector-slack";

const slack = createSlackConnector({
  name: "slack",
  botToken: process.env.SLACK_BOT_TOKEN!, // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN!, // xapp-... (connections:write)
});
```

### 2. Events API HTTP Webhook Mode

```ts
import { createSlackConnector } from "@dsh-connector/connector-slack";

const slack = createSlackConnector({
  name: "slack",
  botToken: process.env.SLACK_BOT_TOKEN!, // xoxb-...
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  botUserId: process.env.SLACK_BOT_USER_ID, // optional; enables <@BOT_ID> stripping without startup auth.test
});
```

## Target Addressing & Context Format

| Conversation Kind                    | Canonical `ConnectorContextId`                  | Outbound `chat.postMessage` Resolution                                        |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Direct Message (`message.im`)        | `dm:<channelId>` or `dm:<channelId>:<threadTs>` | Posts to `channel = <channelId>` (with `thread_ts` if threaded)               |
| Channel / Group `@mention` or Thread | `channel:<channelId>:<threadTs>`                | Posts to `channel = <channelId>` with `thread_ts = <threadTs>`                |
| Outbound-First (UUID context)        | `<uuid>`                                        | Requires explicit `params.channelId` or throws `ConnectorTargetRequiredError` |

## Streaming Extension Seam (Reserved for Future Host-Driven Streaming)

`SlackConnectorOptions` accepts optional `streaming` / `streamingAdapter` (`SlackStreamingAdapter`) and exposes `connector.getStreamingAdapter()`, typed against Slack's official streaming and message-modification APIs without coupling Phase 2 non-streaming delivery to progressive state:

- [`chat.update`](https://docs.slack.dev/reference/methods/chat.update) — `SlackChatUpdateParams` / `SlackChatUpdateResult`
- [`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus) — `SlackAssistantThreadStatusParams` / `SlackAssistantThreadStatusResult`
- [`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream) — `SlackStartStreamParams` / `SlackStartStreamResult`
- [`chat.appendStream`](https://docs.slack.dev/reference/methods/chat.appendStream) — `SlackAppendStreamParams` / `SlackAppendStreamResult`
- [`chat.stopStream`](https://docs.slack.dev/reference/methods/chat.stopStream) — `SlackStopStreamParams` / `SlackStopStreamResult`

## Official Slack Documentation References

- [Events API — Using HTTP Request URLs (`url_verification` & `event_callback`)](https://docs.slack.dev/apis/events-api/using-http-request-urls/)
- [Verifying Requests from Slack (`X-Slack-Signature` `v0` HMAC-SHA256)](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Using Socket Mode & `envelope_id` Acknowledgement](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [`apps.connections.open`](https://docs.slack.dev/reference/methods/apps.connections.open)
- [`auth.test`](https://docs.slack.dev/reference/methods/auth.test)
- [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [`message.im` event](https://docs.slack.dev/reference/events/message.im)
- [`app_mention` event](https://docs.slack.dev/reference/events/app_mention/)
