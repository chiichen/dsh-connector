import { describe, expect, it } from "vitest";
import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  createConnectorContext,
} from "@dsh-connector/core";
import {
  QQ_AUTH_SCHEME,
  QQ_DEFAULT_API_BASE_URL,
  QQ_DEFAULT_CONNECTOR_NAME,
  QQ_DEFAULT_INTENTS,
  QQ_DEFAULT_TOKEN_URL,
  QQ_EVENT_AT_MESSAGE_CREATE,
  QQ_EVENT_C2C_MESSAGE_CREATE,
  QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
  QQ_INTENT_GROUP_AND_C2C_EVENT,
  QQ_INTENT_PUBLIC_GUILD_MESSAGES,
  QQ_MSG_TYPE_MARKDOWN,
  QQ_MSG_TYPE_RICH_MEDIA,
  QQ_MSG_TYPE_TEXT,
  QQ_OPCODE_CALLBACK_VALIDATION,
  QQ_OPCODE_DISPATCH,
  QQ_OPCODE_HEARTBEAT,
  QQ_OPCODE_HEARTBEAT_ACK,
  QQ_OPCODE_HELLO,
  QQ_OPCODE_HTTP_CALLBACK_ACK,
  QQ_OPCODE_IDENTIFY,
  QQ_OPCODE_INVALID_SESSION,
  QQ_OPCODE_RECONNECT,
  QQ_OPCODE_RESUME,
  QQ_SANDBOX_API_BASE_URL,
  QQ_UNIFIED_API_BASE_URL,
  QQ_UNIFIED_TOKEN_URL,
  buildQqSendEndpoint,
  formatQqContextId,
  parseQqContextId,
  qqReceiveSchema,
  qqSendSchema,
  resolveQqSendTarget,
} from "../src/index";

describe("Stage 1: QQ constants, schemas, and target addressing", () => {
  it("exposes official QQ Open Platform protocol constants", () => {
    expect(QQ_DEFAULT_CONNECTOR_NAME).toBe("qq");
    expect(QQ_DEFAULT_TOKEN_URL).toBe("https://bots.qq.com/app/getAppAccessToken");
    expect(QQ_UNIFIED_TOKEN_URL).toBe("https://api.bot.qq.com/app/getAppAccessToken");
    expect(QQ_DEFAULT_API_BASE_URL).toBe("https://api.sgroup.qq.com");
    expect(QQ_SANDBOX_API_BASE_URL).toBe("https://sandbox.api.sgroup.qq.com");
    expect(QQ_UNIFIED_API_BASE_URL).toBe("https://api.bot.qq.com");
    expect(QQ_AUTH_SCHEME).toBe("QQBot");

    expect(QQ_OPCODE_DISPATCH).toBe(0);
    expect(QQ_OPCODE_HEARTBEAT).toBe(1);
    expect(QQ_OPCODE_IDENTIFY).toBe(2);
    expect(QQ_OPCODE_RESUME).toBe(6);
    expect(QQ_OPCODE_RECONNECT).toBe(7);
    expect(QQ_OPCODE_INVALID_SESSION).toBe(9);
    expect(QQ_OPCODE_HELLO).toBe(10);
    expect(QQ_OPCODE_HEARTBEAT_ACK).toBe(11);
    expect(QQ_OPCODE_HTTP_CALLBACK_ACK).toBe(12);
    expect(QQ_OPCODE_CALLBACK_VALIDATION).toBe(13);

    expect(QQ_INTENT_GROUP_AND_C2C_EVENT).toBe(1 << 25);
    expect(QQ_INTENT_PUBLIC_GUILD_MESSAGES).toBe(1 << 30);
    expect(QQ_DEFAULT_INTENTS).toBe((1 << 25) | (1 << 30));

    expect(QQ_EVENT_C2C_MESSAGE_CREATE).toBe("C2C_MESSAGE_CREATE");
    expect(QQ_EVENT_GROUP_AT_MESSAGE_CREATE).toBe("GROUP_AT_MESSAGE_CREATE");
    expect(QQ_EVENT_AT_MESSAGE_CREATE).toBe("AT_MESSAGE_CREATE");

    expect(QQ_MSG_TYPE_TEXT).toBe(0);
    expect(QQ_MSG_TYPE_MARKDOWN).toBe(2);
    expect(QQ_MSG_TYPE_RICH_MEDIA).toBe(7);
  });

  it("formats and parses structured QQ business contextIds while ignoring raw UUIDs", () => {
    const c2cId = formatQqContextId({ scene: "c2c", openId: "USER_OPENID_1" });
    expect(c2cId).toBe("c2c:USER_OPENID_1");
    expect(parseQqContextId(c2cId)).toEqual({ scene: "c2c", openId: "USER_OPENID_1" });

    const groupId = formatQqContextId({ scene: "group", groupOpenId: "GROUP_OPENID_2" });
    expect(groupId).toBe("group:GROUP_OPENID_2");
    expect(parseQqContextId(groupId)).toEqual({ scene: "group", groupOpenId: "GROUP_OPENID_2" });

    const channelOnlyId = formatQqContextId({ scene: "channel", channelId: "CH_100" });
    expect(channelOnlyId).toBe("channel:CH_100");
    expect(parseQqContextId(channelOnlyId)).toEqual({
      scene: "channel",
      channelId: "CH_100",
    });

    const guildChannelId = formatQqContextId({
      scene: "channel",
      guildId: "GUILD_9",
      channelId: "CH_100",
    });
    expect(guildChannelId).toBe("channel:GUILD_9:CH_100");
    expect(parseQqContextId(guildChannelId)).toEqual({
      scene: "channel",
      guildId: "GUILD_9",
      channelId: "CH_100",
    });

    // Outbound-first pure UUID contextId must NOT be treated as a QQ chat target
    expect(parseQqContextId("550e8400-e29b-41d4-a716-446655440000")).toBeUndefined();
    expect(parseQqContextId("unknown:abc")).toBeUndefined();
    expect(parseQqContextId("c2c:")).toBeUndefined();
    expect(parseQqContextId("group:   ")).toBeUndefined();
    expect(parseQqContextId("channel:")).toBeUndefined();
    expect(parseQqContextId("channel:guild:")).toBeUndefined();
    expect(parseQqContextId("channel::ch")).toBeUndefined();
    expect(parseQqContextId("channel:a:b:c")).toBeUndefined();

    expect(() => formatQqContextId({ scene: "c2c", openId: "   " })).toThrow(
      ConnectorValidationError,
    );
  });

  it("resolves send targets with 3-tier priority (params > context.contextId > ConnectorTargetRequiredError)", () => {
    const c2cCtx = createConnectorContext("qq", "c2c:CTX_USER");
    const uuidCtx = createConnectorContext("qq", "550e8400-e29b-41d4-a716-446655440000");

    // 1. Explicit params override contextId
    expect(
      resolveQqSendTarget(
        "qq",
        c2cCtx,
        qqSendSchema.parse({ text: "hello", groupOpenId: "EXPLICIT_GROUP" }),
      ),
    ).toEqual({
      scene: "group",
      groupOpenId: "EXPLICIT_GROUP",
    });

    expect(
      resolveQqSendTarget(
        "qq",
        uuidCtx,
        qqSendSchema.parse({ text: "hello", openId: "EXPLICIT_USER" }),
      ),
    ).toEqual({
      scene: "c2c",
      openId: "EXPLICIT_USER",
    });

    expect(
      resolveQqSendTarget(
        "qq",
        uuidCtx,
        qqSendSchema.parse({ text: "hello", channelId: "EXPLICIT_CH" }),
      ),
    ).toEqual({
      scene: "channel",
      channelId: "EXPLICIT_CH",
    });

    // 2. Fallback to structured context.contextId when params omit target
    expect(resolveQqSendTarget("qq", c2cCtx, qqSendSchema.parse({ text: "hello" }))).toEqual({
      scene: "c2c",
      openId: "CTX_USER",
    });

    // 3. Pure UUID contextId with no explicit target throws ConnectorTargetRequiredError
    expect(() => resolveQqSendTarget("qq", uuidCtx, qqSendSchema.parse({ text: "hello" }))).toThrow(
      ConnectorTargetRequiredError,
    );

    // Conflicting explicit target fields throw ConnectorValidationError
    expect(() =>
      resolveQqSendTarget(
        "qq",
        uuidCtx,
        qqSendSchema.parse({
          text: "hello",
          openId: "U1",
          groupOpenId: "G1",
        }),
      ),
    ).toThrow(ConnectorValidationError);

    // Explicit scene mismatch throws ConnectorValidationError
    expect(() =>
      resolveQqSendTarget(
        "qq",
        uuidCtx,
        qqSendSchema.parse({
          text: "hello",
          scene: "group",
          openId: "U1",
        }),
      ),
    ).toThrow(ConnectorValidationError);
  });

  it("builds official OpenAPI message paths for C2C, group, and channel scenes", () => {
    expect(buildQqSendEndpoint({ scene: "c2c", openId: "U_123" })).toBe("/v2/users/U_123/messages");
    expect(buildQqSendEndpoint({ scene: "group", groupOpenId: "G_456" })).toBe(
      "/v2/groups/G_456/messages",
    );
    expect(buildQqSendEndpoint({ scene: "channel", channelId: "C_789" })).toBe(
      "/channels/C_789/messages",
    );
  });

  it("validates sendSchema (primary text field) and receiveSchema", () => {
    expect(() => qqSendSchema.parse({ text: "" })).toThrow();
    const parsedSend = qqSendSchema.parse({
      text: "ping",
      replyToMessageId: "MSG_1",
      msgSeq: 2,
      format: "markdown",
    });
    expect(parsedSend.text).toBe("ping");
    expect(parsedSend.msgSeq).toBe(2);
    expect(parsedSend.format).toBe("markdown");

    const parsedReceive = qqReceiveSchema.parse({
      eventType: "C2C_MESSAGE_CREATE",
      scene: "c2c",
      messageId: "ROBOT1.0_abc",
      text: "你好",
      senderId: "OPENID_1",
      openId: "OPENID_1",
      timestamp: "2026-11-23T10:00:00+08:00",
    });
    expect(parsedReceive.scene).toBe("c2c");
    expect(parsedReceive.text).toBe("你好");
  });
});
