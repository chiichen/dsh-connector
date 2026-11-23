import {
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
} from "@dsh-connector/core";
import { describe, expect, it, vi } from "vitest";
import { TelegramConnector, createTelegramConnector } from "../src/connector";
import { TELEGRAM_WEBHOOK_SECRET_HEADER } from "../src/constants";
import type {
  TelegramStreamFinalizeParams,
  TelegramStreamHandle,
  TelegramStreamingAdapter,
  TelegramStreamTarget,
} from "../src/streaming";

const SAMPLE_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

describe("TelegramConnector & createTelegramConnector", () => {
  it("validates connector name, botToken, and webhookSecretToken eagerly", () => {
    expect(() =>
      createTelegramConnector({
        name: "Invalid--Name",
        botToken: SAMPLE_TOKEN,
      }),
    ).toThrow(ConnectorValidationError);

    expect(() =>
      createTelegramConnector({
        botToken: "",
      }),
    ).toThrow(ConnectorValidationError);

    expect(() =>
      createTelegramConnector({
        botToken: SAMPLE_TOKEN,
        webhookSecretToken: "invalid spaces!",
      }),
    ).toThrow(ConnectorValidationError);
  });

  it("defaults to webhook mode when webhookSecretToken is provided and runs end-to-end non-streaming webhook -> send loop", async () => {
    const sentRequests: Array<Record<string, unknown>> = [];
    const fetchFn: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sentRequests.push(body);
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 901,
            message_thread_id: 33,
            date: 1732350000,
            chat: { id: -100888, type: "supergroup" },
            text: body["text"],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const connector = createTelegramConnector({
      name: "telegram-ops",
      botToken: SAMPLE_TOKEN,
      botId: 500,
      botUsername: "ops_bot",
      webhookSecretToken: "Secret_123",
      fetchFn,
    });

    expect(connector).toBeInstanceOf(TelegramConnector);
    expect(connector.name).toBe("telegram-ops");
    expect(connector.getMode()).toBe("webhook");
    expect(connector.getStreamingAdapter()).toBeUndefined();

    const receiver = connector.getReceiver();
    const sender = connector.getSender();
    const generator = createDefaultContextIdGenerator();

    let capturedContextId = "";
    await receiver.init({
      allocateContextId: () => generator.generate("telegram-ops"),
      contextIdGenerator: generator,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onReceive: async (ctx) => {
        capturedContextId = ctx.contextId;
        return { sessionId: "session-1" };
      },
    });

    // start() in webhook mode must NOT call getUpdates
    await connector.start();
    expect(fetchFn).not.toHaveBeenCalled();

    const webhookRes = await receiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram-ops",
      subPath: "/",
      query: new URLSearchParams(),
      headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: "Secret_123" },
      rawBody: new TextEncoder().encode(
        JSON.stringify({
          update_id: 77,
          message: {
            message_id: 400,
            message_thread_id: 33,
            date: 1732350000,
            chat: { id: -100888, type: "supergroup", title: "Ops" },
            from: { id: 99, is_bot: false, first_name: "Eve" },
            text: "@ops_bot check cluster health",
          },
        }),
      ),
    });

    expect(webhookRes.status).toBe(200);
    expect(capturedContextId).toBe("group:-100888:33");

    // Outbound reply using the captured contextId routes back to chat -100888 topic 33 automatically
    const sendResult = await sender.send(createConnectorContext(connector, capturedContextId), {
      text: "All nodes healthy.",
    });
    expect(sendResult.messageId).toBe(901);
    expect(sentRequests[0]).toMatchObject({
      chat_id: -100888,
      message_thread_id: 33,
      text: "All nodes healthy.",
    });

    await connector.stop();
  });

  it("preserves optional TelegramStreamingAdapter & TelegramStreamingOptions extension slots without invoking them during non-streaming runtime", () => {
    const mockStreamingAdapter: TelegramStreamingAdapter = {
      sendTypingIndicator: vi.fn(async () => {}),
      startStream: vi.fn(async (target: TelegramStreamTarget): Promise<TelegramStreamHandle> => ({
        mode: "edit-message",
        chatId: target.chatId,
        anchorMessageId: 1,
      })),
      updateStream: vi.fn(
        async (handle: TelegramStreamHandle): Promise<TelegramStreamHandle> => handle,
      ),
      completeStream: vi.fn(
        async (handle: TelegramStreamHandle, finalMsg: TelegramStreamFinalizeParams) => ({
          externalId: "1",
          messageId: 1,
          messageIds: [1],
          chatId: handle.chatId,
          raw: [],
          summary: finalMsg.text,
          data: {
            chatId: handle.chatId,
            messageId: 1,
            messageIds: [1],
            chunkCount: 1,
          },
        }),
      ),
    };

    const connector = createTelegramConnector({
      botToken: SAMPLE_TOKEN,
      mode: "passive",
      streaming: {
        preferredMode: "message-draft",
        throttleIntervalMs: 400,
        typingKeepaliveIntervalMs: 4000,
        adapter: mockStreamingAdapter,
      },
      fetchFn: vi.fn(),
    });

    expect(connector.getMode()).toBe("passive");
    expect(connector.getStreamingAdapter()).toBe(mockStreamingAdapter);
    expect(connector.getStreamingOptions()?.preferredMode).toBe("message-draft");
    expect(connector.getApiClient()).toBeDefined();
  });
});
