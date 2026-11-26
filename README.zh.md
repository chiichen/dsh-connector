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

## Context ID

`contextId` 是连接器交给插件的字符串。插件把它存成 `<连接器名>--<contextId>`（`packages/dsh-connector-plugin/src/context-store.ts`）。这一对只在会话还活着时回到同一个 dsh 会话。没有存活会话的字符串会新开一个会话。绑定的会话消失后，绑定删掉，同一个字符串再来会新开一个会话。一个会话对每个连接器只保留一个 `contextId`；再绑第二个会被拒绝，第一个保持不变。

单聊和群聊用同一条规则。唯一会复用已有会话的情况，是入站 payload 里已经带有可提取的 Context ID：在本条正文里，或者在 payload 已经带回的引用原文里。标记形式是 `[#ctx:<id>]` 或 `<!-- dsh-ctx:<id> -->`（`packages/connector-core/src/context.ts`）。有多行标记时，保留开头 `>` 最少的那一行。正文里的标记优先于只出现在引用里的标记。引用若只给消息 id、不带回原文，就不复用。连接器不会再去拉历史把原文找回来。

抽不出标记时，context id 是 `msg:` 加上这条入站消息自己的 id（`@dsh-connector/core` 里的 `MESSAGE_CONTEXT_ID_PREFIX`）。每次发送、每次艾特都是新的 id。同一个聊天、thread、话题里的下一条消息不会并进去。Slack 的 id 是 `msg:<channel id>:<ts>`，因为 Slack 的时间戳只在频道内唯一。Telegram 的 id 是 `msg:<chat id>:<message id>`，因为 Telegram 的消息 id 只在聊天内唯一。其余入站 id 都是 `msg:` 加上平台消息 id。

发出的正文默认带上这个标记，除非这次发送关掉它（`contextMarker` 为 `never` 或 `none`，或 `includeContextMarker: false`）。对方以后引用时才能抽出来。飞书、Slack、QQ、企微、钉钉、微信、WhatsApp、Discord 用方括号。Telegram 用 HTML 注释。默认是打开的。

接收器丢掉的事件（自己的消息、空文本、没通过群艾特规则的消息、不支持的类型）不会得到 context id。本来没有入站消息 id 的接入方式，继续用插件在这次发送时生成的 UUID，发出的正文仍然带上这个 id。

已经是平台前缀的 id（`p2p:`、`group:`、`dm:`、`channel:`、`thread:`、`c2c:`、`direct:`、`app:`、`aibot:`、`webhook:`、`user:`）仍然会按收件人解析。入站代码不再拼这些前缀。`msg:` 不是收件人，所以在这个会话里回复时，需要显式目标、按这个 id 缓存的 session webhook 或 `response_url`，或者更早绑上的结构化 id。

入站 payload 里已经带原文的引用：钉钉 `text.repliedMsg.content`；企微 `quote` 的文本、语音和混合消息；QQ 引用元素的 `content`；微信 iLink 的 `ref_msg` 文本或标题；Slack 的正文（引用写在正文里）；Telegram 的 `reply_to_message` 文本或说明，以及 `quote.text`；Discord Gateway 的 `referenced_message.content`；Discord Interactions 的 `interaction.message.content`。

只给 id、因此这条消息得到新的 `msg:` id：飞书的 `parent_id` 和 `root_id`；WhatsApp 的 `messages[].context.id`；Discord 的 `message_reference` 在没有 `referenced_message.content` 时；Slack 的 `thread_ts` 在正文没有标记时；微信公众号没有引用字段；QQ、iLink、钉钉的引用对象只有 id、没有文本时。

| 连接器 | 接入方式 | 情况 | 拼成 | 何时复用 | 何时新建 |
| --- | --- | --- | --- | --- | --- |
| 飞书 | Webhook、WebSocket | 任何接受的 `im.message.receive_v1`，单聊或群聊 | 事件正文里的标记，否则 `msg:<message_id>` | 这个字符串已经绑在存活会话上 | 没有标记，或这个字符串的存活会话没了。不读取 `parent_id` |
| 微信 | 公众号回调 | 单聊文本或语音 | `Content` 或语音 `Recognition` 里的标记，否则 `msg:<MsgId>`。没有 `MsgId` 时用 `msg:<FromUserName>:<CreateTime>` | 这个字符串已经绑在存活会话上 | 没有标记，或存活会话没了 |
| 微信 | iLink | 单聊消息 | 正文或 `ref_msg` 文本/标题里的标记，否则 `msg:<message_id>`；没有 `message_id` 时用 `msg:<client_id>`。`context_token` 不是 context id | 这个字符串已经绑在存活会话上 | 没有标记，包括只有 id 的引用，或存活会话没了 |
| 钉钉 | Stream、Outgoing webhook | 任何接受的机器人消息，单聊或群聊 | 正文或 `text.repliedMsg.content` 里的标记，否则 `msg:<msgId>`（Stream 退回到回调 message id）。两个 id 都没有时，有标记仍用标记，否则是 `allocateContextId()` 的原始 UUID | 这个字符串已经绑在存活会话上。按这个 id 缓存的 session webhook 就是回复通道 | 没有标记，或存活会话没了 |
| 钉钉 | 入站模式 `none` | 没有入站传输 | 第一次发送时的插件 UUID。发出的正文仍带标记 | 同一会话、同一连接器上的后续发送 | 这个会话还没有钉钉 context 时的第一次发送 |
| 企微 | HTTP 回调，XML | 单聊或群聊的应用回调 | 正文或引用里的标记，否则 `msg:<MsgId>`。没有 `MsgId` 时用 `msg:<FromUserName>:<CreateTime>` | 这个字符串已经绑在存活会话上 | 没有标记，或存活会话没了 |
| 企微 | HTTP 回调 JSON、智能机器人长连接 | 单聊或群聊的智能机器人消息 | 正文或引用里的标记，否则 `msg:<msgid>`。没有 `msgid` 时用 `msg:<userid>:<当前时间>` | 这个字符串已经绑在存活会话上。按这个 id 缓存的 `response_url` 就是回复通道 | 没有标记，或存活会话没了 |
| 企微 | 自建应用消息 API | 这个设置表单没有回调 | 插件 UUID。发出的正文仍带标记 | 同一会话、同一连接器上的后续发送 | 这个会话还没有企微 context 时的第一次发送 |
| 企微 | 群机器人 Webhook | 只出站 | 插件 UUID。发出的正文仍带标记。会话已经绑着 `webhook:<key>` 时保持这个字符串，发送时把它解析成群机器人 key | 同一会话上的后续发送，或同一个 `webhook:<key>` | 这个会话还没有企微 context 时的第一次发送 |
| QQ | Webhook、WebSocket 网关 | 单聊、群或频道 | 正文或引用元素 `content` 里的标记，否则 `msg:<消息 id>` | 这个字符串已经绑在存活会话上 | 没有标记，包括只有 id 的引用元素，或存活会话没了 |
| Slack | Events API、Socket Mode | 接受的私聊、`app_mention` 或 thread 回复 | 正文里的标记，否则 `msg:<channel id>:<ts>` | 这个字符串已经绑在存活会话上 | 没有标记。同一频道或 thread 里的下一条消息有不同的 `ts`。不是 `app_mention` 的频道顶层 `message` 会被忽略，没有 id |
| Telegram | 长轮询、Webhook、被动接收 | 接受的私聊、群或超级群消息 | `text`/`caption`、`reply_to_message` 的文本/说明，或 `quote.text` 里的标记，否则 `msg:<chat id>:<message_id>`。论坛话题 id 不进这个 id | 这个字符串已经绑在存活会话上 | 没有标记，或存活会话没了。频道更新在拼 id 之前就丢掉 |
| Discord | Gateway | 私聊、thread 或服务器频道 | 消息正文或 `referenced_message.content` 里的标记，否则 `msg:<message id>`。自动创建的 thread 不替换这个 id | 这个字符串已经绑在存活会话上 | 没有标记，包括没有正文的 `message_reference`，或存活会话没了 |
| Discord | 互动回调 | 命令、组件或弹窗 | 提示文本或 `interaction.message.content` 里的标记，否则 `msg:<interaction id>` | 这个字符串已经绑在存活会话上 | 没有标记的每次互动，或存活会话没了 |
| WhatsApp | Cloud API Webhook | 单聊或群 | 正文里的标记，否则 `msg:<wamid>`。`messages[].context` 只有 `{from, id}`，不会去拉原文 | 这个字符串已经绑在存活会话上 | 没有标记，包括滑动回复，或存活会话没了 |
| 任意 | 发送 | context id 已经是平台前缀（`p2p:`、`group:`、`dm:`、`channel:`、`thread:`、`c2c:`、`direct:`、`app:`、`aibot:`、`webhook:`、`user:`）。入站不再拼这些前缀 | 存下来的字符串。发送时把它解析成收件人 | 绑着这个字符串的存活会话 | 第一次绑上这个字符串。`msg:` 不是收件人 |
| 插件 | 任意连接器，出站 | 这个会话还没有该连接器的 context | `contextIdGenerator` 的 UUID（默认 `randomUUID()`） | 同一会话、同一连接器上的后续发送 | 那一次首次发送。配置了自定义生成器时，由它提供字符串 |
| 插件 | 任意连接器，入站 | 连接器给出的字符串已经绑在存活会话上 | 存下来的 `<连接器名>--<contextId>` | 那个会话。两个不同的消息 id 是两个字符串，即使在同一个聊天里 | 不同的字符串会另开会话 |
| 插件 | 任意连接器，入站 | 这个字符串没有存活会话。缺失的会话会先删掉绑定 | 连接器给出的字符串，不改写 | 字符串保持连接器拼出来的那个 | 用同一个字符串新开一个会话 |
| 插件 | 任意连接器，绑定 | 这个会话对该连接器已经有另一个 context id，或这个字符串已经绑在别的会话上 | 已有的绑定 | 第一个 id 保持。第二次绑定被拒绝 | 不会新建 id。`bind` 抛错 |

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
