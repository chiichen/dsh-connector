import { describe, expect, it } from "vitest";
import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  createConnectorContext,
  extractContextMarker,
} from "@dsh-connector/core";
import {
  DEFAULT_FEISHU_CONNECTOR_NAME,
  FEISHU_OPEN_API_BASE_URL,
  LARK_OPEN_API_BASE_URL,
  applyOutboundContextMarker,
  buildFeishuConversationContextId,
  feishuSendSchema,
  inferFeishuReceiveIdType,
  parseFeishuContextTarget,
  resolveFeishuApiBaseUrl,
  resolveFeishuSendTarget,
} from "../src/index";

describe("Stage 1: Feishu constants, schemas, and 3-tier context target addressing", () => {
  it("resolves official Feishu / Lark OpenAPI base URLs and validates custom base URLs", () => {
    expect(resolveFeishuApiBaseUrl()).toBe(FEISHU_OPEN_API_BASE_URL);
    expect(resolveFeishuApiBaseUrl("feishu")).toBe(FEISHU_OPEN_API_BASE_URL);
    expect(resolveFeishuApiBaseUrl("lark")).toBe(LARK_OPEN_API_BASE_URL);
    expect(resolveFeishuApiBaseUrl("https://open.feishu-enterprise.example.com/")).toBe(
      "https://open.feishu-enterprise.example.com",
    );
    expect(() => resolveFeishuApiBaseUrl("ftp://invalid.example.com")).toThrow(
      ConnectorValidationError,
    );
    expect(() => resolveFeishuApiBaseUrl("   ")).toThrow(ConnectorValidationError);
  });

  it("builds and parses structured p2p, group, and group topic context IDs", () => {
    const p2pOpenId = buildFeishuConversationContextId({
      chatType: "p2p",
      senderOpenId: "ou_84aad35d084aa403a838cf73ee18467",
      chatId: "oc_123",
    });
    expect(p2pOpenId).toBe("p2p:ou_84aad35d084aa403a838cf73ee18467");
    expect(parseFeishuContextTarget(p2pOpenId)).toEqual({
      mode: "send",
      receiveIdType: "open_id",
      receiveId: "ou_84aad35d084aa403a838cf73ee18467",
    });

    const p2pUserFallback = buildFeishuConversationContextId({
      chatType: "p2p",
      senderUserId: "e33ggbyz",
      chatId: "oc_123",
    });
    expect(p2pUserFallback).toBe("p2p:user:e33ggbyz");
    expect(parseFeishuContextTarget(p2pUserFallback)).toEqual({
      mode: "send",
      receiveIdType: "user_id",
      receiveId: "e33ggbyz",
    });

    const p2pChatFallback = buildFeishuConversationContextId({
      chatType: "p2p",
      chatId: "oc_p2p_chat_only",
    });
    expect(p2pChatFallback).toBe("p2p:oc_p2p_chat_only");
    expect(parseFeishuContextTarget(p2pChatFallback)).toEqual({
      mode: "send",
      receiveIdType: "chat_id",
      receiveId: "oc_p2p_chat_only",
    });

    const groupId = buildFeishuConversationContextId({
      chatType: "group",
      chatId: "oc_5ce6d572455d361153b7xx51da133945",
    });
    expect(groupId).toBe("group:oc_5ce6d572455d361153b7xx51da133945");
    expect(parseFeishuContextTarget(groupId)).toEqual({
      mode: "send",
      receiveIdType: "chat_id",
      receiveId: "oc_5ce6d572455d361153b7xx51da133945",
    });

    const groupTopicWithRoot = buildFeishuConversationContextId({
      chatType: "group",
      chatId: "oc_group_1",
      threadId: "omt_thread_99",
      rootMessageId: "om_root_msg_1",
    });
    expect(groupTopicWithRoot).toBe("group:oc_group_1:topic:om_root_msg_1");
    expect(parseFeishuContextTarget(groupTopicWithRoot)).toEqual({
      mode: "reply",
      replyToMessageId: "om_root_msg_1",
      replyInThread: true,
      chatId: "oc_group_1",
    });

    const groupThreadWithoutRoot = "group:oc_group_1:thread:omt_thread_99";
    expect(parseFeishuContextTarget(groupThreadWithoutRoot)).toEqual({
      mode: "send",
      receiveIdType: "chat_id",
      receiveId: "oc_group_1",
    });
  });

  it("rejects pure UUIDs and malformed context IDs when parsing business targets", () => {
    expect(parseFeishuContextTarget("550e8400-e29b-41d4-a716-446655440000")).toBeUndefined();
    expect(parseFeishuContextTarget("p2p:")).toBeUndefined();
    expect(parseFeishuContextTarget("group:")).toBeUndefined();
    expect(parseFeishuContextTarget("group:oc_1:topic:")).toBeUndefined();
    expect(parseFeishuContextTarget("unknown:123")).toBeUndefined();
  });

  it("validates feishuSendSchema with primary 'text' field and all target fields optional", () => {
    const minimal = feishuSendSchema.parse({ text: "Hello Feishu" });
    expect(minimal).toEqual({ text: "Hello Feishu" });
    expect(() => feishuSendSchema.parse({ text: "" })).toThrow();
    expect(() => feishuSendSchema.parse({})).toThrow();
  });

  it("infers receive_id_type from standard Feishu prefixes and enforces explicit type for ambiguous IDs", () => {
    expect(inferFeishuReceiveIdType("oc_chat123")).toBe("chat_id");
    expect(inferFeishuReceiveIdType("ou_user123")).toBe("open_id");
    expect(inferFeishuReceiveIdType("on_union123")).toBe("union_id");
    expect(inferFeishuReceiveIdType("dev@example.com")).toBe("email");
    expect(inferFeishuReceiveIdType("custom_user_id")).toBeUndefined();
  });

  it("enforces 3-tier target priority: explicit params > structured context.contextId > ConnectorTargetRequiredError", () => {
    const inboundGroupCtx = createConnectorContext(
      DEFAULT_FEISHU_CONNECTOR_NAME,
      "group:oc_inbound_group",
    );
    const preallocatedUuidCtx = createConnectorContext(
      DEFAULT_FEISHU_CONNECTOR_NAME,
      "550e8400-e29b-41d4-a716-446655440000",
    );

    // Tier 1: explicit params override structured contextId
    expect(
      resolveFeishuSendTarget(inboundGroupCtx, {
        text: "Override to user",
        openId: "ou_explicit_user",
      }),
    ).toEqual({
      mode: "send",
      receiveIdType: "open_id",
      receiveId: "ou_explicit_user",
    });

    expect(
      resolveFeishuSendTarget(inboundGroupCtx, {
        text: "Reply to message",
        replyToMessageId: "om_msg_42",
        replyInThread: true,
      }),
    ).toEqual({
      mode: "reply",
      replyToMessageId: "om_msg_42",
      replyInThread: true,
    });

    expect(
      resolveFeishuSendTarget(preallocatedUuidCtx, {
        text: "Send via receiveId",
        receiveId: "oc_explicit_chat",
      }),
    ).toEqual({
      mode: "send",
      receiveIdType: "chat_id",
      receiveId: "oc_explicit_chat",
    });

    expect(
      resolveFeishuSendTarget(preallocatedUuidCtx, {
        text: "Send via explicit userId",
        userId: "u_9988",
      }),
    ).toEqual({
      mode: "send",
      receiveIdType: "user_id",
      receiveId: "u_9988",
    });

    expect(
      resolveFeishuSendTarget(preallocatedUuidCtx, {
        text: "Send via explicit unionId",
        unionId: "on_7766",
      }),
    ).toEqual({
      mode: "send",
      receiveIdType: "union_id",
      receiveId: "on_7766",
    });

    expect(
      resolveFeishuSendTarget(preallocatedUuidCtx, {
        text: "Send via explicit email",
        email: "bot-owner@example.com",
      }),
    ).toEqual({
      mode: "send",
      receiveIdType: "email",
      receiveId: "bot-owner@example.com",
    });

    expect(() =>
      resolveFeishuSendTarget(preallocatedUuidCtx, {
        text: "Ambiguous receiveId without receiveIdType",
        receiveId: "ambiguous_id",
      }),
    ).toThrow(ConnectorValidationError);

    // Tier 2: fallback to structured context.contextId when params omit target
    expect(resolveFeishuSendTarget(inboundGroupCtx, { text: "Hello group" })).toEqual({
      mode: "send",
      receiveIdType: "chat_id",
      receiveId: "oc_inbound_group",
    });

    // Tier 3: pre-allocated UUID context without explicit target throws ConnectorTargetRequiredError
    expect(() => resolveFeishuSendTarget(preallocatedUuidCtx, { text: "No target" })).toThrow(
      ConnectorTargetRequiredError,
    );
  });

  it("applies outbound context markers according to 'auto' | 'always' | 'never' policy", () => {
    const inboundP2pCtx = createConnectorContext(DEFAULT_FEISHU_CONNECTOR_NAME, "p2p:ou_user_1");
    const outboundUuidCtx = createConnectorContext(
      DEFAULT_FEISHU_CONNECTOR_NAME,
      "550e8400-e29b-41d4-a716-446655440000",
    );

    // 'auto' keeps structured chat messages clean, prepends bracket marker for UUID outbound-first sessions
    expect(applyOutboundContextMarker("Clean reply", inboundP2pCtx, "auto")).toBe("Clean reply");
    const markedAuto = applyOutboundContextMarker("Proactive alert", outboundUuidCtx, "auto");
    expect(markedAuto).toContain("[#ctx:550e8400-e29b-41d4-a716-446655440000]");
    expect(extractContextMarker(markedAuto)).toEqual({
      contextId: "550e8400-e29b-41d4-a716-446655440000",
      cleanedContent: "Proactive alert",
    });

    // 'always' prepends even on structured chat contexts
    const markedAlways = applyOutboundContextMarker("Always tagged", inboundP2pCtx, "always");
    expect(extractContextMarker(markedAlways)).toEqual({
      contextId: "p2p:ou_user_1",
      cleanedContent: "Always tagged",
    });

    // 'never' never prepends
    expect(applyOutboundContextMarker("No marker", outboundUuidCtx, "never")).toBe("No marker");
  });
});
