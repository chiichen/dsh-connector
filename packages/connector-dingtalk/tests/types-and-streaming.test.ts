import { describe, expect, it } from "vitest";
import type { ConnectorContext } from "@dsh-connector/core";
import {
  CONNECTOR_DINGTALK_VERSION,
  DEFAULT_DINGTALK_CONNECTOR_NAME,
  DINGTALK_API_BASE_URL,
  DINGTALK_CARD_INSTANCES_PATH,
  DINGTALK_CARD_OPEN_SPACE_PREFIX,
  DINGTALK_CARD_STREAMING_PATH,
  DINGTALK_GATEWAY_OPEN_PATH,
  DINGTALK_GROUP_MESSAGE_SEND_PATH,
  DINGTALK_MAX_OTO_BATCH_USERS,
  DINGTALK_OAUTH_TOKEN_PATH,
  DINGTALK_OTO_BATCH_SEND_PATH,
  DINGTALK_STREAM_TOPIC_ROBOT,
  DINGTALK_WEBHOOK_MAX_SKEW_MS,
  dingTalkReceiveSchema,
  dingTalkSendSchema,
  formatDingTalkCardOpenSpaceId,
  formatDingTalkEncryptedP2PContextId,
  formatDingTalkGroupContextId,
  formatDingTalkP2PContextId,
  parseDingTalkContextTarget,
  type DingTalkCardStreamingUpdateRequest,
  type DingTalkCreateCardInstanceRequest,
  type DingTalkStreamHandle,
  type DingTalkStreamingAdapter,
} from "../src";

describe("Stage 1: DingTalk constants, schemas, context target helpers, and streaming seam", () => {
  it("exposes official DingTalk Open Platform protocol constants", () => {
    expect(CONNECTOR_DINGTALK_VERSION).toBe("0.1.0");
    expect(DEFAULT_DINGTALK_CONNECTOR_NAME).toBe("dingtalk");
    expect(DINGTALK_API_BASE_URL).toBe("https://api.dingtalk.com");
    expect(DINGTALK_OAUTH_TOKEN_PATH).toBe("/v1.0/oauth2/accessToken");
    expect(DINGTALK_GATEWAY_OPEN_PATH).toBe("/v1.0/gateway/connections/open");
    expect(DINGTALK_OTO_BATCH_SEND_PATH).toBe("/v1.0/robot/oToMessages/batchSend");
    expect(DINGTALK_GROUP_MESSAGE_SEND_PATH).toBe("/v1.0/robot/groupMessages/send");
    expect(DINGTALK_CARD_INSTANCES_PATH).toBe("/v1.0/card/instances");
    expect(DINGTALK_CARD_STREAMING_PATH).toBe("/v1.0/card/streaming");
    expect(DINGTALK_STREAM_TOPIC_ROBOT).toBe("/v1.0/im/bot/messages/get");
    expect(DINGTALK_WEBHOOK_MAX_SKEW_MS).toBe(3_600_000);
    expect(DINGTALK_MAX_OTO_BATCH_USERS).toBe(20);
    expect(DINGTALK_CARD_OPEN_SPACE_PREFIX).toBe("dtv1.card//");
  });

  it("validates dingTalkSendSchema with required main text and optional addressing fields", () => {
    const minimal = dingTalkSendSchema.safeParse({ text: "Hello DingTalk" });
    expect(minimal.success).toBe(true);

    const emptyText = dingTalkSendSchema.safeParse({ text: "" });
    expect(emptyText.success).toBe(false);

    const tooManyUsers = dingTalkSendSchema.safeParse({
      text: "Broadcast",
      userIds: Array.from({ length: 21 }, (_, idx) => `staff-${idx}`),
    });
    expect(tooManyUsers.success).toBe(false);

    const validFull = dingTalkSendSchema.safeParse({
      text: "### Report\nAll green",
      format: "markdown",
      title: "Report",
      openConversationId: "cid6KeBBLoveMJOGXoYKF5x7EeiodoA==",
      robotCode: "dingrobot123",
      coolAppCode: "COOLAPP-1-1018",
      atUserIds: ["staff-1"],
      atMobiles: ["13800000000"],
      isAtAll: false,
    });
    expect(validFull.success).toBe(true);
  });

  it("validates dingTalkReceiveSchema for normalized inbound messages", () => {
    const valid = dingTalkReceiveSchema.safeParse({
      msgId: "msg-001",
      msgtype: "text",
      text: "Ping from DingTalk",
      conversationId: "cid-group-1",
      conversationType: "2",
      conversationTitle: "Dev Team",
      senderId: "$:LWCP_v1:$sender",
      senderStaffId: "staff-001",
      senderNick: "Alice",
      isInAtList: true,
    });
    expect(valid.success).toBe(true);
  });

  it("formats and parses structured business contextIds while ignoring raw UUIDs", () => {
    const p2pId = formatDingTalkP2PContextId("manager1234");
    expect(p2pId).toBe("p2p:manager1234");
    expect(parseDingTalkContextTarget(p2pId)).toEqual({
      kind: "user",
      userId: "manager1234",
    });

    const encryptedP2pId = formatDingTalkEncryptedP2PContextId("$:LWCP_v1:$enc123");
    expect(encryptedP2pId).toBe("p2p-id:$:LWCP_v1:$enc123");
    expect(parseDingTalkContextTarget(encryptedP2pId)).toEqual({
      kind: "encryptedUser",
      senderId: "$:LWCP_v1:$enc123",
    });

    const groupId = formatDingTalkGroupContextId("cid6KeBBLoveMJOGXoYKF5x7EeiodoA==");
    expect(groupId).toBe("group:cid6KeBBLoveMJOGXoYKF5x7EeiodoA==");
    expect(parseDingTalkContextTarget(groupId)).toEqual({
      kind: "group",
      openConversationId: "cid6KeBBLoveMJOGXoYKF5x7EeiodoA==",
    });

    expect(parseDingTalkContextTarget("550e8400-e29b-41d4-a716-446655440000")).toBeUndefined();
    expect(parseDingTalkContextTarget("p2p:")).toBeUndefined();
    expect(parseDingTalkContextTarget("p2p-id:   ")).toBeUndefined();
    expect(parseDingTalkContextTarget("group:   ")).toBeUndefined();
    expect(parseDingTalkContextTarget("")).toBeUndefined();

    expect(() => formatDingTalkP2PContextId("   ")).toThrow();
    expect(() => formatDingTalkEncryptedP2PContextId("")).toThrow();
    expect(() => formatDingTalkGroupContextId("")).toThrow();
  });

  it("provides OpenSpaceId helper and zero-any AI card streaming extension types", async () => {
    expect(
      formatDingTalkCardOpenSpaceId({
        kind: "group",
        openConversationId: "cid6KeBBLoveMJOGXoYKF5x7EeiodoA==",
      }),
    ).toBe("dtv1.card//IM_GROUP.cid6KeBBLoveMJOGXoYKF5x7EeiodoA==");

    expect(
      formatDingTalkCardOpenSpaceId({
        kind: "user",
        userId: "manager1234",
      }),
    ).toBe("dtv1.card//IM_ROBOT.manager1234");

    expect(() =>
      formatDingTalkCardOpenSpaceId({
        kind: "user",
        userId: "  ",
      }),
    ).toThrow();

    expect(() =>
      formatDingTalkCardOpenSpaceId({
        kind: "group",
        openConversationId: "",
      }),
    ).toThrow();

    const createPayload: DingTalkCreateCardInstanceRequest = {
      cardTemplateId: "tpl-001.schema",
      outTrackId: "track-001",
      callbackType: "STREAM",
      cardData: {
        cardParamMap: {
          msgContent: "Thinking...",
        },
      },
      openSpaceId: "dtv1.card//IM_ROBOT.manager1234",
      imRobotOpenSpaceModel: { supportForward: true },
      imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: "dingrobot123" },
    };
    expect(createPayload.outTrackId).toBe("track-001");

    const streamPayload: DingTalkCardStreamingUpdateRequest = {
      outTrackId: "track-001",
      guid: "guid-001",
      key: "msgContent",
      content: "Hello **streaming** world",
      isFull: true,
      isFinalize: true,
      isError: false,
    };
    expect(streamPayload.isFinalize).toBe(true);

    const events: string[] = [];
    const mockAdapter: DingTalkStreamingAdapter<"dingtalk"> = {
      async startStream(_ctx: ConnectorContext<"dingtalk">, input) {
        events.push(`start:${input.initialContent ?? ""}`);
        return {
          outTrackId: "track-001",
          cardTemplateId: input.cardTemplateId ?? "tpl-001.schema",
          openSpaceId: formatDingTalkCardOpenSpaceId(input.target),
          streamKey: input.streamKey ?? "msgContent",
          target: input.target,
        };
      },
      async updateStream(handle: DingTalkStreamHandle, input) {
        events.push(`update:${handle.outTrackId}:${input.content}`);
      },
      async completeStream(handle: DingTalkStreamHandle, input) {
        events.push(`complete:${handle.outTrackId}:${input.finalContent}`);
      },
      async abortStream(handle: DingTalkStreamHandle, input) {
        events.push(`abort:${handle.outTrackId}:${input.reason ?? "aborted"}`);
      },
    };

    const handle = await mockAdapter.startStream(
      {
        connectorName: "dingtalk",
        contextId: "p2p:manager1234" as ConnectorContext<"dingtalk">["contextId"],
      },
      { target: { kind: "user", userId: "manager1234" }, initialContent: "..." },
    );
    await mockAdapter.updateStream(handle, { content: "partial", isFull: true });
    await mockAdapter.completeStream(handle, { finalContent: "done" });
    await mockAdapter.abortStream(handle, { reason: "cancelled" });
    expect(events).toEqual([
      "start:...",
      "update:track-001:partial",
      "complete:track-001:done",
      "abort:track-001:cancelled",
    ]);
  });
});
