# `@dsh-connector/connector-whatsapp`

Official **Meta WhatsApp Business Cloud API** connector for `@dsh-connector/core`, built with zero external HTTP/SDK runtime dependencies on top of Node.js 24 native `fetch` and `node:crypto`.

## Official Protocol Ground Truth

All wire payloads, authentication headers, webhook challenge/signature verification, error codes, and status/typing indicator schemas strictly follow Meta's official developer documentation:

- [WhatsApp Business Cloud API Overview](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [Messages API Reference (`POST /{Version}/{Phone-Number-ID}/messages`)](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages)
- [Text Messages (4,096-character limit & `preview_url`)](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages)
- [Service Messages & Contextual Replies (`context.message_id`)](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages)
- [Meta Graph API Webhooks (`hub.mode` / `hub.verify_token` / `hub.challenge` & `X-Hub-Signature-256`)](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)
- [Webhook Notification Payload Examples (`whatsapp_business_account`)](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples)
- [Mark Messages as Read](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read)
- [Typing Indicators (`status: "read"` + `typing_indicator`)](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators)
- [Reaction Messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/reaction-messages)
- [Cloud API Error Codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)

## Features

- **Webhook Verification & Security**:
  - `GET` subscription handshake (`hub.mode=subscribe`, constant-time `hub.verify_token` check, `hub.challenge` echo).
  - `POST` `X-Hub-Signature-256` (`sha256=<hex>`) HMAC-SHA256 verification over raw request bytes via `crypto.timingSafeEqual`.
- **Inbound Message & Quote-Reply Routing**:
  - Parses `entry[].changes[].value.messages` (`text`, `button`, and `interactive` button/list replies).
  - Filters `statuses` delivery/read receipts and prevents self-message echo loops (matching business phone number ID, display phone number, and a bounded FIFO tracker of sent `wamid`s).
  - Resolves session context with three-stage priority: inline context marker (`extractContextMarker`) > quoted outbound `wamid` (`messages[].context.id`) > deterministic conversation ID (`direct:<wa_id>` or `group:<group_id>`).
- **Outbound Sending & 4,096-Character Chunking**:
  - Unified `sender.schema` (`{ text, to?, recipientType?, replyToMessageId?, previewUrl? }`).
  - Three-tier recipient resolution: explicit `params.to` > structured `context.contextId` (`direct:...` / `p2p:...` / `group:...`) > `ConnectorTargetRequiredError`.
  - Surrogate-safe, Markdown code-fence-aware splitting at `4096` characters (`WHATSAPP_MAX_TEXT_LENGTH`), attaching `context: { message_id }` to the leading chunk.
- **Streaming & Turn-Progress Extension Seam (`src/streaming.ts`)**:
  - Current phase implements non-streaming request/response delivery only.
  - Preserves complete message handles in `WhatsAppSendResult` (`messageId`, `messageIds`, `recipientId`, `recipientType`, `phoneNumberId`, `raw`).
  - Exports typed official Cloud API payload builders (`buildMarkReadPayload`, `buildTypingIndicatorPayload`, `buildReactionPayload`) and pluggable `WhatsAppStreamingAdapter` / `WhatsAppStreamingOptions` slots on `WhatsAppConnector`.

## Quick Start

```ts
import { createWhatsAppConnector } from "@dsh-connector/connector-whatsapp";

const whatsapp = createWhatsAppConnector({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  appSecret: process.env.WHATSAPP_APP_SECRET,
});
```
