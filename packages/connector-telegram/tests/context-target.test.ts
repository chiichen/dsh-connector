import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  createConnectorContext,
} from "@dsh-connector/core";
import { describe, expect, it } from "vitest";
import {
  formatTelegramContextId,
  parseTelegramContextTarget,
  resolveTelegramSendTarget,
} from "../src/context-target";

const PRIVATE_CHAT_ID = 123456789;
const SUPERGROUP_CHAT_ID = -1009876543210;
const FORUM_TOPIC_ID = 42;
const SAMPLE_UUID_CONTEXT = "550e8400-e29b-41d4-a716-446655440000";

describe("context-target codec & 3-tier resolution", () => {
  it("formats private chats with and without forum message_thread_id", () => {
    expect(
      formatTelegramContextId({
        chatType: "private",
        chatId: PRIVATE_CHAT_ID,
      }),
    ).toBe(`p2p:${PRIVATE_CHAT_ID}`);

    expect(
      formatTelegramContextId({
        chatType: "private",
        chatId: PRIVATE_CHAT_ID,
        messageThreadId: FORUM_TOPIC_ID,
      }),
    ).toBe(`p2p:${PRIVATE_CHAT_ID}:${FORUM_TOPIC_ID}`);
  });

  it("formats group, supergroup, and channel targets deterministically", () => {
    expect(
      formatTelegramContextId({
        chatType: "group",
        chatId: -456789,
      }),
    ).toBe("group:-456789");

    expect(
      formatTelegramContextId({
        chatType: "supergroup",
        chatId: SUPERGROUP_CHAT_ID,
        messageThreadId: FORUM_TOPIC_ID,
      }),
    ).toBe(`group:${SUPERGROUP_CHAT_ID}:${FORUM_TOPIC_ID}`);

    expect(
      formatTelegramContextId({
        chatType: "channel",
        chatId: "@my_channel",
      }),
    ).toBe("channel:@my_channel");
  });

  it("parses structured p2p, direct, group, supergroup, and channel contextIds", () => {
    expect(parseTelegramContextTarget(`p2p:${PRIVATE_CHAT_ID}`)).toEqual({
      scope: "p2p",
      chatId: PRIVATE_CHAT_ID,
    });

    expect(parseTelegramContextTarget(`direct:${PRIVATE_CHAT_ID}:${FORUM_TOPIC_ID}`)).toEqual({
      scope: "p2p",
      chatId: PRIVATE_CHAT_ID,
      messageThreadId: FORUM_TOPIC_ID,
    });

    expect(parseTelegramContextTarget(`group:${SUPERGROUP_CHAT_ID}:${FORUM_TOPIC_ID}`)).toEqual({
      scope: "group",
      chatId: SUPERGROUP_CHAT_ID,
      messageThreadId: FORUM_TOPIC_ID,
    });

    expect(parseTelegramContextTarget(`supergroup:${SUPERGROUP_CHAT_ID}`)).toEqual({
      scope: "group",
      chatId: SUPERGROUP_CHAT_ID,
    });

    expect(parseTelegramContextTarget("channel:@news_updates")).toEqual({
      scope: "channel",
      chatId: "@news_updates",
    });
  });

  it("rejects pre-allocated UUIDs and malformed contextIds so UUIDs are never sent as chat_id", () => {
    expect(parseTelegramContextTarget(SAMPLE_UUID_CONTEXT)).toBeUndefined();
    expect(parseTelegramContextTarget("")).toBeUndefined();
    expect(parseTelegramContextTarget("unknown:12345")).toBeUndefined();
    expect(parseTelegramContextTarget("p2p:")).toBeUndefined();
    expect(parseTelegramContextTarget("group:-100123:0")).toBeUndefined();
    expect(parseTelegramContextTarget("group:-100123:-5")).toBeUndefined();
    expect(parseTelegramContextTarget("group:-100123:notanumber")).toBeUndefined();
    expect(parseTelegramContextTarget("group:-100123:42:extra")).toBeUndefined();
    expect(parseTelegramContextTarget("channel:@a")).toBeUndefined();
    expect(parseTelegramContextTarget("channel:@valid_name:99")).toBeUndefined();
    expect(parseTelegramContextTarget("p2p:not_a_chat_id")).toBeUndefined();
  });

  it("resolves target in strict 3-tier priority: explicit params > contextId > ConnectorTargetRequiredError", () => {
    const groupCtx = createConnectorContext(
      "telegram",
      `group:${SUPERGROUP_CHAT_ID}:${FORUM_TOPIC_ID}`,
    );
    const uuidCtx = createConnectorContext("telegram", SAMPLE_UUID_CONTEXT);

    // Tier 1: explicit chatId overrides contextId (without inheriting old chat's threadId)
    expect(
      resolveTelegramSendTarget(groupCtx, {
        chatId: PRIVATE_CHAT_ID,
      }),
    ).toEqual({
      chatId: PRIVATE_CHAT_ID,
    });

    expect(
      resolveTelegramSendTarget(uuidCtx, {
        chatId: " @my_supergroup ",
        messageThreadId: 7,
      }),
    ).toEqual({
      chatId: "@my_supergroup",
      messageThreadId: 7,
    });

    // Tier 2: fallback to structured contextId, optionally overriding messageThreadId
    expect(resolveTelegramSendTarget(groupCtx, {})).toEqual({
      chatId: SUPERGROUP_CHAT_ID,
      messageThreadId: FORUM_TOPIC_ID,
    });

    expect(resolveTelegramSendTarget(groupCtx, { messageThreadId: 99 })).toEqual({
      chatId: SUPERGROUP_CHAT_ID,
      messageThreadId: 99,
    });

    // Validation error on blank explicit chatId string
    expect(() => resolveTelegramSendTarget(groupCtx, { chatId: "   " })).toThrow(
      ConnectorValidationError,
    );

    // Tier 3: UUID context without explicit chatId throws ConnectorTargetRequiredError
    expect(() => resolveTelegramSendTarget(uuidCtx, {})).toThrow(ConnectorTargetRequiredError);
    try {
      resolveTelegramSendTarget(uuidCtx, {});
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorTargetRequiredError);
      if (err instanceof ConnectorTargetRequiredError) {
        expect(err.targetField).toBe("chatId");
        expect(err.connectorName).toBe("telegram");
      }
    }
  });
});
