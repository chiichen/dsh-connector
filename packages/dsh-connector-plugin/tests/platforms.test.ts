import { ConnectorValidationError, defineConnector, type Connector } from "@dsh-connector/core";
import { describe, expect, it } from "vitest";
import {
  Config,
  createConnectorPlugin,
  createConnectorsFromPlatformConfig,
  DefaultContextSessionStore,
  mergePlatformConfigs,
  mountConnectorPlugin,
} from "../src";
import { PLATFORM_CATALOG, fieldIsVisible } from "../src/platforms/catalog";
import { requireString } from "../src/platforms/instantiate";
import {
  getPath,
  readBoolean,
  readChoice,
  readId,
  readNumber,
  readString,
  readStringList,
  setPath,
} from "../src/platforms/records";
import type { PlatformRecord, PlatformsConfig } from "../src/platforms/types";
import { preparePlatformSave, sanitizePlatformSettings } from "../src/platforms/validate";
import { MockGithubPrConnector } from "./mocks/mock-connectors";
import { TestDshHost } from "./mocks/mock-dsh-host";

const WEIXIN_ENCODING_AES_KEY = "A".repeat(43);
const SLACK_BOT_TOKEN = "xoxb-1234567890";
const SLACK_APP_TOKEN = "xapp-1234567890";

function connectorNamed(connectors: readonly Connector[], name: string): Connector {
  const found = connectors.find((connector) => connector.name === name);
  if (found === undefined) throw new Error(`Missing connector ${name}`);
  return found;
}

const minimalPlatforms: PlatformsConfig = {
  feishu: { enabled: true, appId: "cli_test", appSecret: "feishu-secret" },
  weixin: { enabled: true, appId: "wx_test", token: "weixin-token" },
  dingtalk: { enabled: true },
  wecom: { enabled: true },
  qq: { enabled: true, appId: "qq-app", clientSecret: "qq-secret" },
  slack: { enabled: true, botToken: SLACK_BOT_TOKEN },
  telegram: { enabled: true, botToken: "123456:telegram" },
  discord: { enabled: true, publicKey: "discord-public-key" },
  whatsapp: { enabled: true, accessToken: "wa-token", phoneNumberId: "100" },
};

const fullPlatforms: PlatformsConfig = {
  feishu: {
    enabled: true,
    appId: " cli_full ",
    appSecret: "feishu-secret",
    domain: "lark",
    verificationToken: "verify",
    encryptKey: "encrypt",
    mode: "webhook",
    botOpenId: "ou_bot",
    botName: "Bot",
    allowedOpenIds: ["ou_user"],
    groupMentionPolicy: "all",
    allowAtAllInGroup: false,
    resolveBotInfoOnStart: false,
    resolveReplyContextFromParent: false,
    contextMarker: "never",
    defaultOutboundFormat: "markdown",
  },
  weixin: {
    enabled: true,
    mode: "official-account",
    appId: "wx_full",
    token: "token",
    appSecret: "secret",
    encodingAesKey: WEIXIN_ENCODING_AES_KEY,
    accountId: "gh_account",
    accessToken: "access",
    tokenStrategy: "classic",
    apiBaseUrl: "https://api.example.test",
    kfAccount: "kf@account",
    businessId: "biz",
    allowedSenderIds: ["user-1"],
  },
  dingtalk: {
    enabled: true,
    clientId: "ding-client",
    clientSecret: "ding-secret",
    robotCode: "robot",
    coolAppCode: "cool",
    webhookSigningSecret: "sign",
    outgoingToken: "outgoing",
    inboundMode: "webhook",
    preferSessionWebhook: true,
    defaultFormat: "markdown",
    requireAtInGroup: true,
    botUserIds: ["bot-user"],
    botStaffIds: ["staff"],
    apiBaseUrl: "https://api.dingtalk.example",
  },
  wecom: {
    enabled: true,
    app: {
      corpId: "wwcorp",
      corpSecret: "corp-secret",
      agentId: "100",
      apiBaseUrl: "https://qyapi.example",
      enableDuplicateCheck: true,
      duplicateCheckIntervalSeconds: 600,
    },
    callback: { token: "cb-token", encodingAesKey: WEIXIN_ENCODING_AES_KEY, receiveId: "wwcorp" },
    selfUserIds: ["self"],
    botMentionNames: ["bot"],
    requireMentionInGroup: true,
    includeContextMarkerByDefault: false,
    inboundDeliveryMode: "steer",
  },
  qq: {
    enabled: true,
    appId: "qq-app",
    clientSecret: "qq-secret",
    botUserId: "bot",
    sandbox: true,
    transport: "webhook",
    apiBaseUrl: "https://qq.example",
    tokenUrl: "https://qq.example/token",
    gatewayUrl: "wss://qq.example",
    defaultFormat: "markdown",
    includeContextMarker: true,
    autoPassiveReply: false,
    fallbackToPlainOnMarkdownReject: false,
  },
  slack: {
    enabled: true,
    botToken: SLACK_BOT_TOKEN,
    signingSecret: "slack-signing",
    appToken: SLACK_APP_TOKEN,
    mode: "hybrid",
    botUserId: "U123",
    appId: "A123",
    apiBaseUrl: "https://slack.example",
    threadReplyPolicy: "mention-only",
    deliveryMode: "steer",
    includeContextMarker: false,
    ignoreHttpRetries: true,
    sanitizeBroadcastMentions: false,
    verifyAuthOnStart: false,
  },
  telegram: {
    enabled: true,
    botToken: "123456:telegram",
    mode: "webhook",
    webhookSecretToken: "webhook-secret",
    requireWebhookSecretToken: true,
    apiBaseUrl: "https://telegram.example",
    botId: 42,
    botUsername: "connector_bot",
    groupTriggerMode: "all",
    allowedChatIds: ["10"],
    allowedUserIds: ["20"],
    acceptEditedMessages: true,
    inboundDeliveryMode: "queue",
    includeContextMarker: true,
  },
  discord: {
    enabled: true,
    botToken: "discord-bot",
    publicKey: "discord-public-key",
    botUserId: "999",
    enableGateway: false,
    gatewayUrl: "wss://discord.example",
    apiBaseUrl: "https://discord.example/api",
    ignoreBotMessages: false,
    requireMentionInGuild: false,
    autoCreateThreadOnMention: true,
    autoArchiveDurationMinutes: "1440",
    includeContextMarker: true,
  },
  whatsapp: {
    enabled: true,
    accessToken: "wa-token",
    phoneNumberId: "100",
    businessPhoneNumber: "15550001111",
    verifyToken: "verify",
    appSecret: "wa-secret",
    allowUnsignedWebhooks: false,
    apiBaseUrl: "https://graph.example",
    apiVersion: "v21.0",
    allowedSenders: ["15550002222"],
  },
};

describe("platform settings", () => {
  it("lists only options the connectors read", () => {
    const keys = PLATFORM_CATALOG.flatMap((platform) => platform.fields.map((field) => field.key));
    expect(keys).toEqual(
      expect.arrayContaining([
        "appId",
        "appSecret",
        "botToken",
        "clientId",
        "clientSecret",
        "accessToken",
        "phoneNumberId",
        "publicKey",
        "app.corpId",
        "callback.token",
        "aibotWs.botId",
      ]),
    );
    for (const forbidden of [
      "fetchFn",
      "createWebSocket",
      "streaming",
      "streamingAdapter",
      "logger",
      "now",
      "sleepFn",
      "randomFn",
      "accessTokenProvider",
      "onUpdatesBufChange",
      "shard",
      "intents",
      "defaultAllowedMentions",
      "contextMarkerStyle",
      "polling",
      "name",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    const weixinAppId = PLATFORM_CATALOG.find((platform) => platform.id === "weixin")?.fields.find(
      (field) => field.key === "appId",
    );
    const feishuAppId = PLATFORM_CATALOG.find((platform) => platform.id === "feishu")?.fields.find(
      (field) => field.key === "appId",
    );
    if (weixinAppId === undefined || feishuAppId === undefined) {
      throw new Error("missing catalog fields");
    }
    expect(fieldIsVisible("weixin", weixinAppId, {})).toBe(true);
    expect(fieldIsVisible("weixin", weixinAppId, { mode: " ilink " })).toBe(false);
    expect(fieldIsVisible("feishu", feishuAppId, { mode: "webhook" })).toBe(true);
  });

  it("reads, writes, and sanitizes platform records", () => {
    const record = setPath(
      setPath({ enabled: true }, "app.corpId", "ww"),
      "app.corpSecret",
      "secret",
    );
    expect(getPath(record, "app.corpId")).toBe("ww");
    expect(setPath(record, "app.corpSecret", undefined)).toEqual({
      enabled: true,
      app: { corpId: "ww" },
    });
    expect(setPath(record, "app", undefined)).toEqual({ enabled: true });
    expect(setPath({ enabled: true }, "", "ignored")).toEqual({ enabled: true });
    expect(getPath(undefined, "appId")).toBeUndefined();
    expect(readString({ appId: "  cli  " }, "appId")).toBe("cli");
    expect(readString({ appId: 1 }, "appId")).toBeUndefined();
    expect(readString({ appId: "   " }, "appId")).toBeUndefined();
    expect(() => requireString({}, "appId", "feishu")).toThrow(ConnectorValidationError);
    expect(requireString({ appId: "cli" }, "appId", "feishu")).toBe("cli");
    expect(readBoolean({ enabled: false }, "enabled")).toBe(false);
    expect(readBoolean({ flag: "yes" }, "flag")).toBeUndefined();
    expect(readNumber({ botId: 0 }, "botId")).toBe(0);
    expect(readNumber({ botId: Number.NaN }, "botId")).toBeUndefined();
    expect(readId({ agentId: 7 }, "agentId")).toBe(7);
    expect(readId({ agentId: " 8 " }, "agentId")).toBe("8");
    expect(readStringList({ ids: [" a ", "", 1] }, "ids")).toEqual(["a"]);
    expect(readStringList({ ids: "nope" }, "ids")).toBeUndefined();
    expect(readStringList({ ids: ["  "] }, "ids")).toBeUndefined();
    expect(readChoice({ mode: "webhook" }, "mode", ["webhook", "socket"] as const)).toBe("webhook");
    expect(readChoice({ mode: "nope" }, "mode", ["webhook"] as const)).toBeUndefined();

    expect(
      sanitizePlatformSettings({
        feishu: {
          enabled: false,
          appId: "  cli  ",
          appSecret: "   ",
          allowedOpenIds: [" ou ", ""],
          fetchFn: "nope",
        },
        telegram: { enabled: true, botToken: "123:abc", botId: 0, includeContextMarker: false },
        slack: "nope" as unknown as PlatformRecord,
      }),
    ).toEqual({
      feishu: { enabled: false, appId: "cli", allowedOpenIds: ["ou"] },
      telegram: { enabled: true, botToken: "123:abc", botId: 0, includeContextMarker: false },
    });
  });

  it("rejects enabled platforms that are missing the credentials their constructors require", () => {
    expect(preparePlatformSave({ feishu: { enabled: true, appId: "cli" } }).ok).toBe(false);
    expect(preparePlatformSave({ feishu: { enabled: false } })).toEqual({
      ok: true,
      platforms: { feishu: { enabled: false } },
    });
    expect(() =>
      createConnectorsFromPlatformConfig({ feishu: { enabled: true, appId: "cli" } }),
    ).toThrow(/feishu requires appSecret/);
    expect(() =>
      createConnectorsFromPlatformConfig({ weixin: { enabled: true, mode: "ilink" } }),
    ).toThrow(/weixin requires botToken/);
    expect(() =>
      createConnectorsFromPlatformConfig({ weixin: { enabled: true, appId: "wx" } }),
    ).toThrow(/weixin requires token/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        weixin: { enabled: true, mode: "sms", appId: "wx", token: "t" },
      }),
    ).toThrow(/mode must be one of/);
    expect(() =>
      createConnectorsFromPlatformConfig({ qq: { enabled: true, appId: "qq" } }),
    ).toThrow(/qq requires clientSecret/);
    expect(() =>
      createConnectorsFromPlatformConfig({ whatsapp: { enabled: true, accessToken: "wa" } }),
    ).toThrow(/whatsapp requires phoneNumberId/);
    expect(() => createConnectorsFromPlatformConfig({ discord: { enabled: true } })).toThrow(
      /discord requires botToken or publicKey/,
    );
    expect(() =>
      createConnectorsFromPlatformConfig({
        discord: { enabled: true, publicKey: "pk", enableGateway: true },
      }),
    ).toThrow(/discord requires botToken when enableGateway is true/);
    expect(() =>
      createConnectorsFromPlatformConfig({ slack: { enabled: true, botToken: "not-a-token" } }),
    ).toThrow(/xoxb-/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        slack: { enabled: true, botToken: SLACK_BOT_TOKEN, appToken: "nope", mode: "socket" },
      }),
    ).toThrow(/xapp-/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        slack: { enabled: true, botToken: SLACK_BOT_TOKEN, mode: "socket" },
      }),
    ).toThrow(/requires appToken/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        slack: { enabled: true, botToken: SLACK_BOT_TOKEN, mode: "webhook" },
      }),
    ).toThrow(/requires signingSecret/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        telegram: { enabled: true, botToken: "1:t", webhookSecretToken: "bad secret" },
      }),
    ).toThrow(/webhookSecretToken/);
    expect(() =>
      createConnectorsFromPlatformConfig({ wecom: { enabled: true, app: { corpId: "ww" } } }),
    ).toThrow(/wecom app requires/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        wecom: { enabled: true, callback: { receiveId: "ww" } },
      }),
    ).toThrow(/wecom callback requires/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        wecom: { enabled: true, aibotWs: { wsUrl: "wss://example" } },
      }),
    ).toThrow(/wecom aibotWs requires/);
    expect(() =>
      createConnectorsFromPlatformConfig({ feishu: { enabled: true, appId: 1, appSecret: "s" } }),
    ).toThrow(/appId must be a string/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        feishu: { enabled: true, appId: "cli", appSecret: "s", allowedOpenIds: "ou" },
      }),
    ).toThrow(/allowedOpenIds must be a list of strings/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        telegram: { enabled: true, botToken: "1:t", botId: "42" },
      }),
    ).toThrow(/botId must be a number/);
    expect(() =>
      createConnectorsFromPlatformConfig({
        feishu: { enabled: "yes" } as unknown as PlatformRecord,
      }),
    ).toThrow(/enabled must be a boolean/);
    expect(() =>
      createConnectorsFromPlatformConfig({ feishu: [] as unknown as PlatformRecord }),
    ).toThrow(/feishu settings must be an object/);
    expect(createConnectorsFromPlatformConfig(undefined)).toEqual([]);
    expect(
      createConnectorsFromPlatformConfig({ feishu: { enabled: false, appId: "cli" } }),
    ).toEqual([]);
  });

  it("constructs each enabled connector from the options that connector reads", () => {
    const minimal = createConnectorsFromPlatformConfig(minimalPlatforms);
    expect(minimal.map((connector) => connector.name).sort()).toEqual([
      "dingtalk",
      "discord",
      "feishu",
      "qq",
      "slack",
      "telegram",
      "wecom",
      "weixin",
      "whatsapp",
    ]);
    expect(connectorNamed(minimal, "discord").getSender()).toBeUndefined();
    expect(connectorNamed(minimal, "wecom").getReceiver()).toBeUndefined();
    expect(connectorNamed(minimal, "dingtalk").getReceiver()).toBeDefined();
    expect((connectorNamed(minimal, "slack") as Connector & { mode: string }).mode).toBe("webhook");
    expect(
      (connectorNamed(minimal, "telegram") as Connector & { getMode(): string }).getMode(),
    ).toBe("polling");

    const prepared = preparePlatformSave(fullPlatforms);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const full = createConnectorsFromPlatformConfig(prepared.platforms);
    expect((connectorNamed(full, "slack") as Connector & { mode: string }).mode).toBe("hybrid");
    expect((connectorNamed(full, "weixin") as Connector & { mode: string }).mode).toBe(
      "official-account",
    );
    expect((connectorNamed(full, "telegram") as Connector & { getMode(): string }).getMode()).toBe(
      "webhook",
    );
    expect(connectorNamed(full, "discord").getSender()).toBeDefined();
    expect(connectorNamed(full, "dingtalk").getReceiver()).toBeDefined();
    expect(connectorNamed(full, "wecom").getReceiver()).toBeDefined();
    expect(
      (connectorNamed(full, "wecom") as Connector & { getWsClient(): unknown }).getWsClient(),
    ).toBeUndefined();

    const ilink = createConnectorsFromPlatformConfig({
      weixin: {
        enabled: true,
        mode: "ilink",
        botToken: "ilink-token",
        baseUrl: "https://ilink.example",
      },
    });
    expect((connectorNamed(ilink, "weixin") as Connector & { mode: string }).mode).toBe("ilink");

    const withSocket = createConnectorsFromPlatformConfig({
      wecom: {
        enabled: true,
        aibotWs: { botId: "bot", secret: "secret", wsUrl: "wss://wecom.example" },
      },
      dingtalk: { enabled: true, inboundMode: "none" },
    });
    expect(
      (connectorNamed(withSocket, "wecom") as Connector & { getWsClient(): unknown }).getWsClient(),
    ).toBeDefined();
    expect(connectorNamed(withSocket, "dingtalk").getReceiver()).toBeUndefined();
  });

  it("merges platform overrides without dropping sibling platforms or credential groups", () => {
    expect(mergePlatformConfigs(undefined, { qq: { enabled: false } })).toEqual({
      qq: { enabled: false },
    });
    expect(mergePlatformConfigs({ qq: { enabled: false } }, undefined)).toEqual({
      qq: { enabled: false },
    });
    expect(
      mergePlatformConfigs(
        {
          wecom: {
            enabled: true,
            app: { corpId: "ww", corpSecret: "old", agentId: "1" },
            selfUserIds: ["a"],
          },
        },
        {
          wecom: { app: { corpSecret: "new" }, selfUserIds: ["b"] },
          telegram: { enabled: false },
        },
      ),
    ).toEqual({
      wecom: {
        enabled: true,
        app: { corpId: "ww", corpSecret: "new", agentId: "1" },
        selfUserIds: ["b"],
      },
      telegram: { enabled: false },
    });
    expect(
      mergePlatformConfigs(
        { feishu: { enabled: true, appId: "cli" } },
        { feishu: null as unknown as PlatformRecord },
      )?.feishu,
    ).toBeNull();
  });

  it("keeps platform credentials in the plugin config schema", () => {
    const resolved = Config({
      platforms: {
        telegram: { enabled: true, botToken: "123:abc", mode: "webhook" },
        feishu: { enabled: false, appSecret: "secret" },
      },
    });
    expect(resolved.platforms?.telegram).toMatchObject({
      enabled: true,
      botToken: "123:abc",
      mode: "webhook",
    });
    expect(resolved.platforms?.feishu).toMatchObject({ enabled: false, appSecret: "secret" });
  });
});

describe("mounting configured connectors", () => {
  it("starts enabled webhook-safe connectors and still accepts programmatic instances", async () => {
    const host = await TestDshHost.start({ withWebServer: true });
    try {
      const runtime = await mountConnectorPlugin(host.ctx, {
        platforms: {
          feishu: {
            enabled: true,
            appId: "cli_test",
            appSecret: "feishu-secret",
            mode: "webhook",
            resolveBotInfoOnStart: false,
          },
          weixin: { enabled: true, mode: "official-account", appId: "wx_test", token: "token" },
          dingtalk: {
            enabled: true,
            clientId: "ding",
            clientSecret: "secret",
            inboundMode: "webhook",
          },
          wecom: {
            enabled: true,
            app: { corpId: "ww", corpSecret: "secret", agentId: 100 },
          },
          qq: { enabled: true, appId: "qq", clientSecret: "secret", transport: "webhook" },
          slack: {
            enabled: true,
            botToken: SLACK_BOT_TOKEN,
            signingSecret: "signing",
            mode: "webhook",
            verifyAuthOnStart: false,
          },
          telegram: { enabled: true, botToken: "123456:telegram", mode: "webhook" },
          discord: { enabled: true, botToken: "discord-bot", enableGateway: false },
          whatsapp: { enabled: true, accessToken: "wa", phoneNumberId: "100" },
        },
      });
      expect(runtime.manager.getConnector("feishu")?.name).toBe("feishu");
      expect(runtime.manager.getConnector("whatsapp")?.name).toBe("whatsapp");
      expect(
        host.ctx.tools
          .definitions()
          .map((definition) => definition.name)
          .sort(),
      ).toEqual([
        "connector_send_dingtalk",
        "connector_send_discord",
        "connector_send_feishu",
        "connector_send_qq",
        "connector_send_slack",
        "connector_send_telegram",
        "connector_send_wecom",
        "connector_send_weixin",
        "connector_send_whatsapp",
      ]);
      await runtime.dispose();

      const mixed = await mountConnectorPlugin(host.ctx, {
        platforms: { feishu: { enabled: false } },
        connectors: [new MockGithubPrConnector()],
        contextStore: new DefaultContextSessionStore(),
        webhook: { enabled: false },
      });
      expect(mixed.manager.getConnector("github")?.name).toBe("github");
      expect(mixed.manager.getConnector("feishu")).toBeUndefined();
      await mixed.dispose();

      const merged = createConnectorPlugin({
        platforms: { feishu: { enabled: false, appId: "cli_base", appSecret: "base-secret" } },
        contextStore: new DefaultContextSessionStore(),
        webhook: { enabled: false },
      });
      const disposeMerged = await merged.apply(host.ctx, {
        platforms: { telegram: { enabled: true, botToken: "123:telegram", mode: "passive" } },
      });
      expect(host.ctx.tools.get("connector_send_telegram")).toBeDefined();
      expect(host.ctx.tools.get("connector_send_feishu")).toBeUndefined();
      await disposeMerged();

      const duplicate = defineConnector({
        name: "feishu",
        getSender: () => undefined,
        getReceiver: () => undefined,
      });
      await expect(
        mountConnectorPlugin(host.ctx, {
          platforms: { feishu: { enabled: true, appId: "cli_test", appSecret: "secret" } },
          connectors: [duplicate],
          contextStore: new DefaultContextSessionStore(),
          webhook: { enabled: false },
        }),
      ).rejects.toThrow(/Duplicate connector name "feishu"/);
    } finally {
      await host.stop();
    }
  });
});
