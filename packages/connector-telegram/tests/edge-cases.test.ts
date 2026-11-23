import {
  ConnectorError,
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
} from "@dsh-connector/core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TELEGRAM_CONNECTOR_NAME,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
  TelegramApiClient,
  TelegramReceiver,
  createTelegramConnector,
  defaultTelegramSleep,
  parseRawTelegramUpdate,
  parseTelegramContextTarget,
  resolveTelegramSendTarget,
  verifyTelegramWebhookSecretToken,
} from "../src";
import { HTTP_STATUS_BAD_REQUEST } from "../src/constants";

const SAMPLE_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

describe("Stage 4 public barrel exports and comprehensive edge-case coverage", () => {
  it("covers defaultTelegramSleep zero delay, normal timer completion, pre-aborted signal, and mid-flight abort", async () => {
    await expect(defaultTelegramSleep(0)).resolves.toBeUndefined();
    await expect(defaultTelegramSleep(5)).resolves.toBeUndefined();

    const preAborted = new AbortController();
    preAborted.abort(new Error("already cancelled"));
    await expect(defaultTelegramSleep(50, preAborted.signal)).rejects.toThrow("already cancelled");

    const preAbortedNonError = new AbortController();
    preAbortedNonError.abort("string-reason");
    await expect(defaultTelegramSleep(50, preAbortedNonError.signal)).rejects.toThrow();

    const midFlight = new AbortController();
    const pending = defaultTelegramSleep(5000, midFlight.signal);
    setTimeout(() => midFlight.abort(new Error("aborted mid-sleep")), 5);
    await expect(pending).rejects.toThrow("aborted mid-sleep");
  });

  it("covers malformed API envelopes, migrate_to_chat_id parameters, and mid-request abort", async () => {
    const malformedClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(
        async () =>
          new Response(JSON.stringify(["not-an-envelope"]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    await expect(malformedClient.getMe()).rejects.toThrow(/malformed response envelope/);

    const migrateClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: group chat was upgraded to a supergroup chat",
              parameters: { migrate_to_chat_id: -1001234567890 },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    });
    await expect(migrateClient.sendMessage({ chatId: -123, text: "hi" })).rejects.toThrow(
      /upgraded to a supergroup/,
    );

    const abortController = new AbortController();
    const abortingClient = new TelegramApiClient({
      botToken: SAMPLE_TOKEN,
      fetchFn: vi.fn(async (_url, init) => {
        abortController.abort(new Error("caller aborted"));
        throw init?.signal?.reason ?? new Error("aborted");
      }),
    });
    await expect(abortingClient.getMe({ signal: abortController.signal })).rejects.toThrow(
      "caller aborted",
    );
  });

  it("covers context-target numeric zero rejection and multi-header / case-mismatch webhook auth", () => {
    expect(DEFAULT_TELEGRAM_CONNECTOR_NAME).toBe("telegram");
    expect(parseTelegramContextTarget("p2p:0")).toBeUndefined();

    const ctx = createConnectorContext("telegram", "p2p:123");
    expect(() => resolveTelegramSendTarget(ctx, { chatId: 0 })).toThrow(ConnectorValidationError);

    expect(
      verifyTelegramWebhookSecretToken(
        {
          "x-other-header": "ignored",
          [TELEGRAM_WEBHOOK_SECRET_HEADER]: "Secret_OK",
        },
        "Secret_OK",
      ),
    ).toBe(true);
  });

  it("covers rich entity metadata, malformed entity items, sender_chat replies, bare @mention, and malformed Update shapes", () => {
    expect(
      parseRawTelegramUpdate({
        update_id: 500,
        message: { message_id: 1, date: 100, chat: { id: 1, type: "invalid_type" } },
      })?.message,
    ).toBeUndefined();

    expect(
      parseRawTelegramUpdate({
        update_id: 501,
        stopped_message_generation: { draft_id: 1, chat: { id: 1, type: "invalid" } },
      })?.stopped_message_generation,
    ).toBeUndefined();

    const richUpdate = parseRawTelegramUpdate({
      update_id: 502,
      message: {
        message_id: 10,
        date: 1732350000,
        chat: { id: -10077, type: "supergroup", title: "Infra" },
        from: { id: 88, is_bot: false, first_name: "Dan", language_code: "en" },
        text: "@bot_x",
        entities: [
          "invalid-item",
          { type: "mention", offset: -5, length: 2 },
          {
            type: "text_link",
            offset: 0,
            length: 6,
            url: "https://core.telegram.org",
            language: "ts",
            custom_emoji_id: "55",
          },
        ],
        quote: {
          text: "quoted",
          position: 0,
          is_manual: true,
          entities: [{ type: "bold", offset: 0, length: 6 }],
        },
        reply_to_message: {
          message_id: 9,
          date: 1732349000,
          chat: { id: -10077, type: "supergroup", title: "Infra" },
          sender_chat: { id: -10077, type: "supergroup", title: "Infra Announcement" },
          text: "System maintenance window",
        },
      },
    });

    expect(richUpdate?.message?.entities).toHaveLength(2);
    expect(richUpdate?.message?.quote?.is_manual).toBe(true);
    expect(richUpdate?.message?.reply_to_message?.sender_chat?.title).toBe("Infra Announcement");
  });

  it("covers receiver guard errors, storedOffset resume, onUpdateError skip mode, 401 poll stop, 429 poll backoff, and connector polling start", async () => {
    const uninitializedReceiver = new TelegramReceiver({
      connectorName: "telegram",
      apiClient: new TelegramApiClient({ botToken: SAMPLE_TOKEN, fetchFn: vi.fn() }),
    });
    await expect(uninitializedReceiver.startPolling()).rejects.toThrow(ConnectorError);

    // Invalid Update JSON shape (valid JSON, missing integer update_id) -> 400
    const generator = createDefaultContextIdGenerator();
    uninitializedReceiver.init({
      allocateContextId: () => generator.generate("telegram"),
      contextIdGenerator: generator,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onReceive: async () => ({ sessionId: "s1" }),
    });
    const badShapeRes = await uninitializedReceiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new TextEncoder().encode(JSON.stringify({ hello: "world" })),
    });
    // Without secret token configured, returns 401 first; test with requireWebhookSecretToken: false
    expect(badShapeRes.status).toBe(401);

    const openReceiver = new TelegramReceiver({
      connectorName: "telegram",
      apiClient: new TelegramApiClient({ botToken: SAMPLE_TOKEN, fetchFn: vi.fn() }),
      requireWebhookSecretToken: false,
      botId: 10,
      botUsername: "bot_ten",
    });
    openReceiver.init({
      allocateContextId: () => generator.generate("telegram"),
      contextIdGenerator: generator,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onReceive: async () => ({ sessionId: "s1" }),
    });
    const res400 = await openReceiver.handleWebhook({
      method: "POST",
      pathname: "/connectors/webhook/telegram",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new TextEncoder().encode(JSON.stringify({ not_an_update: true })),
    });
    expect(res400.status).toBe(HTTP_STATUS_BAD_REQUEST);

    const formatted = openReceiver.formatInbound(
      {
        updateId: 1,
        messageId: 2,
        chatId: 3,
        chatType: "private",
        from: { id: 3, isBot: false, firstName: "Tim" },
        text: "Ping",
        rawText: "Ping",
        date: 1732350000,
        mentionedBot: false,
      },
      createConnectorContext("telegram", "p2p:3"),
    );
    expect(formatted.title).toBe("[Telegram] Tim");

    // Connector in "polling" mode: restores storedOffset, skips failing update with onUpdateError: "skip",
    // handles 429 poll backoff, forwards stopped_message_generation to streamingAdapter, and stops cleanly on 401
    let persistedOffset: number | undefined = 50;
    const stoppedDrafts: number[] = [];
    let pollStep = 0;
    let resolveStep3!: () => void;
    const step3Reached = new Promise<void>((resolve) => {
      resolveStep3 = resolve;
    });

    const connector = createTelegramConnector({
      botToken: SAMPLE_TOKEN,
      botId: 800,
      botUsername: "poll_bot",
      mode: "polling",
      streamingAdapter: {
        startStream: async (target) => ({
          mode: "message-draft",
          chatId: target.chatId,
          draftId: 1,
        }),
        updateStream: async (h) => h,
        completeStream: async (h, f) => ({
          externalId: "1",
          messageId: 1,
          messageIds: [1],
          chatId: h.chatId,
          raw: [],
          summary: f.text,
          data: { chatId: h.chatId, messageId: 1, messageIds: [1], chunkCount: 1 },
        }),
        onGenerationStopped: (ev) => {
          stoppedDrafts.push(ev.draftId);
        },
      },
      polling: {
        offsetStore: {
          getOffset: () => persistedOffset,
          setOffset: (v) => {
            persistedOffset = v;
          },
        },
        onUpdateError: "skip",
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 100,
      },
      sleepFn: async () => {},
      fetchFn: vi.fn(async () => {
        pollStep += 1;
        if (pollStep === 1) {
          // Deliver stopped_message_generation + a message whose onReceive throws (skipped, offset advances to 53!)
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 51,
                  stopped_message_generation: {
                    chat: { id: 12, type: "private" },
                    message_thread_id: 3,
                    draft_id: 99,
                  },
                },
                {
                  update_id: 52,
                  message: {
                    message_id: 7,
                    date: 1732350000,
                    chat: { id: 12, type: "private" },
                    from: { id: 12, is_bot: false, first_name: "U" },
                    text: "boom",
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (pollStep === 2) {
          // 429 rate limit on getUpdates
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 429,
              description: "Too Many Requests",
              parameters: { retry_after: 1 },
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          );
        }
        // Step 3: 401 fatal auth error terminates polling loop cleanly
        resolveStep3();
        return new Response(
          JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }),
    });

    connector.getReceiver().init({
      allocateContextId: () => generator.generate("telegram"),
      contextIdGenerator: generator,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onReceive: async () => {
        throw new Error("handler error to skip");
      },
    });

    await connector.start();
    // Calling start() a second time while active is an idempotent no-op
    await connector.start();
    await step3Reached;
    // Allow microtasks to settle so the 401 response reaches the ConnectorAuthError guard
    await defaultTelegramSleep(10);
    await connector.stop();

    expect(stoppedDrafts).toEqual([99]);
    expect(persistedOffset).toBe(53);

    // Cover startPolling() failure cleanup (getMe fails) + onUpdateError: "retry" + sleep abort
    const failingGetMeReceiver = new TelegramReceiver({
      connectorName: "telegram",
      apiClient: new TelegramApiClient({
        botToken: SAMPLE_TOKEN,
        fetchFn: vi.fn(
          async () =>
            new Response(JSON.stringify({ ok: false, error_code: 401, description: "Bad token" }), {
              status: 401,
              headers: { "content-type": "application/json" },
            }),
        ),
      }),
    });
    failingGetMeReceiver.init({
      allocateContextId: () => generator.generate("telegram"),
      contextIdGenerator: generator,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onReceive: async () => ({ sessionId: "s1" }),
    });
    await expect(failingGetMeReceiver.startPolling()).rejects.toThrow(/authentication failed/);

    let retryPollStep = 0;
    let resolveInBackoff!: () => void;
    const inBackoff = new Promise<void>((resolve) => {
      resolveInBackoff = resolve;
    });
    const retryReceiver = new TelegramReceiver({
      connectorName: "telegram",
      botId: 801,
      botUsername: "retry_bot",
      polling: {
        onUpdateError: "retry",
        retryBaseDelayMs: 5000,
      },
      sleepFn: async (ms, sig) => {
        resolveInBackoff();
        await defaultTelegramSleep(ms, sig);
      },
      apiClient: new TelegramApiClient({
        botToken: SAMPLE_TOKEN,
        fetchFn: vi.fn(async () => {
          retryPollStep += 1;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 90,
                  message: {
                    message_id: 1,
                    date: 1732350000,
                    chat: { id: 9, type: "private" },
                    from: { id: 9, is_bot: false, first_name: "Z" },
                    text: "trigger retry",
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }),
      }),
    });
    retryReceiver.init({
      allocateContextId: () => generator.generate("telegram"),
      contextIdGenerator: generator,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onReceive: async () => {
        throw new Error("transient session failure");
      },
    });
    await retryReceiver.startPolling();
    await inBackoff;
    await retryReceiver.stopPolling();
    expect(retryPollStep).toBe(1);
    // Offset was NOT advanced on "retry" mode when handler threw
    expect(retryReceiver.getCurrentOffset()).toBeUndefined();
  });
});
