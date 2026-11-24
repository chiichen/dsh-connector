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
