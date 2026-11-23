import {
  createDefaultContextIdGenerator,
  type ConnectorLogger,
  type ConnectorReceiverContext,
} from "@dsh-connector/core";
import { describe, expect, it, vi } from "vitest";
import { TelegramApiClient } from "../src/api-client";
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
} from "../src/constants";
import { TelegramReceiver } from "../src/receiver";
import type { TelegramOffsetStore, TelegramReceivePayload, TelegramUpdate } from "../src/types";

const SAMPLE_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const WEBHOOK_SECRET = "Webhook_Secret_Token_2026";

function createTestLogger(): ConnectorLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createReceiverCtx(
  onReceiveImpl?: ConnectorReceiverContext<
    typeof import("../src/types").telegramReceiveSchema,
    "telegram"
  >["onReceive"],
): {
  ctx: ConnectorReceiverContext<typeof import("../src/types").telegramReceiveSchema, "telegram">;
  received: Array<{ contextId: string; payload: TelegramReceivePayload; idempotencyKey?: string }>;
} {
  const received: Array<{
    contextId: string;
    payload: TelegramReceivePayload;
    idempotencyKey?: string;
  }> = [];
  const generator = createDefaultContextIdGenerator();
  const logger = createTestLogger();

  const ctx: ConnectorReceiverContext<
    typeof import("../src/types").telegramReceiveSchema,
    "telegram"
  > = {
    allocateContextId: () => generator.generate("telegram"),
    contextIdGenerator: generator,
    logger,
    onReceive:
      onReceiveImpl ??
      (async (context, params, meta) => {
        received.push({
          contextId: context.contextId,
          payload: params,
          idempotencyKey: meta?.idempotencyKey,
        });
        return { sessionId: `sess-${received.length}` };
      }),
  };

  return { ctx, received };
}

function encodeBody(data: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data));
}

describe("TelegramReceiver (Webhook & getUpdates Long Polling)", () => {
  it("verifies webhook method, secret token, JSON body, dispatches updates, and forwards stopped_message_generation", async () => {
    const stoppedEvents: Array<{ chatId: number; draftId: number }> = [];
    const apiClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(),
    });
    const receiver = new TelegramReceiver({
      connectorName: "telegram",
      apiClient,
      botId: 900,
      botUsername: "my_bot",
      webhookSecretToken: WEBHOOK_SECRET,
      onGenerationStopped: (ev) => {
        stoppedEvents.push({ chatId: ev.chatId, draftId: ev.draftId });
      },
    });
    const { ctx, received } = createReceiverCtx();
    await receiver.init(ctx);

    // 405 on GET
    const res405 = await receiver.handleWebhook({
      method: "GET",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new Uint8Array(),
    });
    expect(res405.status).toBe(HTTP_STATUS_METHOD_NOT_ALLOWED);

    // 401 on wrong secret token
    const res401 = await receiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: "wrong_secret" },
      rawBody: encodeBody({ update_id: 1 }),
    });
    expect(res401.status).toBe(HTTP_STATUS_UNAUTHORIZED);

    // 400 on invalid JSON
    const res400 = await receiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET },
      rawBody: new TextEncoder().encode("{broken"),
    });
    expect(res400.status).toBe(HTTP_STATUS_BAD_REQUEST);

    // 200 on stopped_message_generation hook
    const resStopped = await receiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET },
      rawBody: encodeBody({
        update_id: 10,
        stopped_message_generation: {
          chat: { id: 555, type: "private" },
          draft_id: 7,
        },
      }),
    });
    expect(resStopped.status).toBe(HTTP_STATUS_OK);
    expect(stoppedEvents).toEqual([{ chatId: 555, draftId: 7 }]);

    // 200 on valid private chat message
    const res200 = await receiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET },
      rawBody: encodeBody({
        update_id: 11,
        message: {
          message_id: 88,
          date: 1732350000,
          chat: { id: 555, type: "private", first_name: "Alice" },
          from: { id: 555, is_bot: false, first_name: "Alice" },
          text: "Hello via webhook!",
        },
      }),
    });
    expect(res200.status).toBe(HTTP_STATUS_OK);
    expect(received).toHaveLength(1);
    expect(received[0]?.contextId).toBe("p2p:555");
    expect(received[0]?.payload.text).toBe("Hello via webhook!");
  });

  it("returns 401 when webhookSecretToken is unconfigured unless requireWebhookSecretToken: false, and 500 on handler error", async () => {
    const apiClient = new TelegramApiClient({ botToken: SAMPLE_TOKEN, fetchFn: vi.fn() });
    const strictReceiver = new TelegramReceiver({
      connectorName: "telegram",
      apiClient,
    });
    const { ctx } = createReceiverCtx();
    await strictReceiver.init(ctx);

    const resUnauth = await strictReceiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: encodeBody({ update_id: 1 }),
    });
    expect(resUnauth.status).toBe(HTTP_STATUS_UNAUTHORIZED);

    const failingReceiver = new TelegramReceiver({
      connectorName: "telegram",
      apiClient,
      requireWebhookSecretToken: false,
    });
    const failingCtx = createReceiverCtx(async () => {
      throw new Error("DB down");
    });
    await failingReceiver.init(failingCtx.ctx);

    const res500 = await failingReceiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: encodeBody({
        update_id: 2,
        message: {
          message_id: 9,
          date: 1732350000,
          chat: { id: 1, type: "private" },
          from: { id: 1, is_bot: false, first_name: "U" },
          text: "Trigger failure",
        },
      }),
    });
    expect(res500.status).toBe(HTTP_STATUS_INTERNAL_SERVER_ERROR);
  });

  it("manages getUpdates long polling lifecycle, getMe discovery, dropPendingUpdatesOnStart, offsetStore cursor, and error backoff", async () => {
    let savedOffset: number | undefined;
    const offsetStore: TelegramOffsetStore = {
      getOffset: () => savedOffset,
      setOffset: (next) => {
        savedOffset = next;
      },
    };

    const pollOffsets: Array<number | undefined> = [];
    let getUpdatesCallCount = 0;
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const batchUpdates: TelegramUpdate[] = [
      // Bot's own message -> filtered, cursor still advances!
      {
        update_id: 201,
        message: {
          message_id: 1,
          date: 1732350000,
          chat: { id: -1001, type: "supergroup", title: "Team" },
          from: { id: 777000, is_bot: true, first_name: "Bot", username: "auto_bot" },
          text: "@auto_bot self",
        },
      },
      // Addressed group forum message -> dispatched!
      {
        update_id: 202,
        message: {
          message_id: 2,
          message_thread_id: 15,
          date: 1732350001,
          chat: { id: -1001, type: "supergroup", title: "Team" },
          from: { id: 42, is_bot: false, first_name: "Dave" },
          text: "@auto_bot deploy staging",
        },
      },
    ];

    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: 777000, is_bot: true, first_name: "AutoBot", username: "auto_bot" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      getUpdatesCallCount += 1;
      pollOffsets.push(body["offset"] as number | undefined);

      // Call 1: dropPendingUpdatesOnStart (offset = -1)
      if (getUpdatesCallCount === 1) {
        return new Response(JSON.stringify({ ok: true, result: [{ update_id: 200 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Call 2: transient 502 error to test backoff recovery
      if (getUpdatesCallCount === 2) {
        return new Response(
          JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
      // Call 3: deliver updates 201 and 202
      if (getUpdatesCallCount === 3) {
        return new Response(JSON.stringify({ ok: true, result: batchUpdates }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Call 4: verify offset advanced to 203, then wait for abort signal
      resolveDone();
      return await new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener(
          "abort",
          () => rej(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const sleepDelays: number[] = [];
    const sleepFn = async (ms: number): Promise<void> => {
      sleepDelays.push(ms);
    };

    const apiClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn,
      sleepFn,
    });

    const receiver = new TelegramReceiver({
      connectorName: "telegram",
      apiClient,
      sleepFn,
      polling: {
        dropPendingUpdatesOnStart: true,
        offsetStore,
        retryBaseDelayMs: 50,
        retryMaxDelayMs: 500,
      },
    });

    const { ctx, received } = createReceiverCtx();
    await receiver.init(ctx);
    await receiver.startPolling();
    await donePromise;
    await receiver.stopPolling();

    expect(receiver.getBotIdentity()).toEqual({
      id: 777000,
      username: "auto_bot",
      firstName: "AutoBot",
    });
    expect(pollOffsets).toEqual([-1, 201, 201, 203]);
    expect(savedOffset).toBe(203);
    expect(receiver.getCurrentOffset()).toBe(203);
    expect(sleepDelays).toEqual([50]);
    expect(received).toHaveLength(1);
    expect(received[0]?.contextId).toBe("group:-1001:15");
    expect(received[0]?.payload.text).toBe("deploy staging");
  });
});
