import { describe, expect, it } from "vitest";
import { ConnectorTargetRequiredError, ConnectorValidationError } from "@dsh-connector/core";
import {
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES,
  DEFAULT_WEIXIN_CONNECTOR_NAME,
  WEIXIN_CUSTOM_SEND_PATH,
  WEIXIN_CUSTOM_TYPING_PATH,
  WEIXIN_OFFICIAL_API_BASE_URL,
  WEIXIN_STABLE_TOKEN_PATH,
} from "../src/constants";
import { weixinReceiveSchema, weixinSendSchema } from "../src/types";
import {
  formatWeixinP2pContextId,
  parseWeixinTargetFromContextId,
  resolveWeixinSendTarget,
} from "../src/context-target";
import { BoundedIdSet } from "../src/dedup";
import { splitWeixinText } from "../src/chunker";
import type { WeixinStreamingAdapter } from "../src/streaming";

describe("Stage 1: Weixin core primitives, schemas, target addressing, dedup, and chunker", () => {
  describe("constants & schemas", () => {
    it("exposes official WeChat endpoints and defaults", () => {
      expect(DEFAULT_WEIXIN_CONNECTOR_NAME).toBe("weixin");
      expect(WEIXIN_OFFICIAL_API_BASE_URL).toBe("https://api.weixin.qq.com");
      expect(WEIXIN_STABLE_TOKEN_PATH).toBe("/cgi-bin/stable_token");
      expect(WEIXIN_CUSTOM_SEND_PATH).toBe("/cgi-bin/message/custom/send");
      expect(WEIXIN_CUSTOM_TYPING_PATH).toBe("/cgi-bin/message/custom/typing");
      expect(DEFAULT_MAX_MESSAGE_CHARS).toBe(1800);
      expect(DEFAULT_OFFICIAL_MAX_MESSAGE_BYTES).toBe(2000);
    });

    it("validates weixinSendSchema with required primary text field and optional targets", () => {
      expect(weixinSendSchema.safeParse({ text: "hello weixin" }).success).toBe(true);
      expect(
        weixinSendSchema.safeParse({
          text: "hello",
          openId: "oOpenId123",
          kfAccount: "kf@account",
          contextToken: "ctx-tok",
        }).success,
      ).toBe(true);
      expect(weixinSendSchema.safeParse({ text: "" }).success).toBe(false);
      expect(weixinSendSchema.safeParse({}).success).toBe(false);
    });

    it("validates weixinReceiveSchema", () => {
      const parsed = weixinReceiveSchema.safeParse({
        mode: "official-account",
        messageId: "6272960105994287618",
        senderId: "o9AgO5Kd5ggOC-bXrbNODIiE3bGY",
        recipientId: "gh_97417a04a28d",
        msgType: "text",
        text: "你好，微信",
        createTimeMs: 1714112445000,
      });
      expect(parsed.success).toBe(true);
    });

    it("supports typed WeixinStreamingAdapter contract without runtime implementation coupling", async () => {
      const adapter: WeixinStreamingAdapter = {
        sendTypingIndicator: async (_target, _command) => undefined,
        startStream: async (target) => ({
          streamId: "stream-1",
          target,
          startedAt: 1714112445000,
          chunkSeq: 0,
          messageIds: [],
          typingActive: true,
        }),
        updateStream: async () => undefined,
        completeStream: async () => undefined,
        abortStream: async () => undefined,
      };

      const handle = await adapter.startStream({
        mode: "official-account",
        openId: "oUser1",
      });
      expect(handle.streamId).toBe("stream-1");
      expect(handle.target.openId).toBe("oUser1");
    });
  });

  describe("3-tier target addressing", () => {
    it("formats and parses p2p:<userId> business context IDs", () => {
      const ctxId = formatWeixinP2pContextId("oOpenId_Abc-123");
      expect(ctxId).toBe("p2p:oOpenId_Abc-123");
      expect(parseWeixinTargetFromContextId(ctxId)).toBe("oOpenId_Abc-123");
      expect(() => formatWeixinP2pContextId("   ")).toThrow(ConnectorValidationError);
    });

    it("ignores bare UUID contextIds so pre-allocated outbound contexts are never mistaken for OpenIDs", () => {
      expect(
        parseWeixinTargetFromContextId("550e8400-e29b-41d4-a716-446655440000"),
      ).toBeUndefined();
      expect(parseWeixinTargetFromContextId("p2p:   ")).toBeUndefined();
    });

    it("prioritizes explicit params.openId / params.toUserId > contextId > ConnectorTargetRequiredError", () => {
      expect(
        resolveWeixinSendTarget("weixin", "p2p:fallback_openid", {
          openId: "explicit_openid",
        }),
      ).toBe("explicit_openid");

      expect(
        resolveWeixinSendTarget("weixin", "p2p:fallback_openid", {
          toUserId: "explicit_ilink_user",
        }),
      ).toBe("explicit_ilink_user");

      expect(resolveWeixinSendTarget("weixin", "p2p:fallback_openid", {})).toBe("fallback_openid");

      expect(() =>
        resolveWeixinSendTarget("weixin", "550e8400-e29b-41d4-a716-446655440000", {}),
      ).toThrow(ConnectorTargetRequiredError);
    });
  });

  describe("BoundedIdSet", () => {
    it("tracks seen IDs and evicts oldest entries when capacity is exceeded", () => {
      const set = new BoundedIdSet(3);
      expect(set.add("m1")).toBe(true);
      expect(set.add("m1")).toBe(false);
      expect(set.has("m1")).toBe(true);

      set.add("m2");
      set.add("m3");
      expect(set.size).toBe(3);

      set.add("m4");
      expect(set.size).toBe(3);
      expect(set.has("m1")).toBe(false);
      expect(set.has("m4")).toBe(true);

      expect(set.add("   ")).toBe(false);
      set.clear();
      expect(set.size).toBe(0);
    });

    it("rejects non-positive capacity", () => {
      expect(() => new BoundedIdSet(0)).toThrow(ConnectorValidationError);
    });
  });

  describe("splitWeixinText", () => {
    it("returns single chunk when within char and UTF-8 byte limits", () => {
      expect(splitWeixinText("短消息测试", { maxChars: 100, maxUtf8Bytes: 200 })).toEqual([
        "短消息测试",
      ]);
    });

    it("splits long multi-line text cleanly on newline boundaries", () => {
      const lineA = "A".repeat(40);
      const lineB = "B".repeat(40);
      const lineC = "C".repeat(40);
      const chunks = splitWeixinText(`${lineA}\n${lineB}\n${lineC}`, {
        maxChars: 90,
        maxUtf8Bytes: 0,
      });
      expect(chunks).toEqual([`${lineA}\n${lineB}`, lineC]);
    });

    it("enforces UTF-8 byte budget for Chinese characters and surrogate-pair emojis without corrupting code points", () => {
      // Each Chinese char is 3 UTF-8 bytes; 700 Chinese chars = 2100 bytes (> 2000 bytes limit, < 1800 chars)
      const chineseText = "微".repeat(700);
      const chunks = splitWeixinText(chineseText, {
        maxChars: 1800,
        maxUtf8Bytes: 2000,
      });
      expect(chunks.length).toBe(2);
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(2000);
      }
      expect(chunks.join("")).toBe(chineseText);

      // Surrogate pair emoji: 😀 is 2 UTF-16 code units and 4 UTF-8 bytes
      const emojiText = "😀".repeat(15);
      const emojiChunks = splitWeixinText(emojiText, {
        maxChars: 11, // odd UTF-16 length would bisect surrogate pair if naive slice were used!
        maxUtf8Bytes: 25,
      });
      for (const chunk of emojiChunks) {
        expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(25);
        expect(chunk).not.toContain("\uFFFD");
        // Ensure no lone surrogates
        expect(/^[\u{1F600}]+$/u.test(chunk)).toBe(true);
      }
      expect(emojiChunks.join("")).toBe(emojiText);
    });

    it("closes and reopens fenced Markdown code blocks across chunks", () => {
      const codeBody = Array.from({ length: 12 }, (_, idx) => `const x${idx} = ${idx};`).join("\n");
      const markdown = `Intro:\n\`\`\`ts\n${codeBody}\n\`\`\`\nDone.`;
      const chunks = splitWeixinText(markdown, {
        maxChars: 110,
        maxUtf8Bytes: 0,
      });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]?.endsWith("\n```")).toBe(true);
      expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
    });
  });
});
