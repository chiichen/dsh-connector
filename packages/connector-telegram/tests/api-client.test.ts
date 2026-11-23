import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import { describe, expect, it, vi } from "vitest";
import { TelegramApiClient, TelegramRateLimitError } from "../src/api-client";

const SAMPLE_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TelegramApiClient", () => {
  it("validates botToken on construction", () => {
    expect(() => new TelegramApiClient({ botToken: "   " })).toThrow(ConnectorValidationError);
    expect(() => new TelegramApiClient({ botToken: "bad\ntoken" })).toThrow(
      ConnectorValidationError,
    );
  });

  it("calls getMe, getUpdates, sendMessage, editMessageText, sendChatAction, and sendMessageDraft with official Bot API payloads", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });

      if (url.endsWith("/getMe")) {
        return jsonResponse({
          ok: true,
          result: { id: 999, is_bot: true, first_name: "TestBot", username: "test_bot" },
        });
      }
      if (url.endsWith("/getUpdates")) {
        return jsonResponse({
          ok: true,
          result: [{ update_id: 500 }],
        });
      }
      if (url.endsWith("/sendMessage") || url.endsWith("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 77,
            date: 1732350000,
            chat: { id: 123, type: "private" },
            text: String(body["text"] ?? ""),
          },
        });
      }
      return jsonResponse({ ok: true, result: true });
    });

    const client = new TelegramApiClient({
      botToken: ` ${SAMPLE_TOKEN} `,
      apiBaseUrl: "https://api.telegram.org/",
      fetchFn,
    });

    const me = await client.getMe();
    expect(me.username).toBe("test_bot");

    const updates = await client.getUpdates({
      offset: 500,
      timeoutSeconds: 20,
      limit: 50,
      allowedUpdates: ["message"],
    });
    expect(updates).toHaveLength(1);

    const sent = await client.sendMessage({
      chatId: -100555,
      messageThreadId: 9,
      text: "Hello topic",
      replyToMessageId: 41,
      parseMode: "HTML",
      disableNotification: true,
      protectContent: true,
      disableLinkPreview: false,
    });
    expect(sent.message_id).toBe(77);

    const edited = await client.editMessageText({
      chatId: -100555,
      messageId: 77,
      text: "Updated topic",
      parseMode: "HTML",
    });
    expect(edited).toMatchObject({ message_id: 77 });

    const typingOk = await client.sendChatAction({
      chatId: -100555,
      messageThreadId: 9,
    });
    expect(typingOk).toBe(true);

    const draftOk = await client.sendMessageDraft({
      chatId: 123,
      draftId: 1,
      messageThreadId: 2,
      text: "Streaming...",
      canStop: true,
      keepOnStop: true,
    });
    expect(draftOk).toBe(true);

    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${SAMPLE_TOKEN}/getMe`);
    expect(calls[1]?.body).toEqual({
      offset: 500,
      timeout: 20,
      limit: 50,
      allowed_updates: ["message"],
    });
    expect(calls[2]?.body).toEqual({
      chat_id: -100555,
      message_thread_id: 9,
      text: "Hello topic",
      parse_mode: "HTML",
      disable_notification: true,
      protect_content: true,
      link_preview_options: { is_disabled: false },
      reply_parameters: { message_id: 41, allow_sending_without_reply: true },
    });
    expect(calls[3]?.body).toEqual({
      chat_id: -100555,
      message_id: 77,
      text: "Updated topic",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(calls[4]?.body).toEqual({
      chat_id: -100555,
      message_thread_id: 9,
      action: "typing",
    });
    expect(calls[5]?.body).toEqual({
      chat_id: 123,
      draft_id: 1,
      message_thread_id: 2,
      text: "Streaming...",
      can_stop: true,
      keep_on_stop: true,
    });
  });

  it("validates sendMessageDraft non-zero draftId", async () => {
    const client = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(),
    });
    await expect(client.sendMessageDraft({ chatId: 123, draftId: 0, text: "bad" })).rejects.toThrow(
      ConnectorValidationError,
    );
  });

  it("retries sendMessage on HTTP 429 respecting parameters.retry_after and fails when budget exceeded", async () => {
    const delays: number[] = [];
    let attempt = 0;
    const fetchFn: typeof fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt < 3) {
        return jsonResponse(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 2",
            parameters: { retry_after: 2 },
          },
          429,
        );
      }
      return jsonResponse({
        ok: true,
        result: { message_id: 88, date: 1732350000, chat: { id: 123, type: "private" } },
      });
    });

    const client = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });

    const res = await client.sendMessage({ chatId: 123, text: "Eventually delivered" });
    expect(res.message_id).toBe(88);
    expect(delays).toEqual([2000, 2000]);

    // Exceeding maxRetryAfterMs fails immediately with TelegramRateLimitError
    const strictClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      maxRetryAfterMs: 1000,
      fetchFn: vi.fn(async () =>
        jsonResponse(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 5",
            parameters: { retry_after: 5 },
          },
          429,
        ),
      ),
      sleepFn: async () => {},
    });

    await expect(strictClient.sendMessage({ chatId: 123, text: "Flood" })).rejects.toThrow(
      TelegramRateLimitError,
    );
  });

  it("maps 401 to ConnectorAuthError and 400/500/invalid JSON/network failures to ConnectorTransportError", async () => {
    const client401 = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(async () =>
        jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401),
      ),
    });
    await expect(client401.getMe()).rejects.toThrow(ConnectorAuthError);

    const client400 = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(async () =>
        jsonResponse(
          { ok: false, error_code: 400, description: "Bad Request: chat not found" },
          400,
        ),
      ),
    });
    await expect(client400.sendMessage({ chatId: 999, text: "hi" })).rejects.toMatchObject({
      statusCode: 400,
      retryable: false,
    });

    const client502 = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(async () => new Response("Bad Gateway", { status: 502 })),
    });
    await expect(client502.getMe()).rejects.toThrow(ConnectorTransportError);

    const clientNetErr = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(clientNetErr.getMe()).rejects.toMatchObject({
      retryable: true,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(clientNetErr.getMe({ signal: controller.signal })).rejects.toThrow();
  });
});
