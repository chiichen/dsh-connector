import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  createConnectorContext,
  extractContextMarker,
} from "@dsh-connector/core";
import { describe, expect, it, vi } from "vitest";
import { TelegramApiClient } from "../src/api-client";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../src/constants";
import { TelegramSender } from "../src/sender";

const SAMPLE_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

describe("TelegramSender", () => {
  it("sends message using contextId fallback and preserves Forum Topic thread + message handles", async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const apiClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        sentPayloads.push(body);
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 501,
              message_thread_id: 88,
              date: 1732350000,
              chat: { id: -100777, type: "supergroup" },
              text: body["text"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });

    const sender = new TelegramSender({
      connectorName: "telegram",
      apiClient,
    });

    const ctx = createConnectorContext("telegram", "group:-100777:88");
    const result = await sender.send(ctx, {
      text: "Deployment finished.",
      replyToMessageId: 499,
    });

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toMatchObject({
      chat_id: -100777,
      message_thread_id: 88,
      text: "<!-- dsh-ctx:group:-100777:88 -->\nDeployment finished.",
      reply_parameters: { message_id: 499, allow_sending_without_reply: true },
    });
    expect(result.messageId).toBe(501);
    expect(result.messageIds).toEqual([501]);
    expect(result.externalId).toBe("501");
    expect(result.chatId).toBe(-100777);
    expect(result.messageThreadId).toBe(88);
    expect(result.raw).toHaveLength(1);
  });

  it("splits messages >4096 chars, embeds optional context marker safely within 4096 limit, and attaches reply_parameters only to first chunk", async () => {
    const sentTexts: string[] = [];
    const sentBodies: Array<Record<string, unknown>> = [];
    let nextId = 1000;

    const apiClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        sentBodies.push(body);
        sentTexts.push(String(body["text"]));
        nextId += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: nextId,
              message_thread_id: 12,
              date: 1732350000,
              chat: { id: -100999, type: "supergroup" },
              text: body["text"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });

    const sender = new TelegramSender({
      connectorName: "telegram",
      apiClient,
      includeContextMarker: true,
      contextMarkerStyle: "bracket",
    });

    const uuidCtx = createConnectorContext("telegram", "550e8400-e29b-41d4-a716-446655440000");
    const longBody = `${"LineA ".repeat(700)}\n${"LineB ".repeat(500)}`;

    const result = await sender.send(uuidCtx, {
      text: longBody,
      chatId: -100999,
      messageThreadId: 12,
      replyToMessageId: 777,
    });

    expect(sentTexts.length).toBeGreaterThanOrEqual(2);
    for (const chunk of sentTexts) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }

    // First chunk carries the context marker and reply_parameters; continuation chunks stay in topic without duplicate reply_parameters
    const extracted = extractContextMarker(sentTexts[0] ?? "");
    expect(extracted.contextId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(sentBodies[0]?.["reply_parameters"]).toEqual({
      message_id: 777,
      allow_sending_without_reply: true,
    });
    expect(sentBodies[0]?.["message_thread_id"]).toBe(12);
    expect(sentBodies[1]?.["reply_parameters"]).toBeUndefined();
    expect(sentBodies[1]?.["message_thread_id"]).toBe(12);

    expect(result.messageId).toBe(1001);
    expect(result.messageIds).toEqual([1001, 1002]);
    expect(result.data.chunkCount).toBe(2);
  });

  it("throws ConnectorTargetRequiredError on UUID context without explicit chatId and ConnectorValidationError on empty text", async () => {
    const apiClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(),
    });
    const sender = new TelegramSender({
      connectorName: "telegram",
      apiClient,
    });
    const uuidCtx = createConnectorContext("telegram", "550e8400-e29b-41d4-a716-446655440000");

    await expect(sender.send(uuidCtx, { text: "Hello" })).rejects.toThrow(
      ConnectorTargetRequiredError,
    );
    await expect(sender.send(uuidCtx, { text: "", chatId: 123 })).rejects.toThrow(
      ConnectorValidationError,
    );
  });
});
