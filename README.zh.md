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

## 包

- `@dsh-connector/core`（`packages/connector-core`）：与宿主无关的连接器契约、无状态 `ConnectorContext`、上下文标记和错误类型。依赖 `zod` v4，不依赖 `dsh`。
- `dsh-connector-plugin`（`packages/dsh-connector-plugin`）：Cordis / `dsh` 插件。管理连接器生命周期、`SessionId` 与 `ConnectorContext` 的双向映射、Agent 工具和 HTTP Webhook。
- `@repo/typescript-config`、`@repo/eslint-config`：仓库内共享的 TypeScript 与 ESLint 配置。

开发命令见 [README.md](README.md) 的 Development 一节。
