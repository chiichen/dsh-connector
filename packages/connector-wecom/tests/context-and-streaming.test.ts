import { describe, expect, it } from "vitest";
import {
  DEFAULT_WECOM_AIBOT_WS_URL,
  DEFAULT_WECOM_API_BASE_URL,
  DEFAULT_WECOM_CONNECTOR_NAME,
  WECOM_AIBOT_MARKDOWN_MAX_BYTES,
  WECOM_APP_TEXT_MAX_BYTES,
  WECOM_HTTP_STREAM_WINDOW_MS,
  WECOM_TOKEN_INVALID_ERRCODES,
  WECOM_WEBHOOK_MARKDOWN_MAX_BYTES,
  WECOM_WS_STREAM_WINDOW_MS,
} from "../src/constants";
import {
  formatWeComContextId,
  isUuidLikeContextId,
  parseWeComContextTarget,
  splitUtf8ByBytes,
} from "../src/context-target";
import {
  buildPassiveStreamReplyPayload,
  buildWsStreamRespondFrame,
  resolveWeComStreamingAdapter,
  type WeComStreamingAdapter,
} from "../src/streaming";
import { wecomReceiveSchema, wecomSendSchema } from "../src/types";

describe("Stage 1: WeCom constants, context target addressing, schemas, and streaming seam", () => {
  it("exposes official WeCom protocol constants", () => {
    expect(DEFAULT_WECOM_CONNECTOR_NAME).toBe("wecom");
    expect(DEFAULT_WECOM_API_BASE_URL).toBe("https://qyapi.weixin.qq.com");
    expect(DEFAULT_WECOM_AIBOT_WS_URL).toBe("wss://openws.work.weixin.qq.com");
    expect(WECOM_APP_TEXT_MAX_BYTES).toBe(2048);
    expect(WECOM_WEBHOOK_MARKDOWN_MAX_BYTES).toBe(4096);
    expect(WECOM_AIBOT_MARKDOWN_MAX_BYTES).toBe(20480);
    expect(WECOM_HTTP_STREAM_WINDOW_MS).toBe(360_000);
    expect(WECOM_WS_STREAM_WINDOW_MS).toBe(600_000);
    expect(WECOM_TOKEN_INVALID_ERRCODES.has(40014)).toBe(true);
    expect(WECOM_TOKEN_INVALID_ERRCODES.has(42001)).toBe(true);
  });

  it("formats and parses structured WeCom contextId targets while rejecting UUIDs", () => {
    expect(formatWeComContextId({ channel: "app", peerKind: "p2p", targetId: "zhangsan" })).toBe(
      "app:p2p:zhangsan",
    );
    expect(formatWeComContextId({ channel: "app", peerKind: "group", targetId: "wr12345" })).toBe(
      "app:group:wr12345",
    );
    expect(formatWeComContextId({ channel: "aibot", peerKind: "p2p", targetId: "lisi" })).toBe(
      "aibot:p2p:lisi",
    );
    expect(
      formatWeComContextId({ channel: "aibot", peerKind: "group", targetId: "chat_abc" }),
    ).toBe("aibot:group:chat_abc");
    expect(formatWeComContextId({ channel: "webhook", targetId: "693a91f6-key" })).toBe(
      "webhook:693a91f6-key",
    );

    expect(parseWeComContextTarget("app:p2p:zhangsan")).toEqual({
      channel: "app",
      peerKind: "p2p",
      targetId: "zhangsan",
    });
    expect(parseWeComContextTarget("app:group:wr12345")).toEqual({
      channel: "app",
      peerKind: "group",
      targetId: "wr12345",
    });
    expect(parseWeComContextTarget("aibot:p2p:lisi")).toEqual({
      channel: "aibot",
      peerKind: "p2p",
      targetId: "lisi",
    });
    expect(parseWeComContextTarget("aibot:group:chat_abc")).toEqual({
      channel: "aibot",
      peerKind: "group",
      targetId: "chat_abc",
    });
    expect(parseWeComContextTarget("webhook:693a91f6-key")).toEqual({
      channel: "webhook",
      targetId: "693a91f6-key",
    });

    // Generic IM conversation keys fallback cleanly
    expect(parseWeComContextTarget("p2p:wangwu", "aibot")).toEqual({
      channel: "aibot",
      peerKind: "p2p",
      targetId: "wangwu",
    });
    expect(parseWeComContextTarget("group:room_99")).toEqual({
      channel: "app",
      peerKind: "group",
      targetId: "room_99",
    });

    // Pure pre-allocated UUIDs and unstructured IDs must never be misread as WeCom targets
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(isUuidLikeContextId(uuid)).toBe(true);
    expect(isUuidLikeContextId("app:p2p:zhangsan")).toBe(false);
    expect(parseWeComContextTarget(uuid)).toBeUndefined();
    expect(parseWeComContextTarget("")).toBeUndefined();
    expect(parseWeComContextTarget("app:p2p:")).toBeUndefined();
    expect(parseWeComContextTarget("webhook:   ")).toBeUndefined();
    expect(parseWeComContextTarget("unknown:foo:bar")).toBeUndefined();
    expect(() => formatWeComContextId({ channel: "webhook", targetId: "   " })).toThrow(
      /must not be empty/,
    );
  });

  it("splits UTF-8 strings safely on code-point boundaries without breaking CJK or emoji", () => {
    expect(splitUtf8ByBytes("", 10)).toEqual([""]);
    expect(splitUtf8ByBytes("short", 10)).toEqual(["short"]);
    // Each Chinese char is 3 UTF-8 bytes; maxBytes = 7 fits at most 2 chars (6 bytes)
    const cjkChunks = splitUtf8ByBytes("企业微信测试", 7);
    expect(cjkChunks).toEqual(["企业", "微信", "测试"]);
    for (const chunk of cjkChunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(7);
    }

    // 4-byte emoji surrogate pairs must stay intact
    const emojiChunks = splitUtf8ByBytes("🚀🎉🔥", 8);
    expect(emojiChunks).toEqual(["🚀🎉", "🔥"]);
    for (const chunk of emojiChunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(8);
    }

    expect(() => splitUtf8ByBytes("abc", 3)).toThrow(/maxBytes/);
  });

  it("validates wecomSendSchema and wecomReceiveSchema contracts", () => {
    const minimalSend = wecomSendSchema.parse({ text: "Hello WeCom" });
    expect(minimalSend).toEqual({ text: "Hello WeCom" });

    const richSend = wecomSendSchema.parse({
      text: "**Alert**",
      channel: "webhook",
      webhookKey: "key-1",
      format: "markdown_v2",
      mentionedList: ["zhangsan", "@all"],
      includeContextMarker: true,
    });
    expect(richSend.channel).toBe("webhook");
    expect(richSend.format).toBe("markdown_v2");
    expect(() => wecomSendSchema.parse({ text: "" })).toThrow();

    const parsedInbound = wecomReceiveSchema.parse({
      source: "aibot-ws",
      messageId: "msg-001",
      msgType: "text",
      senderId: "zhangsan",
      chatType: "group",
      chatId: "chat-001",
      text: "帮我查一下构建状态",
      quotedText: "上一次构建日志",
      reqId: "req-123",
    });
    expect(parsedInbound.source).toBe("aibot-ws");
    expect(parsedInbound.chatType).toBe("group");
  });

  it("provides typed passive & WebSocket stream builders and adapter resolution seam", () => {
    const passiveReply = buildPassiveStreamReplyPayload({
      streamId: "stream_001",
      content: "正在分析日志...",
      finish: false,
      feedbackId: "fb_001",
    });
    expect(passiveReply).toEqual({
      msgtype: "stream",
      stream: {
        id: "stream_001",
        finish: false,
        content: "正在分析日志...",
        feedback: { id: "fb_001" },
      },
    });

    const finalReplyWithImages = buildPassiveStreamReplyPayload({
      streamId: "stream_001",
      content: "分析完成",
      finish: true,
      images: [{ base64: "YWJj", md5: "900150983cd24fb0d6963f7d28e17f72" }],
    });
    expect(finalReplyWithImages.stream.finish).toBe(true);
    expect(finalReplyWithImages.stream.msg_item).toEqual([
      {
        msgtype: "image",
        image: { base64: "YWJj", md5: "900150983cd24fb0d6963f7d28e17f72" },
      },
    ]);

    const wsFrame = buildWsStreamRespondFrame("req_99", {
      streamId: "stream_001",
      content: "增量回复",
      finish: false,
    });
    expect(wsFrame).toEqual({
      cmd: "aibot_respond_msg",
      headers: { req_id: "req_99" },
      body: {
        msgtype: "stream",
        stream: {
          id: "stream_001",
          finish: false,
          content: "增量回复",
        },
      },
    });

    expect(resolveWeComStreamingAdapter({})).toBeUndefined();

    const mockAdapter: WeComStreamingAdapter = {
      async startStream(target) {
        return {
          streamId: "s1",
          target,
          startedAt: 1000,
          expiresAt: 601_000,
        };
      },
      async updateStream() {},
      async completeStream() {},
      async abortStream() {},
    };
    expect(resolveWeComStreamingAdapter({ streamingAdapter: mockAdapter })).toBe(mockAdapter);
    expect(resolveWeComStreamingAdapter({ streaming: { adapter: mockAdapter } })).toBe(mockAdapter);
  });
});
