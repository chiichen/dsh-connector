import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  createConnectorContext,
} from "@dsh-connector/core";
import { describe, expect, it } from "vitest";
import {
  DISCORD_DEFAULT_INTENTS,
  DISCORD_GATEWAY_CLOSE_CODES,
  DISCORD_GATEWAY_INTENTS,
  DISCORD_GATEWAY_OPCODES,
  DISCORD_INTERACTION_CALLBACK_TYPES,
  DISCORD_INTERACTION_TYPES,
  DISCORD_MAX_MESSAGE_LENGTH,
  assertDiscordSnowflake,
  discordReceiveSchema,
  discordSendSchema,
  formatDiscordChannelContextId,
  formatDiscordDmContextId,
  formatDiscordThreadContextId,
  formatDiscordUserContextId,
  isDiscordSnowflake,
  parseDiscordContextTarget,
  resolveDiscordSendTarget,
  splitDiscordMessage,
  stripDiscordBotMentions,
} from "../src";

describe("Stage 1: Discord protocol constants, schemas, target routing, and message chunking", () => {
  describe("protocol constants & intents bitmask", () => {
    it("matches official Discord API v10 Gateway opcodes, intents, close codes, and interaction types", () => {
      expect(DISCORD_MAX_MESSAGE_LENGTH).toBe(2000);
      expect(DISCORD_GATEWAY_OPCODES.DISPATCH).toBe(0);
      expect(DISCORD_GATEWAY_OPCODES.HEARTBEAT).toBe(1);
      expect(DISCORD_GATEWAY_OPCODES.IDENTIFY).toBe(2);
      expect(DISCORD_GATEWAY_OPCODES.RESUME).toBe(6);
      expect(DISCORD_GATEWAY_OPCODES.RECONNECT).toBe(7);
      expect(DISCORD_GATEWAY_OPCODES.INVALID_SESSION).toBe(9);
      expect(DISCORD_GATEWAY_OPCODES.HELLO).toBe(10);
      expect(DISCORD_GATEWAY_OPCODES.HEARTBEAT_ACK).toBe(11);

      expect(DISCORD_GATEWAY_INTENTS.GUILDS).toBe(1 << 0);
      expect(DISCORD_GATEWAY_INTENTS.GUILD_MESSAGES).toBe(1 << 9);
      expect(DISCORD_GATEWAY_INTENTS.DIRECT_MESSAGES).toBe(1 << 12);
      expect(DISCORD_GATEWAY_INTENTS.MESSAGE_CONTENT).toBe(1 << 15);
      expect(DISCORD_DEFAULT_INTENTS).toBe((1 << 0) | (1 << 9) | (1 << 12) | (1 << 15));

      expect(DISCORD_GATEWAY_CLOSE_CODES.AUTHENTICATION_FAILED).toBe(4004);
      expect(DISCORD_GATEWAY_CLOSE_CODES.INVALID_INTENTS).toBe(4013);
      expect(DISCORD_GATEWAY_CLOSE_CODES.DISALLOWED_INTENTS).toBe(4014);

      expect(DISCORD_INTERACTION_TYPES.PING).toBe(1);
      expect(DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND).toBe(2);
      expect(DISCORD_INTERACTION_TYPES.MESSAGE_COMPONENT).toBe(3);
      expect(DISCORD_INTERACTION_TYPES.MODAL_SUBMIT).toBe(5);
      expect(DISCORD_INTERACTION_CALLBACK_TYPES.PONG).toBe(1);
      expect(DISCORD_INTERACTION_CALLBACK_TYPES.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE).toBe(5);
    });
  });

  describe("snowflake validation", () => {
    it("validates numeric Discord snowflakes and rejects malformed values", () => {
      expect(isDiscordSnowflake("80351110224678912")).toBe(true);
      expect(isDiscordSnowflake("12345")).toBe(true);
      expect(isDiscordSnowflake("")).toBe(false);
      expect(isDiscordSnowflake("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
      expect(isDiscordSnowflake("123/../../etc")).toBe(false);

      expect(assertDiscordSnowflake(" 80351110224678912 ", "channelId")).toBe("80351110224678912");
      expect(() => assertDiscordSnowflake("not-a-snowflake", "channelId")).toThrow(
        ConnectorValidationError,
      );
    });
  });

  describe("contextId formatting & target parsing", () => {
    it("formats and parses DM, user, channel, and thread contextIds", () => {
      const dmCtx = formatDiscordDmContextId("319674150115610528");
      expect(dmCtx).toBe("dm:319674150115610528");
      expect(parseDiscordContextTarget(dmCtx)).toEqual({
        kind: "dm",
        channelId: "319674150115610528",
      });

      const userCtx = formatDiscordUserContextId("80351110224678912");
      expect(userCtx).toBe("user:80351110224678912");
      expect(parseDiscordContextTarget(userCtx)).toEqual({
        kind: "user",
        userId: "80351110224678912",
      });

      const chanCtx = formatDiscordChannelContextId("41771983423143937");
      expect(chanCtx).toBe("channel:41771983423143937");
      expect(parseDiscordContextTarget(chanCtx)).toEqual({
        kind: "channel",
        channelId: "41771983423143937",
      });

      const threadWithParentCtx = formatDiscordThreadContextId(
        "999888777666555444",
        "41771983423143937",
      );
      expect(threadWithParentCtx).toBe("thread:41771983423143937:999888777666555444");
      expect(parseDiscordContextTarget(threadWithParentCtx)).toEqual({
        kind: "thread",
        channelId: "999888777666555444",
        threadId: "999888777666555444",
        parentChannelId: "41771983423143937",
      });

      const threadOnlyCtx = formatDiscordThreadContextId("999888777666555444");
      expect(threadOnlyCtx).toBe("thread:999888777666555444");
      expect(parseDiscordContextTarget(threadOnlyCtx)).toEqual({
        kind: "thread",
        channelId: "999888777666555444",
        threadId: "999888777666555444",
      });

      expect(parseDiscordContextTarget("channel:41771983423143937:999888777666555444")).toEqual({
        kind: "thread",
        channelId: "999888777666555444",
        threadId: "999888777666555444",
        parentChannelId: "41771983423143937",
      });
    });

    it("returns undefined for bare UUIDs or unrecognized contextIds so UUIDs are never sent as channel IDs", () => {
      expect(parseDiscordContextTarget("550e8400-e29b-41d4-a716-446655440000")).toBeUndefined();
      expect(parseDiscordContextTarget("80351110224678912")).toBeUndefined();
      expect(parseDiscordContextTarget("dm:not-numeric")).toBeUndefined();
      expect(parseDiscordContextTarget("thread:123:456:789")).toBeUndefined();
      expect(parseDiscordContextTarget("unknown:123456")).toBeUndefined();
    });
  });

  describe("three-level target resolution (params > context.contextId > ConnectorTargetRequiredError)", () => {
    it("prioritizes explicit params over context.contextId", () => {
      const ctx = createConnectorContext("discord", "channel:111111111111111111");

      expect(
        resolveDiscordSendTarget(ctx, {
          text: "hello",
          threadId: "333333333333333333",
          channelId: "222222222222222222",
        }),
      ).toEqual({
        kind: "thread",
        channelId: "333333333333333333",
        threadId: "333333333333333333",
        parentChannelId: "222222222222222222",
      });

      expect(
        resolveDiscordSendTarget(ctx, {
          text: "hello",
          channelId: "222222222222222222",
        }),
      ).toEqual({
        kind: "channel",
        channelId: "222222222222222222",
      });

      expect(
        resolveDiscordSendTarget(ctx, {
          text: "hello",
          userId: "444444444444444444",
        }),
      ).toEqual({
        kind: "user",
        userId: "444444444444444444",
      });
    });

    it("falls back to structured context.contextId when params omit target fields", () => {
      const threadCtx = createConnectorContext(
        "discord",
        "thread:111111111111111111:222222222222222222",
      );
      expect(resolveDiscordSendTarget(threadCtx, { text: "reply in thread" })).toEqual({
        kind: "thread",
        channelId: "222222222222222222",
        threadId: "222222222222222222",
        parentChannelId: "111111111111111111",
      });
    });

    it("throws ConnectorTargetRequiredError when context.contextId is an outbound-first UUID", () => {
      const uuidCtx = createConnectorContext("discord", "550e8400-e29b-41d4-a716-446655440000");
      expect(() => resolveDiscordSendTarget(uuidCtx, { text: "proactive ping" })).toThrow(
        ConnectorTargetRequiredError,
      );
    });
  });

  describe("bot mention stripping & schemas", () => {
    it("strips both <@id> and legacy <@!id> bot mentions cleanly", () => {
      expect(
        stripDiscordBotMentions(
          "  <@987654321098765432> please check <@!987654321098765432> status  ",
          "987654321098765432",
        ),
      ).toBe("please check status");
      expect(stripDiscordBotMentions("  hello world  ", "   ")).toBe("hello world");
    });

    it("validates discordSendSchema with primary text field and optional target fields", () => {
      const valid = discordSendSchema.safeParse({
        text: "Deployment finished",
        channelId: "41771983423143937",
        replyToMessageId: "334385199974967042",
      });
      expect(valid.success).toBe(true);

      const empty = discordSendSchema.safeParse({ text: "" });
      expect(empty.success).toBe(false);
    });

    it("validates discordReceiveSchema for message and interaction events", () => {
      const parsed = discordReceiveSchema.safeParse({
        source: "gateway-message",
        eventId: "334385199974967042",
        channelId: "290926798999357250",
        authorId: "53908099506183680",
        authorName: "Mason",
        text: "Hello bot",
        isDirectMessage: true,
        isThread: false,
        timestamp: "2026-11-23T10:00:00.000Z",
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("2000-character message chunking (splitDiscordMessage)", () => {
    it("keeps messages within 2000 characters in a single chunk", () => {
      expect(splitDiscordMessage("Hello Discord!")).toEqual(["Hello Discord!"]);
      const exact2000 = "a".repeat(2000);
      expect(splitDiscordMessage(exact2000)).toEqual([exact2000]);
    });

    it("splits long paragraphs on natural newline/whitespace boundaries within maxLength", () => {
      const p1 = "First paragraph. ".repeat(70).trim();
      const p2 = "Second paragraph. ".repeat(70).trim();
      const chunks = splitDiscordMessage(`${p1}\n\n${p2}`, 2000);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
      expect(chunks.join("\n\n")).toContain("First paragraph.");
      expect(chunks.join("\n\n")).toContain("Second paragraph.");
    });

    it("closes and reopens fenced Markdown code blocks across chunk boundaries", () => {
      const codeBody = Array.from({ length: 120 }, (_, i) => `const line_${i} = ${i};`).join("\n");
      const markdown = `Here is the code:\n\`\`\`ts\n${codeBody}\n\`\`\`\nDone.`;
      const chunks = splitDiscordMessage(markdown, 600);
      expect(chunks.length).toBeGreaterThan(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(600);
        const fenceCount = (chunk.match(/```/g) ?? []).length;
        expect(fenceCount % 2).toBe(0);
      }
    });

    it("never splits UTF-16 astral surrogate pairs (emojis) across chunk boundaries", () => {
      const emojis = "🚀".repeat(1200); // 1200 code points = 2400 UTF-16 code units
      // Use odd maxLength so raw budget lands directly between high and low surrogate code units
      const chunks = splitDiscordMessage(emojis, 1999);
      expect(chunks.length).toBe(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(1999);
        expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        expect(chunk).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }
      expect(chunks.join("")).toBe(emojis);
    });

    it("handles empty string, invalid maxLength, whitespace splits, and closed fences inside a chunk", () => {
      expect(splitDiscordMessage("")).toEqual([]);
      expect(() => splitDiscordMessage("abc", 8)).toThrow(ConnectorValidationError);

      const spaceSeparated = Array.from({ length: 40 }, () => "wordtoken").join(" ");
      const spaceChunks = splitDiscordMessage(spaceSeparated, 80);
      expect(spaceChunks.length).toBeGreaterThan(1);
      for (const chunk of spaceChunks) {
        expect(chunk.length).toBeLessThanOrEqual(80);
      }

      const inlineClosedFence = `\`\`\`js\nconst a = 1;\n\`\`\`\n${"tail ".repeat(60)}`;
      const fenceChunks = splitDiscordMessage(inlineClosedFence, 120);
      expect(fenceChunks.length).toBeGreaterThan(1);
      for (const chunk of fenceChunks) {
        expect(chunk.length).toBeLessThanOrEqual(120);
      }
    });
  });
});
