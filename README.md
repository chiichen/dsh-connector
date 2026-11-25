# dsh-connector

[中文说明](README.zh.md)

Session-scoped messaging connectors for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness), and the `dsh-connector-plugin` that runs them inside a dsh profile.

The plugin starts the connectors you enable, binds each chat to an agent session, registers a send tool, and mounts HTTP callbacks on dsh's web server. Settings live in the dsh sidebar: Account → Settings → Connectors.

Install the plugin from a checkout of this repository:

```sh
dsh plugin --profile <profile> add <absolute path of packages/dsh-connector-plugin>
```

Requires Node.js `>=24.20.0`.

## Connectors

Each row is one access method. ✅ means that method was exercised against a real bot with real credentials. ⚠️ means it has not. Passing unit tests are not a live integration test. Only the WeCom intelligent-bot long connection has been live-tested. The bot id and secret are not stored in this repository.

A settings value of `both` or `hybrid` turns on the two methods in that row group together. Those combinations have not been live-tested either. DingTalk can also set inbound mode to `none`, which starts no inbound transport.

| Connector | Access | Inbound | Live test |
| --- | --- | --- | --- |
| Feishu | [Webhook](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case) | HTTP event subscription | ⚠️ Not live-tested |
| Feishu | [WebSocket](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case) | Long connection | ⚠️ Not live-tested |
| WeChat | [Official Account callback](https://developers.weixin.qq.com/doc/service/guide/dev/push/) | HTTP callback (`echostr` and message push) | ⚠️ Not live-tested |
| WeChat | iLink | HTTPS long polling | ⚠️ Not live-tested |
| DingTalk | [Stream](https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description) | WebSocket long connection | ⚠️ Not live-tested |
| DingTalk | [Outgoing webhook](https://open.dingtalk.com/document/orgapp/receive-message.md) | HTTP callback | ⚠️ Not live-tested |
| WeCom | [Self-built app](https://developer.work.weixin.qq.com/document/path/91039) | App message API. The settings form does not include the callback token. | ⚠️ Not live-tested |
| WeCom | [HTTP callback](https://developer.work.weixin.qq.com/document/path/90930) | URL verification and encrypted callback. An intelligent-bot callback is the same form with an empty receive id ([bot callback](https://developer.work.weixin.qq.com/document/path/100719)). | ⚠️ Not live-tested |
| WeCom | [AI bot long connection](https://developer.work.weixin.qq.com/document/path/101463) | WebSocket `wss://openws.work.weixin.qq.com/` | ✅ Live-tested with a real bot |
| WeCom | [Group webhook bot](https://developer.work.weixin.qq.com/document/path/99110) | Outbound only (`cgi-bin/webhook/send`). Not a settings connection form. | ⚠️ Not live-tested |
| QQ | [Webhook](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html) | HTTP callback | ⚠️ Not live-tested |
| QQ | [WebSocket gateway](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) | Gateway long connection | ⚠️ Not live-tested |
| Slack | [Events API](https://docs.slack.dev/apis/events-api/) | HTTP webhook | ⚠️ Not live-tested |
| Slack | [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) | WebSocket long connection | ⚠️ Not live-tested |
| Telegram | [Long polling](https://core.telegram.org/bots/api#getupdates) | `getUpdates` | ⚠️ Not live-tested |
| Telegram | [Webhook](https://core.telegram.org/bots/api#setwebhook) | HTTPS webhook | ⚠️ Not live-tested |
| Telegram | Passive | Accepts HTTP without calling `setWebhook` | ⚠️ Not live-tested |
| Discord | [Gateway](https://discord.com/developers/docs/events/gateway) | WebSocket v10 | ⚠️ Not live-tested |
| Discord | [Interactions](https://discord.com/developers/docs/interactions/receiving-and-responding) | HTTP interaction webhook | ⚠️ Not live-tested |
| WhatsApp | [Cloud API webhook](https://developers.facebook.com/docs/graph-api/webhooks/getting-started) | GET verification and POST notifications | ⚠️ Not live-tested |

Discord gateway and interaction webhooks can both be enabled. They are not mutually exclusive forms.

## Context ids

A `contextId` is the string a connector passes to the plugin. The plugin stores `<connector name>--<contextId>` (`packages/dsh-connector-plugin/src/context-store.ts`). The same pair routes to the same dsh session while that session still exists. A string the store has not seen opens a new session. After the bound session is gone, the binding is dropped and the same string opens a new session. One session keeps one `contextId` per connector; binding a second id for that connector is rejected, and the first id stays.

Inbound code builds the string from chat fields. The same fields always build the same string, so the next message in that chat reuses it. A context marker on its own line replaces the field-built string. The marker is `[#ctx:<id>]` or `<!-- dsh-ctx:<id> -->` (`packages/connector-core/src/context.ts`). When several marker lines are present, the line with the fewest leading `>` quotes is kept. A reply uses that to return to an outbound-first UUID.

The first outbound send from a session that has no context for that connector stores a new UUID from `randomUUID()` (`createDefaultContextIdGenerator`). Later sends on that session and connector reuse the UUID. The UUID is not parsed as a platform recipient, so the send still needs an explicit target until a structured id is bound.

Two access methods that call the same ingest function share one formula. Events the receiver drops (its own messages, empty text, group messages that fail the mention rule, unsupported event types) do not receive a `contextId`.

Marker checks, in order, before the field-built id:

- Feishu ([receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)): the message text, then the parent message loaded by `parent_id`. The parent lookup runs unless `resolveReplyContextFromParent` is false. A failed or empty lookup leaves the field-built id. Only `im.message.receive_v1` is ingested.
- WeChat Official Account: `Content`, or voice `Recognition`. There is no quote lookup. ([callback](https://developers.weixin.qq.com/doc/service/guide/dev/push/))
- WeChat iLink: the message text, then the quoted text. `context_token` is cached per user and is not a `contextId`.
- DingTalk ([Stream](https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description) and [outgoing webhook](https://open.dingtalk.com/document/orgapp/receive-message.md) share `ingestRobotPayload`): quoted text, then the body.
- WeCom inbound ([app callback](https://developer.work.weixin.qq.com/document/path/90930), [bot callback](https://developer.work.weixin.qq.com/document/path/100719), [bot long connection](https://developer.work.weixin.qq.com/document/path/101463)): quoted text, then the body.
- QQ ([C2C](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html), [group](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html), [channel](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/event.html)): quoted message element, then the body.
- Slack ([`message.im`](https://docs.slack.dev/reference/events/message.im), [`app_mention`](https://docs.slack.dev/reference/events/app_mention/), [`message`](https://docs.slack.dev/reference/events/message)): the current message text, after Slack entity decoding.
- Telegram ([`Message`](https://core.telegram.org/bots/api#message)): `text` or `caption`, then `reply_to_message` `text` or `caption`.
- Discord Gateway ([`MESSAGE_CREATE`](https://discord.com/developers/docs/events/gateway-events#message-create)): `referenced_message.content`, then the current message.
- Discord Interactions ([interactions](https://discord.com/developers/docs/interactions/receiving-and-responding)): `interaction.message.content`, then the prompt text.
- WhatsApp ([webhook payload](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples)): the message text, then `SentMessageTracker` for the reply `context.id` (the outbound message id recorded in this process). The map is in-memory and drops the oldest entry at `DEFAULT_OUTBOUND_ECHO_CACHE_SIZE`. A miss leaves the field-built id.

| Connector | Access | Situation | Built from | Reused when | New when |
| --- | --- | --- | --- | --- | --- |
| Feishu | Webhook, WebSocket | Direct chat, `open_id` present | `p2p:<open_id>` from `sender.open_id` | Same `open_id`, and no marker wins | Another `open_id`, or a marker id |
| Feishu | Webhook, WebSocket | Direct chat, no `open_id`, `user_id` present | `p2p:user:<user_id>` from `sender.user_id` | Same `user_id`, and no marker wins | Another `user_id`, or a marker id |
| Feishu | Webhook, WebSocket | Direct chat, only `chat_id` | `p2p:<chat_id>` from `chat_id` | Same `chat_id`, and no marker wins | Another `chat_id`, or a marker id |
| Feishu | Webhook, WebSocket | Group, no `thread_id` | `group:<chat_id>` from `chat_id` | Same `chat_id`, and no marker wins | Another chat, or a marker id |
| Feishu | Webhook, WebSocket | Group with `thread_id` | `group:<chat_id>:topic:<root>` from `chat_id` and `root_id`, or the current `message_id` when `root_id` is absent | Same chat and same root, and no marker wins | Another root, or a marker id |
| Feishu | `buildFeishuConversationContextId` | `thread_id` set and no root message id passed | `group:<chat_id>:thread:<thread_id>` | Same chat and `thread_id` | Another `thread_id`. Inbound always passes a root, so a received thread message uses the topic row |
| WeChat | Official Account callback | 1:1 text or voice | `p2p:<FromUserName>` | Same `FromUserName`, and no marker in the content | Another sender, or a marker id |
| WeChat | iLink | 1:1 message | `p2p:<from_user_id>` | Same `from_user_id`, and no marker in the text or the quote | Another sender, or a marker id |
| DingTalk | Stream, outgoing webhook | Group, `conversationType` `2` | `group:<conversationId>` | Same `conversationId`, and no marker wins | Another conversation, or a marker id |
| DingTalk | Stream, outgoing webhook | Single chat with `senderStaffId`. Any `conversationType` other than `2`, including a missing one, is single | `p2p:<senderStaffId>` | Same `senderStaffId`, and no marker wins | Another staff id, or a marker id |
| DingTalk | Stream, outgoing webhook | Single chat without `senderStaffId` | `p2p-id:<senderId>` | Same `senderId`, and no marker wins | Another `senderId`, or a marker id |
| DingTalk | Inbound mode `none` | No inbound transport | The plugin UUID on the first send | Later sends on that session and connector | The first send of a session that has no DingTalk context |
| WeCom | HTTP callback, XML body | Single chat. `ChatId` absent, so the chat is single | `app:p2p:<FromUserName>` | Same `FromUserName`, and no marker wins | Another sender, or a marker id |
| WeCom | HTTP callback, XML body | Group. `ChatId` present | `app:group:<ChatId>` | Same `ChatId`, and no marker wins | Another chat, or a marker id |
| WeCom | HTTP callback JSON, AI bot long connection | Group. `chattype` is `group` and `chatid` is set | `aibot:group:<chatid>` | Same `chatid`, and no marker wins | Another chat, or a marker id |
| WeCom | HTTP callback JSON, AI bot long connection | Single chat, or a group payload with no `chatid` | `aibot:p2p:<userid>` from `from.userid` | Same userid, and no marker wins | Another sender, or a marker id |
| WeCom | Self-built app message API | That settings form has no callback, so no inbound id is built | Plugin UUID | Later sends on that session and connector | The first send of a session that has no WeCom context |
| WeCom | Group webhook bot | Outbound only. The send `webhookKey` does not rewrite the id | Plugin UUID. A session already bound to `webhook:<key>` keeps that string, and send parses it as the group-robot key | Later sends on that session, or the same `webhook:<key>` | The first send of a session that has no WeCom context |
| WeCom | Parse only | A stored id shaped `p2p:<id>` or `group:<id>`. Inbound does not build these prefixes | Read as the connector default channel: `aibot` when app config is absent and a callback or AI-bot config is present, otherwise `app` | The stored string | Binding a session to that string for the first time |
| QQ | Webhook, WebSocket gateway | C2C `C2C_MESSAGE_CREATE` | `c2c:<openId>` from author `user_openid`, else `member_openid`, else `id` | Same open id, and no marker wins | Another author, or a marker id |
| QQ | Webhook, WebSocket gateway | Group `GROUP_AT_MESSAGE_CREATE` | `group:<group_openid>` | Same `group_openid`, and no marker wins | Another group, or a marker id |
| QQ | Webhook, WebSocket gateway | Channel `AT_MESSAGE_CREATE` with `guild_id` | `channel:<guild_id>:<channel_id>` | Same guild and channel, and no marker wins | Another guild or channel, or a marker id |
| QQ | Webhook, WebSocket gateway | Channel `AT_MESSAGE_CREATE` without `guild_id` | `channel:<channel_id>` | Same `channel_id`, and no marker wins | Another channel, or a marker id |
| Slack | Events API, Socket Mode | `message` in an IM (`channel_type` `im`, or a channel id starting with `D`) and no valid `thread_ts` | `dm:<channelId>` | Same IM channel, and no marker in the text | Another channel, or a marker id |
| Slack | Events API, Socket Mode | `message` in an IM with a valid `thread_ts` | `dm:<channelId>:<thread_ts>` | Same channel and `thread_ts`, and no marker in the text | Another thread, or a marker id |
| Slack | Events API, Socket Mode | `app_mention` in an IM | `dm:<channelId>:<thread_ts or ts>` | Same channel and that timestamp, and no marker in the text | A mention with another `ts`, or a marker id. A top-level mention uses `ts`, so each top-level mention is its own id |
| Slack | Events API, Socket Mode | `app_mention` in a channel, group, or mpim. When `channel_type` is absent, an id starting with `D` is an IM and `G` is a group; any other id is a channel. Group and mpim still use the `channel:` prefix | `channel:<channelId>:<thread_ts or ts>` | Same channel and that timestamp, and no marker in the text | A mention with another `ts`, or a marker id |
| Slack | Events API, Socket Mode | Thread reply in a channel, group, or mpim (`thread_ts` set and different from `ts`) | `channel:<channelId>:<thread_ts>` | Same channel and `thread_ts`, and no marker in the text | Another thread, or a marker id |
| Slack | Events API, Socket Mode | Top-level `message` in a channel, group, or mpim that is not an `app_mention` | No `contextId`. The event is ignored | No id is stored for this event | No id is created. A thread reply uses the thread row |
| Telegram | Long polling, webhook, passive | `private` | `p2p:<chat.id>`, plus `:<message_thread_id>` when that id is a positive safe integer | Same chat and thread id, and no marker wins | Another chat or thread, or a marker id |
| Telegram | Long polling, webhook, passive | `group` or `supergroup`. `is_topic_message` does not add a segment | `group:<chat.id>`, plus `:<message_thread_id>` when that id is a positive safe integer | Same chat and thread id, and no marker wins | Another chat or thread, or a marker id |
| Telegram | Formatter and parser | Channel updates are dropped before an id is built. `formatTelegramContextId` can still build a channel id and does not append a thread id. The parser also accepts `direct:` as a private chat and `supergroup:` as a group; the formatter writes `p2p:` and `group:` | `channel:<chatId>` when a caller formats a channel | The stored string | Binding that string for the first time |
| Discord | Gateway | DM or group DM (no `guild_id`, or channel type DM / group DM) | `dm:<channel_id>` | Same channel, and no marker wins | Another channel, or a marker id |
| Discord | Gateway | Thread (announcement, public, or private) with a parent id | `thread:<parent_id>:<thread_id>` | Same parent and thread, and no marker wins | Another thread, or a marker id |
| Discord | Gateway | Thread whose parent id was not loaded | `thread:<thread_id>` | Same thread id, and no marker wins | Another thread, or a marker id |
| Discord | Gateway | Other guild channel | `channel:<channel_id>` | Same channel, and no marker wins | Another channel, or a marker id |
| Discord | Gateway | `autoCreateThreadOnMention` is on (default off), the message is a guild channel message, and no marker was found | After the thread is created: `thread:<original channel_id>:<new thread id>`. A failed create keeps `channel:<channel_id>` | That new thread on later messages | Each successful auto-create, because the thread id is new |
| Discord | Interactions webhook | DM, thread, or guild channel on the interaction. This path does not auto-create a thread | Same `dm:` / `thread:` / `channel:` shapes as the Gateway rows, using the interaction channel | Same channel or thread, and no marker wins | Another channel or thread, or a marker id |
| Discord | Send parse | `user:<user snowflake>` is accepted as a send target. Inbound does not assign it | `user:<userId>` when that string is already the context | The stored string | Binding that string for the first time |
| WhatsApp | Cloud API webhook | 1:1. `group_id` absent | `direct:<wa_id>` from the contact `wa_id`, or `from` when the contact has no `wa_id`. Trimmed, not digit-normalized | The resolved string is already bound: the `wa_id` form when no marker and no tracker hit, or the tracked outbound id while that wamid is cached | A different `wa_id`, a marker id, or a tracked id the store has not seen |
| WhatsApp | Cloud API webhook | Group. `group_id` set | `group:<group_id>` | The resolved string is already bound: the `group_id` form when no marker and no tracker hit, or the tracked outbound id while that wamid is cached | Another group, a marker id, or a tracked id the store has not seen |
| WhatsApp | Send parse | `p2p:<id>` is accepted as a 1:1 recipient. Inbound writes `direct:` | The stored `p2p:` string | The stored string | Binding that string for the first time |
| Plugin | Any connector, outbound | Session has no context yet for this connector | UUID from `contextIdGenerator` (default `randomUUID()`) | Later sends on that session and connector | That first send. A custom generator, when configured, supplies the string instead |
| Plugin | Any connector, inbound | The connector's string is already bound to a live session | The stored `<connector name>--<contextId>` | That session | A different string opens another session |
| Plugin | Any connector, inbound | The string has no live session. A missing session is removed first | The connector's string, unchanged | The `contextId` string stays the one the connector built | A new session bound to that same string |
| Plugin | Any connector, bind | The session already has a different `contextId` for this connector, or this string is already bound to another session | The existing binding | The first id stays. The second bind is rejected | No id is created. `bind` throws |

Field-built ids are produced by `buildFeishuConversationContextId`, `formatWeixinP2pContextId`, `formatDingTalkP2PContextId` / `formatDingTalkEncryptedP2PContextId` / `formatDingTalkGroupContextId`, `formatWeComContextId`, `formatQqContextId`, `formatSlackContextId`, `formatTelegramContextId`, `formatDiscordDmContextId` / `formatDiscordThreadContextId` / `formatDiscordChannelContextId` / `formatDiscordUserContextId`, and `formatWhatsAppContextId`.

## dsh compatibility

`engines.dsh` is `>=0.2.2-rc.2 <0.2.3-0`. The floor is the oldest published version where `pnpm --filter dsh-connector-plugin run test:dsh-host` passed both cases. The ceiling excludes `0.2.3-alpha.1` and `0.2.3-alpha.2`, which fail the settings-client case. `peerDependencies` are still `>=0.2.2-0 <0.3.0`.

Each row installs every `@deepseek-ai/dsh-*` devDependency at that version and runs `tests/client-host.test.ts`. The client case loads the settings bundle through `@deepseek-ai/dsh-client-modules`. The server case activates the plugin on Cordis. Versions that are not in this table were not run.

| dsh | Settings client | Server plugin |
| --- | --- | --- |
| 0.2.1-rc.5 | ❌ Cannot import `@deepseek-ai/dsh-client-modules/src/client/index.ts` | ❌ `@deepseek-ai/dsh-tools` `ToolsService` is not a Cordis plugin |
| 0.2.2-alpha.2 | ❌ Same missing client entry | ✅ |
| 0.2.2-alpha.3 | ❌ Same missing client entry | ✅ |
| 0.2.2-rc.1 | ❌ Same missing client entry | ✅ |
| 0.2.2-rc.2 | ✅ | ✅ |
| 0.2.2-rc.3 | ✅ | ✅ |
| 0.2.2-rc.4 | ✅ | ✅ |
| 0.2.2-rc.5 | ✅ | ✅ |
| 0.2.3-alpha.1 | ❌ `options.staticModules is not iterable` | ✅ |
| 0.2.3-alpha.2 | ❌ `options.staticModules is not iterable` | ✅ |

The earliest version with both cases passing is **0.2.2-rc.2**.

## Packages

- `@dsh-connector/core` (`packages/connector-core`): Host-agnostic connector capability contracts, stateless `ConnectorContext` model, context marker codec, and error hierarchy (`zod` v4 peer dependency, zero `dsh` dependencies).
- `dsh-connector-plugin` (`packages/dsh-connector-plugin`): Unified Cordis / `dsh` host plugin managing connector lifecycles, `SessionId <-> ConnectorContext` bidirectional mappings, Agent tool registration, and HTTP webhook routing.
- `@repo/typescript-config` (`packages/typescript-config`): Shared TypeScript configurations.
- `@repo/eslint-config` (`packages/eslint-config`): Shared ESLint configuration.

## Development

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run oxlint
pnpm run oxfmt
```
