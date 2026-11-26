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

A `contextId` is the string a connector passes to the plugin. The plugin stores `<connector name>--<contextId>` (`packages/dsh-connector-plugin/src/context-store.ts`). That pair routes to the same dsh session only while the session is still alive. A string with no live session opens a new session. After the bound session is gone, the binding is dropped and the same string opens a new session. One session keeps one `contextId` per connector; binding a second id for that connector is rejected, and the first id stays.

Direct messages and group messages use the same rule. The only reuse of an existing conversation is a context marker already present in the inbound payload: the message body, or quoted text the payload already includes. The marker is `[#ctx:<id>]` or `<!-- dsh-ctx:<id> -->` (`packages/connector-core/src/context.ts`). When several marker lines are present, the line with the fewest leading `>` quotes is kept. The body wins over a marker that appears only inside a quote. A quote that supplies only a message id, with no original text on the payload, does not reuse anything. Connectors do not fetch history to recover that text.

If no marker is extracted, the context id is `msg:` plus this inbound message's own id (`MESSAGE_CONTEXT_ID_PREFIX` in `@dsh-connector/core`). Each send and each @mention is a new id. Later messages in the same chat, thread, or topic are not folded into it. Slack's id is `msg:<channel id>:<ts>` because a Slack timestamp is unique per channel. Telegram's id is `msg:<chat id>:<message id>` because a Telegram message id is unique per chat. Every other inbound id is `msg:` plus the platform message id.

Outbound text includes that marker unless the send turns it off (`contextMarker` `never` or `none`, or `includeContextMarker: false`). A later quote can then extract it. Feishu, Slack, QQ, WeCom, DingTalk, WeChat, WhatsApp, and Discord use the bracket form. Telegram uses the HTML comment. The default is on.

Events the receiver drops (its own messages, empty text, group messages that fail the mention rule, unsupported types) do not receive a context id. Access methods with no inbound message id keep the UUID the plugin generates on send, and the outbound body still carries that id.

A stored id that already uses a platform prefix (`p2p:`, `group:`, `dm:`, `channel:`, `thread:`, `c2c:`, `direct:`, `app:`, `aibot:`, `webhook:`, `user:`) is still parsed as a send recipient. Inbound code does not build those prefixes. A `msg:` id is not a recipient, so a reply in that session needs an explicit target, a session webhook or `response_url` cached for that exact id, or a structured id that was bound earlier.

Quoted text already on the inbound payload: DingTalk `text.repliedMsg.content`; WeCom `quote` text, voice, and mixed; QQ quote element `content`; WeChat iLink `ref_msg` text or title; Slack text, where a quote is inline; Telegram `reply_to_message` text or caption and `quote.text`; Discord Gateway `referenced_message.content`; Discord Interactions `interaction.message.content`.

Id only, so the message gets a new `msg:` id: Feishu `parent_id` and `root_id`; WhatsApp `messages[].context.id`; Discord `message_reference` when `referenced_message.content` is absent; Slack `thread_ts` with no marker in the text; WeChat Official Account, which has no quote field; QQ, iLink, and DingTalk when the quote object has an id and no text.

| Connector | Access | Situation | Built from | Reused when | New when |
| --- | --- | --- | --- | --- | --- |
| Feishu | Webhook, WebSocket | Any accepted `im.message.receive_v1`, direct or group | Marker in the event text, else `msg:<message_id>` | That string is bound to a live session | No marker, or the live session for that string is gone. `parent_id` is not loaded |
| WeChat | Official Account callback | 1:1 text or voice | Marker in `Content` or voice `Recognition`, else `msg:<MsgId>`. Missing `MsgId` uses `msg:<FromUserName>:<CreateTime>` | That string is bound to a live session | No marker, or the live session is gone |
| WeChat | iLink | 1:1 message | Marker in the text or in `ref_msg` text/title, else `msg:<message_id>`, or `msg:<client_id>` when `message_id` is absent. `context_token` is not a context id | That string is bound to a live session | No marker, including a quote that has only an id, or the live session is gone |
| DingTalk | Stream, outgoing webhook | Any accepted robot message, single or group | Marker in the body or in `text.repliedMsg.content`, else `msg:<msgId>` (Stream falls back to the callback message id). If both ids are missing, a marker still wins; otherwise the id is a raw UUID from `allocateContextId()` | That string is bound to a live session. A session webhook cached for this exact id is the reply route | No marker, or the live session is gone |
| DingTalk | Inbound mode `none` | No inbound transport | Plugin UUID on the first send. The outbound body still includes the marker | Later sends on that session and connector | The first send of a session that has no DingTalk context |
| WeCom | HTTP callback, XML body | Single or group app callback | Marker in the body or the quote, else `msg:<MsgId>`. Missing `MsgId` uses `msg:<FromUserName>:<CreateTime>` | That string is bound to a live session | No marker, or the live session is gone |
| WeCom | HTTP callback JSON, AI bot long connection | Single or group intelligent-bot message | Marker in the body or the quote, else `msg:<msgid>`. Missing `msgid` uses `msg:<userid>:<now>` | That string is bound to a live session. A `response_url` cached for this exact id is the reply route | No marker, or the live session is gone |
| WeCom | Self-built app message API | That settings form has no callback | Plugin UUID. The outbound body still includes the marker | Later sends on that session and connector | The first send of a session that has no WeCom context |
| WeCom | Group webhook bot | Outbound only | Plugin UUID. The outbound body still includes the marker. A session already bound to `webhook:<key>` keeps that string, and send parses it as the group-robot key | Later sends on that session, or the same `webhook:<key>` | The first send of a session that has no WeCom context |
| QQ | Webhook, WebSocket gateway | C2C, group, or channel | Marker in the body or the quote element `content`, else `msg:<message id>` | That string is bound to a live session | No marker, including a quote element with only an id, or the live session is gone |
| Slack | Events API, Socket Mode | Accepted IM, `app_mention`, or thread reply | Marker in the message text, else `msg:<channel id>:<ts>` | That string is bound to a live session | No marker. A later message in the same channel or thread has a different `ts`. A top-level channel `message` that is not an `app_mention` is ignored and gets no id |
| Telegram | Long polling, webhook, passive | Accepted private, group, or supergroup message | Marker in `text`/`caption`, `reply_to_message` text/caption, or `quote.text`, else `msg:<chat id>:<message_id>`. Forum topic id is not part of the id | That string is bound to a live session | No marker, or the live session is gone. Channel updates are dropped before an id is built |
| Discord | Gateway | DM, thread, or guild channel | Marker in the message or in `referenced_message.content`, else `msg:<message id>`. Auto-created threads do not replace this id | That string is bound to a live session | No marker, including a `message_reference` with no content, or the live session is gone |
| Discord | Interactions webhook | Command, component, or modal | Marker in the prompt or in `interaction.message.content`, else `msg:<interaction id>` | That string is bound to a live session | Each interaction without a marker, or the live session is gone |
| WhatsApp | Cloud API webhook | 1:1 or group | Marker in the message text, else `msg:<wamid>`. `messages[].context` is only `{from, id}` and is not fetched | That string is bound to a live session | No marker, including a swipe-reply, or the live session is gone |
| Any | Send | The context id already uses a platform prefix (`p2p:`, `group:`, `dm:`, `channel:`, `thread:`, `c2c:`, `direct:`, `app:`, `aibot:`, `webhook:`, `user:`). Inbound does not build these | The stored string. Send parses it as the recipient | The live session bound to that string | First bind of that string. A `msg:` id is not a recipient |
| Plugin | Any connector, outbound | Session has no context yet for this connector | UUID from `contextIdGenerator` (default `randomUUID()`) | Later sends on that session and connector | That first send. A custom generator, when configured, supplies the string instead |
| Plugin | Any connector, inbound | The connector's string is already bound to a live session | The stored `<connector name>--<contextId>` | That session. Two different message ids are two strings, even in the same chat | A different string opens another session |
| Plugin | Any connector, inbound | The string has no live session. A missing session is removed first | The connector's string, unchanged | The string stays the one the connector built | A new session bound to that same string |
| Plugin | Any connector, bind | The session already has a different context id for this connector, or this string is already bound to another session | The existing binding | The first id stays. The second bind is rejected | No id is created. `bind` throws |

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
