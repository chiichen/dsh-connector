# `@dsh-connector/connector-discord`

Zero-third-party-runtime-dependency Discord connector for `@dsh-connector/core`, built strictly against the official **Discord Developer Portal API v10** specification on Node.js 24 built-ins (`fetch`, `WebSocket`, `node:crypto` Ed25519).

## Features

- **Gateway v10 WebSocket State Machine (`wss://...?v=10&encoding=json`)**
  - Resolves Gateway endpoint via `GET /gateway/bot` (or explicit `gatewayUrl`).
  - Handles `Hello` (`op: 10`), jittered `Heartbeat` (`op: 1`) + `Heartbeat ACK` (`op: 11`) zombie-socket detection, `Identify` (`op: 2`), `Resume` (`op: 6`) on `resume_gateway_url`, `Reconnect` (`op: 7`), and `Invalid Session` (`op: 9`).
  - Distinguishes fatal close codes (`4004`, `4010`–`4014`), session-reset close codes (`4003`, `4007`, `4009`), and resumable transient disconnects.
- **Inbound `MESSAGE_CREATE` & Interactions HTTP Webhook Routing**
  - Filters out self-authored bot messages (`author.id === botUserId`), other bots/webhooks (by default), and non-conversational system message types (`THREAD_STARTER_MESSAGE = 21`, etc.).
  - Routes Direct Messages (`dm:<channelId>`), `@mention` / reply-to-bot Guild channel messages (`channel:<channelId>`), and Threads (`thread:<parentId>:<threadId>`), with optional automatic thread creation (`autoCreateThreadOnMention`).
  - Verifies Discord HTTP Interactions Webhooks via `X-Signature-Ed25519` + `X-Signature-Timestamp` using `node:crypto` Ed25519, responds to `PING` (`type: 1`) with `PONG` (`{"type":1}`), and dispatches Slash Commands (`type: 2`), Message Components (`type: 3`), and Modal Submits (`type: 5`) with `DEFERRED` callbacks.
  - Supports `[#ctx:<contextId>]` context marker extraction on replies and interaction messages.
- **REST API v10 Outbound Sender (`POST /channels/{channel.id}/messages`)**
  - Unified `sender.schema` (`{ text, channelId?, threadId?, userId?, replyToMessageId?, includeContextMarker? }`).
  - Strict three-level target resolution (`params` > structured `context.contextId` > `ConnectorTargetRequiredError`) — pre-allocated UUID `contextId` values are never sent as Discord channel IDs.
  - Opens & caches DM channels on demand via `POST /users/@me/channels` when targeting `userId` / `user:<userId>`.
  - Fence-aware, UTF-16-surrogate-safe 2000-character message chunking (`splitDiscordMessage`).
  - Automatic HTTP `429` rate-limit retry respecting `retry_after`.
- **Reserved Streaming Extension Seam (`src/streaming.ts`)**
  - Current phase implements the non-streaming send/receive loop only.
  - Pre-defines zero-`any` contracts, options (`streaming`, `streamingAdapter`), REST v10 helper methods, and path builders for:
    - `PATCH /channels/{channel.id}/messages/{message.id}`
    - `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original`
    - `POST /channels/{channel.id}/typing`

## Discord Developer Portal Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**:
   - Copy the **Bot Token** (`botToken`).
   - Enable the **Message Content Intent** (`1 << 15`) so Gateway `MESSAGE_CREATE` payloads include user message `content`.
3. (Optional, for Slash Commands / Components / Modals over HTTP) Under **General Information**:
   - Copy the **Public Key** (`publicKey`, 64-character hex Ed25519 key).
   - Point **Interactions Endpoint URL** to your host webhook endpoint (`/webhooks/connectors/discord`).

Default Gateway Intents bitmask (`DISCORD_DEFAULT_INTENTS = 37377`):

- `GUILDS` (`1 << 0`)
- `GUILD_MESSAGES` (`1 << 9`)
- `DIRECT_MESSAGES` (`1 << 12`)
- `MESSAGE_CONTENT` (`1 << 15`)

## Usage

```ts
import { createConnectorContext } from "@dsh-connector/core";
import { createDiscordConnector } from "@dsh-connector/connector-discord";

const discord = createDiscordConnector({
  botToken: process.env.DISCORD_BOT_TOKEN,
  publicKey: process.env.DISCORD_PUBLIC_KEY, // Optional: required only for HTTP Interactions Webhook
  autoCreateThreadOnMention: false,
  includeContextMarker: false,
});

await discord.start();

// Proactive outbound send with explicit channelId or userId:
const sender = discord.getSender()!;
await sender.send(createConnectorContext("discord", "550e8400-e29b-41d4-a716-446655440000"), {
  text: "Deployment succeeded!",
  channelId: "41771983423143937",
});

await discord.stop();
```

## Official Discord Documentation References

- [API v10 Reference & Authentication](https://discord.com/developers/docs/reference)
- [Gateway v10 Lifecycle, Heartbeating & Resuming](https://discord.com/developers/docs/events/gateway)
- [Gateway Opcodes & Close Event Codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes)
- [Gateway Events (`READY`, `MESSAGE_CREATE`)](https://discord.com/developers/docs/events/gateway-events)
- [Channel & Thread Resources](https://discord.com/developers/docs/resources/channel)
- [Message Resource (`POST` / `PATCH` / 2000-char limit)](https://discord.com/developers/docs/resources/message)
- [Interactions Endpoint & Ed25519 Signature Verification](https://discord.com/developers/docs/interactions/overview)
- [Receiving & Responding to Interactions](https://discord.com/developers/docs/interactions/receiving-and-responding)
