import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_TELEGRAM_API_BASE_URL,
  DEFAULT_TELEGRAM_CONNECTOR_NAME,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
} from "../src/constants";
import { telegramReceiveSchema, telegramSendSchema } from "../src/types";

describe("constants and Zod contracts", () => {
  it("exposes Telegram Bot API ground-truth protocol constants", () => {
    expect(DEFAULT_TELEGRAM_CONNECTOR_NAME).toBe("telegram");
    expect(DEFAULT_TELEGRAM_API_BASE_URL).toBe("https://api.telegram.org");
    expect(TELEGRAM_MAX_MESSAGE_LENGTH).toBe(4096);
    expect(TELEGRAM_WEBHOOK_SECRET_HEADER).toBe("x-telegram-bot-api-secret-token");
  });

  it("validates telegramSendSchema with required text and optional target/formatting fields", () => {
    const minimal = telegramSendSchema.parse({ text: "Hello Telegram!" });
    expect(minimal).toEqual({ text: "Hello Telegram!" });

    const full = telegramSendSchema.parse({
      text: "Detailed alert",
      chatId: -1001234567890,
      messageThreadId: 12,
      replyToMessageId: 345,
      parseMode: "MarkdownV2",
      disableNotification: true,
      protectContent: false,
      disableLinkPreview: true,
    });
    expect(full.chatId).toBe(-1001234567890);
    expect(full.messageThreadId).toBe(12);
    expect(full.replyToMessageId).toBe(345);
    expect(full.parseMode).toBe("MarkdownV2");

    expect(() => telegramSendSchema.parse({ text: "" })).toThrow();
    expect(() => telegramSendSchema.parse({})).toThrow();
    expect(() => telegramSendSchema.parse({ text: "hi", messageThreadId: 0 })).toThrow();

    // Verify JSON Schema serializability for DSH tool bridge compatibility
    const jsonSchema = z.toJSONSchema(telegramSendSchema);
    expect(jsonSchema["type"]).toBe("object");
    expect(jsonSchema["required"]).toEqual(["text"]);
  });

  it("validates normalized telegramReceiveSchema payloads", () => {
    const parsed = telegramReceiveSchema.parse({
      updateId: 1001,
      messageId: 42,
      chatId: -100999,
      chatType: "supergroup",
      chatTitle: "Engineering",
      messageThreadId: 7,
      isTopicMessage: true,
      from: {
        id: 888,
        isBot: false,
        firstName: "Alice",
        username: "alice",
      },
      text: "Please check deployment status",
      rawText: "@ops_bot Please check deployment status",
      date: 1732350000,
      mentionedBot: true,
      replyToMessage: {
        messageId: 40,
        fromId: 777,
        fromUsername: "ops_bot",
        fromName: "Ops Bot",
        isFromBot: true,
        text: "Deployment started",
        quote: "Deployment",
        date: 1732349900,
      },
    });

    expect(parsed.chatType).toBe("supergroup");
    expect(parsed.messageThreadId).toBe(7);
    expect(parsed.replyToMessage?.quote).toBe("Deployment");
  });
});
