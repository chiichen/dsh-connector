# dsh-connector

[English](README.md)

给 [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) 用的会话连接器，以及在 dsh 配置里运行它们的 `dsh-connector-plugin`。

插件启动已启用的连接器，把每条会话绑到一个 Agent session，注册发送工具，并把 HTTP 回调挂到 dsh 的 web 服务上。设置在 dsh 侧栏：账号 → 设置 → 连接器。

从本仓库的检出目录安装：

```sh
dsh plugin --profile <配置名> add <packages/dsh-connector-plugin 的绝对路径>
```

需要 Node.js `>=24.20.0`。

## 连接器

每一行是一种接入方式。✅ 表示用真实机器人凭据做过集成测试。⚠️ 表示还没有。单元测试通过不算真实集成测试。目前只有企业微信智能机器人长连接做过真实测试。Bot ID 和 Secret 不写进仓库。

设置为 `both` 或 `hybrid` 时，会同时打开该组里的两种方式。这些组合也没有做过真实集成测试。钉钉还可以把入站方式设为 `none`，此时不启动入站传输。

| 连接器 | 接入方式 | 入站 / 回调 | 真实集成测试 |
| --- | --- | --- | --- |
| 飞书 | [Webhook](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case) | HTTP 事件订阅 | ⚠️ 待测试 |
| 飞书 | [WebSocket](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case) | 长连接 | ⚠️ 待测试 |
| 微信 | [公众号回调](https://developers.weixin.qq.com/doc/service/guide/dev/push/) | HTTP 回调（`echostr` 与消息推送） | ⚠️ 待测试 |
| 微信 | iLink | HTTPS 长轮询 | ⚠️ 待测试 |
| 钉钉 | [Stream](https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description) | WebSocket 长连接 | ⚠️ 待测试 |
| 钉钉 | [Outgoing Webhook](https://open.dingtalk.com/document/orgapp/receive-message.md) | HTTP 回调 | ⚠️ 待测试 |
| 企业微信 | [自建应用](https://developer.work.weixin.qq.com/document/path/91039) | 应用消息接口。设置里这一项不含回调 Token。 | ⚠️ 待测试 |
| 企业微信 | [HTTP 回调](https://developer.work.weixin.qq.com/document/path/90930) | URL 校验与加密回调。智能机器人 HTTP 回调是同一项，receive id 为空（[机器人回调](https://developer.work.weixin.qq.com/document/path/100719)）。 | ⚠️ 待测试 |
| 企业微信 | [智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463) | WebSocket `wss://openws.work.weixin.qq.com/` | ✅ 已用真实机器人测过 |
| 企业微信 | [群机器人 Webhook](https://developer.work.weixin.qq.com/document/path/99110) | 仅出站（`cgi-bin/webhook/send`）。设置里没有单独的接入形式。 | ⚠️ 待测试 |
| QQ | [Webhook](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html) | HTTP 回调 | ⚠️ 待测试 |
| QQ | [WebSocket 网关](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) | 网关长连接 | ⚠️ 待测试 |
| Slack | [Events API](https://docs.slack.dev/apis/events-api/) | HTTP Webhook | ⚠️ 待测试 |
| Slack | [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) | WebSocket 长连接 | ⚠️ 待测试 |
| Telegram | [长轮询](https://core.telegram.org/bots/api#getupdates) | `getUpdates` | ⚠️ 待测试 |
| Telegram | [Webhook](https://core.telegram.org/bots/api#setwebhook) | HTTPS Webhook | ⚠️ 待测试 |
| Telegram | 被动接收 | 接受 HTTP，不主动调用 `setWebhook` | ⚠️ 待测试 |
| Discord | [Gateway](https://discord.com/developers/docs/events/gateway) | WebSocket v10 | ⚠️ 待测试 |
| Discord | [Interactions](https://discord.com/developers/docs/interactions/receiving-and-responding) | HTTP 互动回调 | ⚠️ 待测试 |
| WhatsApp | [Cloud API Webhook](https://developers.facebook.com/docs/graph-api/webhooks/getting-started) | GET 验证与 POST 通知 | ⚠️ 待测试 |

Discord 的 Gateway 和互动回调可以同时打开，不是互斥的接入形式。

## contextId

`contextId` 是连接器交给插件的字符串。插件把它存成 `<连接器名>--<contextId>`（`packages/dsh-connector-plugin/src/context-store.ts`）。同一对值在对应 session 还在时走同一个 dsh session。仓库里没有这条字符串时会新建 session。绑定的 session 已经不存在时，绑定会被删掉，同一条字符串会再开一个新 session。一个 session 对每个连接器只保留一个 `contextId`；再绑第二个会被拒绝，第一条保持不变。

入站按会话字段拼这串字。字段相同就得到同一串，所以这个会话里的下一条消息会复用它。单独成行的上下文标记会换成标记里的 id。标记是 `[#ctx:<id>]` 或 `<!-- dsh-ctx:<id> -->`（`packages/connector-core/src/context.ts`）。多行标记同时存在时，保留行首 `>` 最少的那一行。回复靠这个回到出站时先分配的 UUID。

某个 session 对这个连接器还没有 context 时，第一次出站会存一个 `randomUUID()` 生成的 UUID（`createDefaultContextIdGenerator`）。同一 session、同一连接器上之后的发送复用这个 UUID。UUID 不会被当成平台上的接收人，所以在绑上结构化 id 之前，发送仍要显式给出目标。

走同一个入站函数的两种接入方式共用一套公式。接收端丢掉的事件（自己发的消息、空文本、没通过群里 @ 规则的消息、不支持的事件类型）不会得到 `contextId`。

在字段拼接之前，按下面的顺序查标记：

- 飞书（[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)）：消息正文，然后用 `parent_id` 取到的父消息。`resolveReplyContextFromParent` 为 false 时不做父消息查询。查询失败或正文为空时，留下按字段拼出的 id。只有 `im.message.receive_v1` 会进入这套逻辑。
- 微信公众号：`Content`，语音则是 `Recognition`。没有引用查找。（[回调](https://developers.weixin.qq.com/doc/service/guide/dev/push/)）
- 微信 iLink：消息正文，然后引用文本。`context_token` 按用户缓存，不是 `contextId`。
- 钉钉（[Stream](https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description) 和 [Outgoing Webhook](https://open.dingtalk.com/document/orgapp/receive-message.md) 共用 `ingestRobotPayload`）：引用文本，然后正文。
- 企业微信入站（[应用回调](https://developer.work.weixin.qq.com/document/path/90930)、[机器人回调](https://developer.work.weixin.qq.com/document/path/100719)、[机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)）：引用文本，然后正文。
- QQ（[C2C](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)、[群](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)、[频道](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/event.html)）：引用消息元素，然后正文。
- Slack（[`message.im`](https://docs.slack.dev/reference/events/message.im)、[`app_mention`](https://docs.slack.dev/reference/events/app_mention/)、[`message`](https://docs.slack.dev/reference/events/message)）：当前消息正文，先做 Slack 实体解码。
- Telegram（[`Message`](https://core.telegram.org/bots/api#message)）：`text` 或 `caption`，然后 `reply_to_message` 的 `text` 或 `caption`。
- Discord Gateway（[`MESSAGE_CREATE`](https://discord.com/developers/docs/events/gateway-events#message-create)）：`referenced_message.content`，然后当前消息。
- Discord Interactions（[互动回调](https://discord.com/developers/docs/interactions/receiving-and-responding)）：`interaction.message.content`，然后本次输入的文本。
- WhatsApp（[Webhook 负载](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples)）：消息正文，然后用回复里的 `context.id` 查 `SentMessageTracker`（本进程发出去的消息 id）。这张表在内存里，条数达到 `DEFAULT_OUTBOUND_ECHO_CACHE_SIZE` 时丢掉最旧的一条。查不到就留下按字段拼出的 id。

| 连接器 | 接入方式 | 情况 | 拼成 | 何时复用 | 何时新建 |
| --- | --- | --- | --- | --- | --- |
| 飞书 | Webhook、WebSocket | 私聊，有 `open_id` | `p2p:<open_id>`，取 `sender.open_id` | 同一个 `open_id`，且没有标记胜出 | 另一个 `open_id`，或标记里的 id |
| 飞书 | Webhook、WebSocket | 私聊，没有 `open_id`，有 `user_id` | `p2p:user:<user_id>`，取 `sender.user_id` | 同一个 `user_id`，且没有标记胜出 | 另一个 `user_id`，或标记里的 id |
| 飞书 | Webhook、WebSocket | 私聊，只有 `chat_id` | `p2p:<chat_id>`，取 `chat_id` | 同一个 `chat_id`，且没有标记胜出 | 另一个 `chat_id`，或标记里的 id |
| 飞书 | Webhook、WebSocket | 群，没有 `thread_id` | `group:<chat_id>`，取 `chat_id` | 同一个 `chat_id`，且没有标记胜出 | 另一个群，或标记里的 id |
| 飞书 | Webhook、WebSocket | 群，有 `thread_id` | `group:<chat_id>:topic:<root>`，取 `chat_id` 和 `root_id`；没有 `root_id` 时用当前 `message_id` | 同一个群、同一个 root，且没有标记胜出 | 另一个 root，或标记里的 id |
| 飞书 | `buildFeishuConversationContextId` | 传入了 `thread_id`，没有传入根消息 id | `group:<chat_id>:thread:<thread_id>` | 同一个群、同一个 `thread_id` | 另一个 `thread_id`。入站总会带上 root，所以实际收到的话题消息走上一行 |
| 微信 | 公众号回调 | 一对一文本或语音 | `p2p:<FromUserName>` | 同一个 `FromUserName`，且正文里没有标记 | 另一个发送者，或标记里的 id |
| 微信 | iLink | 一对一消息 | `p2p:<from_user_id>` | 同一个 `from_user_id`，且正文和引用里都没有标记 | 另一个发送者，或标记里的 id |
| 钉钉 | Stream、Outgoing Webhook | 群，`conversationType` 为 `2` | `group:<conversationId>` | 同一个 `conversationId`，且没有标记胜出 | 另一个会话，或标记里的 id |
| 钉钉 | Stream、Outgoing Webhook | 单聊且有 `senderStaffId`。`conversationType` 不是 `2` 时都按单聊，包括缺省 | `p2p:<senderStaffId>` | 同一个 `senderStaffId`，且没有标记胜出 | 另一个 staff id，或标记里的 id |
| 钉钉 | Stream、Outgoing Webhook | 单聊且没有 `senderStaffId` | `p2p-id:<senderId>` | 同一个 `senderId`，且没有标记胜出 | 另一个 `senderId`，或标记里的 id |
| 钉钉 | 入站模式 `none` | 不启动入站 | 该 session 第一次发送时的插件 UUID | 同一 session、同一连接器上之后的发送 | 这个 session 还没有钉钉 context 时的第一次发送 |
| 企业微信 | HTTP 回调，XML | 单聊。没有 `ChatId`，因此算单聊 | `app:p2p:<FromUserName>` | 同一个 `FromUserName`，且没有标记胜出 | 另一个发送者，或标记里的 id |
| 企业微信 | HTTP 回调，XML | 群。有 `ChatId` | `app:group:<ChatId>` | 同一个 `ChatId`，且没有标记胜出 | 另一个群，或标记里的 id |
| 企业微信 | HTTP 回调 JSON、智能机器人长连接 | 群。`chattype` 为 `group` 且带了 `chatid` | `aibot:group:<chatid>` | 同一个 `chatid`，且没有标记胜出 | 另一个群，或标记里的 id |
| 企业微信 | HTTP 回调 JSON、智能机器人长连接 | 单聊，或群负载里没有 `chatid` | `aibot:p2p:<userid>`，取 `from.userid` | 同一个 userid，且没有标记胜出 | 另一个发送者，或标记里的 id |
| 企业微信 | 自建应用消息接口 | 这一项设置里没有回调，因此不在入站拼 id | 插件 UUID | 同一 session、同一连接器上之后的发送 | 这个 session 还没有企业微信 context 时的第一次发送 |
| 企业微信 | 群机器人 Webhook | 仅出站。发送参数里的 `webhookKey` 不会改写 id | 插件 UUID。session 已经绑着 `webhook:<key>` 时保持这串字，发送时把它解析成群机器人 key | 同一 session 上之后的发送，或同一个 `webhook:<key>` | 这个 session 还没有企业微信 context 时的第一次发送 |
| 企业微信 | 仅解析 | 已经存下来的 `p2p:<id>` 或 `group:<id>`。入站不会拼这两种前缀 | 按连接器的默认通道解读：没有应用配置、且配了回调或智能机器人时是 `aibot`，否则是 `app` | 已存的这串字 | 第一次把 session 绑到这串字 |
| QQ | Webhook、WebSocket 网关 | 单聊 `C2C_MESSAGE_CREATE` | `c2c:<openId>`，依次取作者的 `user_openid`、`member_openid`、`id` | 同一个 open id，且没有标记胜出 | 另一个作者，或标记里的 id |
| QQ | Webhook、WebSocket 网关 | 群 `GROUP_AT_MESSAGE_CREATE` | `group:<group_openid>` | 同一个 `group_openid`，且没有标记胜出 | 另一个群，或标记里的 id |
| QQ | Webhook、WebSocket 网关 | 频道 `AT_MESSAGE_CREATE`，有 `guild_id` | `channel:<guild_id>:<channel_id>` | 同一个频道服务器和子频道，且没有标记胜出 | 另一个服务器或子频道，或标记里的 id |
| QQ | Webhook、WebSocket 网关 | 频道 `AT_MESSAGE_CREATE`，没有 `guild_id` | `channel:<channel_id>` | 同一个 `channel_id`，且没有标记胜出 | 另一个子频道，或标记里的 id |
| Slack | Events API、Socket Mode | IM 里的 `message`（`channel_type` 为 `im`，或频道 id 以 `D` 开头），且没有合法的 `thread_ts` | `dm:<channelId>` | 同一个 IM 频道，且正文里没有标记 | 另一个频道，或标记里的 id |
| Slack | Events API、Socket Mode | IM 里的 `message`，带合法 `thread_ts` | `dm:<channelId>:<thread_ts>` | 同一个频道和 `thread_ts`，且正文里没有标记 | 另一个 thread，或标记里的 id |
| Slack | Events API、Socket Mode | IM 里的 `app_mention` | `dm:<channelId>:<thread_ts 或 ts>` | 同一个频道和这个时间戳，且正文里没有标记 | 另一条 `ts` 的提及，或标记里的 id。顶层提及用 `ts`，所以每条顶层提及各自一个 id |
| Slack | Events API、Socket Mode | 频道、群或 mpim 里的 `app_mention`。没有 `channel_type` 时，`D` 开头是 IM，`G` 开头是群，其余是频道。群和 mpim 仍然用 `channel:` 前缀 | `channel:<channelId>:<thread_ts 或 ts>` | 同一个频道和这个时间戳，且正文里没有标记 | 另一条 `ts` 的提及，或标记里的 id |
| Slack | Events API、Socket Mode | 频道、群或 mpim 里的 thread 回复（有 `thread_ts`，且和 `ts` 不同） | `channel:<channelId>:<thread_ts>` | 同一个频道和 `thread_ts`，且正文里没有标记 | 另一个 thread，或标记里的 id |
| Slack | Events API、Socket Mode | 频道、群或 mpim 里的顶层 `message`，且不是 `app_mention` | 不生成 `contextId`。这条事件被忽略 | 这次事件不存 id | 不新建 id。thread 回复走上一行 |
| Telegram | 长轮询、Webhook、被动接收 | `private` | `p2p:<chat.id>`；`message_thread_id` 是正的安全整数时再加 `:<message_thread_id>` | 同一个 chat 和 thread id，且没有标记胜出 | 另一个 chat 或 thread，或标记里的 id |
| Telegram | 长轮询、Webhook、被动接收 | `group` 或 `supergroup`。`is_topic_message` 不加一段 | `group:<chat.id>`；`message_thread_id` 是正的安全整数时再加 `:<message_thread_id>` | 同一个 chat 和 thread id，且没有标记胜出 | 另一个 chat 或 thread，或标记里的 id |
| Telegram | 格式化与解析 | 频道更新在拼 id 之前就被丢掉。`formatTelegramContextId` 仍可以拼出频道 id，并且不附加 thread id。解析时还接受 `direct:`（私聊）和 `supergroup:`（群）；格式化写出的是 `p2p:` 和 `group:` | 调用方格式化频道时为 `channel:<chatId>` | 已存的这串字 | 第一次绑定这串字 |
| Discord | Gateway | 私聊或群私聊（没有 `guild_id`，或频道类型是 DM / group DM） | `dm:<channel_id>` | 同一个频道，且没有标记胜出 | 另一个频道，或标记里的 id |
| Discord | Gateway | thread（公告、公开或私密），且拿到了父频道 id | `thread:<parent_id>:<thread_id>` | 同一个父频道和 thread，且没有标记胜出 | 另一个 thread，或标记里的 id |
| Discord | Gateway | thread，父频道 id 没有取到 | `thread:<thread_id>` | 同一个 thread id，且没有标记胜出 | 另一个 thread，或标记里的 id |
| Discord | Gateway | 其他服务器频道 | `channel:<channel_id>` | 同一个频道，且没有标记胜出 | 另一个频道，或标记里的 id |
| Discord | Gateway | 打开了 `autoCreateThreadOnMention`（默认关），消息在服务器频道里，且没有标记 | 建出 thread 之后：`thread:<原来的 channel_id>:<新 thread id>`。创建失败则仍是 `channel:<channel_id>` | 之后的消息走这个新 thread | 每次创建成功都会新建，因为 thread id 是新的 |
| Discord | Interactions Webhook | 互动所在的私聊、thread 或服务器频道。这条路径不会自动建 thread | 与 Gateway 相同的 `dm:` / `thread:` / `channel:`，频道取自本次互动 | 同一个频道或 thread，且没有标记胜出 | 另一个频道或 thread，或标记里的 id |
| Discord | 发送时解析 | `user:<用户 snowflake>` 可以作为发送目标。入站不会分配它 | 这串字已经是 context 时为 `user:<userId>` | 已存的这串字 | 第一次绑定这串字 |
| WhatsApp | Cloud API Webhook | 一对一。没有 `group_id` | `direct:<wa_id>`，取联系人 `wa_id`；联系人没有 `wa_id` 时用 `from`。只做 trim，不去掉非数字字符 | 最终字符串已经绑定：没有标记且追踪表未命中时是这条 `wa_id`；wamid 还在缓存里时是当时发出去的那个 id | 另一个 `wa_id`、标记里的 id，或会话表里还没有的追踪 id |
| WhatsApp | Cloud API Webhook | 群。有 `group_id` | `group:<group_id>` | 最终字符串已经绑定：没有标记且追踪表未命中时是这条 `group_id`；wamid 还在缓存里时是当时发出去的那个 id | 另一个群、标记里的 id，或会话表里还没有的追踪 id |
| WhatsApp | 发送时解析 | `p2p:<id>` 可以作为一对一接收人。入站写出的是 `direct:` | 已存的 `p2p:` 字符串 | 已存的这串字 | 第一次绑定这串字 |
| 插件 | 任意连接器，出站 | 这个 session 对当前连接器还没有 context | `contextIdGenerator` 给出的 UUID（默认 `randomUUID()`） | 同一 session、同一连接器上之后的发送 | 这一次首次发送。配置了自定义 generator 时，由它给出字符串 |
| 插件 | 任意连接器，入站 | 连接器给出的字符串已经绑在一个还活着的 session 上 | 已存的 `<连接器名>--<contextId>` | 那个 session | 另一串字会打开另一个 session |
| 插件 | 任意连接器，入站 | 这串字没有活着的 session。已经消失的 session 会先被删掉 | 连接器给出的字符串，保持原样 | `contextId` 仍是连接器给出的那一串 | 新建一个 session，并绑上同一串字 |
| 插件 | 任意连接器，绑定 | 这个 session 对当前连接器已经有另一个 `contextId`，或这串字已经绑在别的 session 上 | 已有的绑定 | 第一条保持不变。第二次绑定被拒绝 | 不新建 id。`bind` 抛错 |

按字段拼出来的 id 来自 `buildFeishuConversationContextId`、`formatWeixinP2pContextId`、`formatDingTalkP2PContextId` / `formatDingTalkEncryptedP2PContextId` / `formatDingTalkGroupContextId`、`formatWeComContextId`、`formatQqContextId`、`formatSlackContextId`、`formatTelegramContextId`、`formatDiscordDmContextId` / `formatDiscordThreadContextId` / `formatDiscordChannelContextId` / `formatDiscordUserContextId`、`formatWhatsAppContextId`。

## 与 dsh 的版本兼容性

`engines.dsh` 是 `>=0.2.2-rc.2 <0.2.3-0`。下界是 `pnpm --filter dsh-connector-plugin run test:dsh-host` 两项都通过的最早已发布版本。上界排除了设置页客户端失败的 `0.2.3-alpha.1` 和 `0.2.3-alpha.2`。`peerDependencies` 仍是 `>=0.2.2-0 <0.3.0`，没有改。

每一行都把全部 `@deepseek-ai/dsh-*` 开发依赖装成同一个版本，再跑 `tests/client-host.test.ts`。客户端用例通过 `@deepseek-ai/dsh-client-modules` 加载设置页包。服务端用例在 Cordis 上激活插件。表里没有的版本没有跑过。

| dsh | 设置页客户端 | 服务端插件 |
| --- | --- | --- |
| 0.2.1-rc.5 | ❌ 无法导入 `@deepseek-ai/dsh-client-modules/src/client/index.ts` | ❌ `@deepseek-ai/dsh-tools` 的 `ToolsService` 不是 Cordis 插件 |
| 0.2.2-alpha.2 | ❌ 同样找不到客户端入口 | ✅ |
| 0.2.2-alpha.3 | ❌ 同样找不到客户端入口 | ✅ |
| 0.2.2-rc.1 | ❌ 同样找不到客户端入口 | ✅ |
| 0.2.2-rc.2 | ✅ | ✅ |
| 0.2.2-rc.3 | ✅ | ✅ |
| 0.2.2-rc.4 | ✅ | ✅ |
| 0.2.2-rc.5 | ✅ | ✅ |
| 0.2.3-alpha.1 | ❌ `options.staticModules is not iterable` | ✅ |
| 0.2.3-alpha.2 | ❌ `options.staticModules is not iterable` | ✅ |

两项都通过的最早版本是 **0.2.2-rc.2**。

## 包

- `@dsh-connector/core`（`packages/connector-core`）：与宿主无关的连接器契约、无状态 `ConnectorContext`、上下文标记和错误类型。依赖 `zod` v4，不依赖 `dsh`。
- `dsh-connector-plugin`（`packages/dsh-connector-plugin`）：Cordis / `dsh` 插件。管理连接器生命周期、`SessionId` 与 `ConnectorContext` 的双向映射、Agent 工具和 HTTP Webhook。
- `@repo/typescript-config`、`@repo/eslint-config`：仓库内共享的 TypeScript 与 ESLint 配置。

开发命令见 [README.md](README.md) 的 Development 一节。
