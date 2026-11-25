import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  createDefaultContextIdGenerator,
  type ConnectorLogger,
  type ConnectorReceiverContext,
} from "@dsh-connector/core";
import {
  computeSlackSignature,
  createSlackConnector,
  dispatchSlackEventCallback,
  parseSlackEventCallback,
  SLACK_APP_TOKEN_PREFIX,
  SLACK_BOT_TOKEN_PREFIX,
  SlackApiClient,
  slackReceiveSchema,
  SlackSocketModeClient,
  stripSlackBotMention,
  verifySlackRequestSignature,
  type SlackWebSocketEventType,
  type SlackWebSocketLike,
} from "../src";

const TEST_BOT_TOKEN = `${SLACK_BOT_TOKEN_PREFIX}fixture-bot-token-0001`;
const TEST_APP_TOKEN = `${SLACK_APP_TOKEN_PREFIX}fixture-app-token-0001`;
const TEST_SIGNING_KEY = "unit-test-slack-signing-key";
const NOW_SEC = 1_717_171_717;

function createLogger(): ConnectorLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createReceiverCtx<TName extends string = "slack">(
  name: TName,
  deduplicated = false,
): {
  ctx: ConnectorReceiverContext<typeof slackReceiveSchema, TName>;
  logger: ConnectorLogger;
} {
  const generator = createDefaultContextIdGenerator();
  const logger = createLogger();
  const ctx: ConnectorReceiverContext<typeof slackReceiveSchema, TName> = {
    allocateContextId: () => generator.generate(name),
    contextIdGenerator: generator,
    logger,
    onReceive: vi.fn(async () => ({
      sessionId: "sess-edge",
      ...(deduplicated ? { deduplicated: true } : {}),
    })),
  };
  return { ctx, logger };
}

describe("Stage 4: Edge cases, resilience, and full branch coverage", () => {
  describe("Signature & Webhook edge cases", () => {
    it("handles missing signing secret, array lowercase headers, and out-of-range integer timestamps", () => {
      const rawBody = new TextEncoder().encode("{}");
      expect(
        verifySlackRequestSignature({
          signingSecret: "   ",
          headers: {},
          rawBody,
        }),
      ).toMatchObject({ valid: false, reason: "missing_signing_secret" });

      expect(
        verifySlackRequestSignature({
          signingSecret: TEST_SIGNING_KEY,
          headers: {
            "x-slack-request-timestamp": ["9999999999999999999999"],
            "x-slack-signature": ["v0=0000"],
          },
          rawBody,
        }),
      ).toMatchObject({ valid: false, reason: "invalid_timestamp" });
    });

    it("handles webhook retries, invalid JSON, non-object JSON, missing challenge, uninitialized receiver, and unknown payload types", async () => {
      const connector = createSlackConnector({
        botToken: TEST_BOT_TOKEN,
        signingSecret: TEST_SIGNING_KEY,
        ignoreHttpRetries: true,
        deliveryMode: "steer",
        nowSeconds: () => NOW_SEC,
        fetchFn: vi.fn(),
      });

      const signReq = (
        rawText: string,
        extraHeaders?: Record<string, string | readonly string[]>,
      ) => {
        const rawBody = new TextEncoder().encode(rawText);
        return {
          method: "POST",
          pathname: "/webhooks/slack",
          subPath: "",
          query: new URLSearchParams(),
          headers: {
            "x-slack-request-timestamp": String(NOW_SEC),
            "x-slack-signature": computeSlackSignature(TEST_SIGNING_KEY, NOW_SEC, rawBody),
            ...extraHeaders,
          },
          rawBody,
        };
      };

      const receiver = connector.getReceiver();

      // Uninitialized receiver returns 500 on event_callback
      const uninitRes = await receiver.handleWebhook!(
        signReq(
          JSON.stringify({
            type: "event_callback",
            event_id: "Ev1",
            event: { type: "message" },
          }),
        ),
      );
      expect(uninitRes.status).toBe(500);

      // Initialize receiver with deduplicated=true response
      const { ctx } = createReceiverCtx("slack", true);
      await receiver.init?.(ctx);

      // HTTP retry header ignored when ignoreHttpRetries=true (both string and array header)
      const retryRes1 = await receiver.handleWebhook!(signReq("{}", { "X-Slack-Retry-Num": "1" }));
      expect(JSON.parse(String(retryRes1.body))).toMatchObject({
        ok: true,
        ignored: true,
        reason: "http_retry",
      });

      const retryRes2 = await receiver.handleWebhook!(
        signReq("{}", { "X-Slack-Retry-Num": ["2"] }),
      );
      expect(JSON.parse(String(retryRes2.body))).toMatchObject({
        ok: true,
        ignored: true,
        reason: "http_retry",
      });

      // Invalid JSON -> 400
      const badJsonRes = await receiver.handleWebhook!(signReq("{not-json"));
      expect(badJsonRes.status).toBe(400);

      // Non-object JSON -> 400
      const arrayJsonRes = await receiver.handleWebhook!(signReq("[1,2,3]"));
      expect(arrayJsonRes.status).toBe(400);

      // url_verification without challenge -> 400
      const emptyChallengeRes = await receiver.handleWebhook!(
        signReq(JSON.stringify({ type: "url_verification" })),
      );
      expect(emptyChallengeRes.status).toBe(400);

      // Unknown webhook payload type -> 200 ignored
      const unknownTypeRes = await receiver.handleWebhook!(
        signReq(JSON.stringify({ type: "app_rate_limited" })),
      );
      expect(JSON.parse(String(unknownTypeRes.body))).toMatchObject({
        ok: true,
        ignored: true,
        reason: "unsupported_payload_type",
      });

      // Valid DM with thread_ts and deduplicated=true
      const threadedDmRes = await receiver.handleWebhook!(
        signReq(
          JSON.stringify({
            type: "event_callback",
            event_id: "EvDMThread",
            event: {
              type: "message",
              channel: "D0123456789",
              channel_type: "im",
              user: "U0999999999",
              text: "Threaded DM follow-up",
              ts: "1717171717.000200",
              thread_ts: "1717171717.000100",
            },
          }),
        ),
      );
      expect(JSON.parse(String(threadedDmRes.body))).toEqual({
        ok: true,
        sessionId: "sess-edge",
        deduplicated: true,
      });

      const formattedThreadedDm = receiver.formatInbound!(
        {
          text: "Threaded DM follow-up",
          channelId: "D0123456789",
          channelType: "im",
          userId: "U0999999999",
          messageTs: "1717171717.000200",
          threadTs: "1717171717.000100",
          eventType: "message",
          eventId: "EvDMThread",
        },
        { connectorName: "slack", contextId: "dm:D0123456789:1717171717.000100" as never },
      );
      expect(formattedThreadedDm).toMatchObject({
        title: "Slack DM D0123456789",
      });
      expect(
        typeof formattedThreadedDm === "object" ? formattedThreadedDm.text : formattedThreadedDm,
      ).toContain("thread_ts=1717171717.000100");

      const formattedTopChannel = receiver.formatInbound!(
        {
          text: "Top channel message",
          channelId: "C0123456789",
          channelType: "channel",
          userId: "U0999999999",
          messageTs: "1717171717.000300",
          eventType: "app_mention",
          eventId: "EvTop",
        },
        { connectorName: "slack", contextId: "channel:C0123456789:1717171717.000300" as never },
      );
      expect(formattedTopChannel).toMatchObject({
        title: "Slack C0123456789",
      });

      // Direct dispatchSlackEventCallback throws when receiver is uninitialized
      await expect(
        dispatchSlackEventCallback(
          {},
          {
            connectorName: "slack",
            getReceiverContext: () => undefined,
            getBotUserId: () => undefined,
            getExpectedAppId: () => undefined,
            isParticipatingThread: () => false,
            markParticipatingThread: () => undefined,
          },
        ),
      ).rejects.toThrow("receiver has not been initialized");
    });
  });

  describe("Event parser policies and filtering branches", () => {
    it("covers app_mismatch, subtype filtering, authorizations self-detection, channel prefixes, and threadReplyPolicy modes", () => {
      expect(parseSlackEventCallback(null)).toEqual({
        kind: "ignored",
        reason: "invalid_envelope",
      });
      expect(
        parseSlackEventCallback({ type: "event_callback", event_id: "Ev1", event: null }),
      ).toEqual({
        kind: "ignored",
        reason: "invalid_envelope",
      });

      expect(
        parseSlackEventCallback(
          {
            type: "event_callback",
            api_app_id: "A_OTHER",
            event_id: "Ev1",
            event: { type: "message" },
          },
          { expectedAppId: "A_EXPECTED" },
        ),
      ).toEqual({
        kind: "ignored",
        reason: "app_mismatch",
      });

      expect(
        parseSlackEventCallback({
          type: "event_callback",
          event_id: "Ev1",
          event: { type: "message", subtype: "message_changed" },
        }),
      ).toEqual({
        kind: "ignored",
        reason: "unsupported_subtype",
      });

      expect(
        parseSlackEventCallback({
          type: "event_callback",
          event_id: "Ev1",
          event: { type: "message", channel: "bad", user: "U1", ts: "1717.1" },
        }),
      ).toEqual({
        kind: "ignored",
        reason: "missing_fields",
      });

      // Self-message detected via authorizations[].is_bot
      expect(
        parseSlackEventCallback({
          type: "event_callback",
          event_id: "EvSelf",
          authorizations: [{ is_bot: true, user_id: "U0BOTSELF01" }],
          event: {
            type: "message",
            channel: "D0123456789",
            channel_type: "im",
            user: "U0BOTSELF01",
            text: "echo",
            ts: "1717171717.000100",
          },
        }),
      ).toEqual({
        kind: "ignored",
        reason: "self_message",
      });

      // Channel type inference from D... / G... prefixes when channel_type omitted on app_mention
      const groupMention = parseSlackEventCallback({
        type: "event_callback",
        event_id: "EvGroupMention",
        event: {
          type: "app_mention",
          channel: "G0123456789",
          user: "U0999999999",
          text: "<@U0UNKNOWNBOT> deploy staging",
          ts: "1717171717.000300",
        },
      });
      expect(groupMention).toMatchObject({
        kind: "message",
        contextId: "msg:G0123456789:1717171717.000300",
        params: {
          text: "deploy staging",
          channelType: "group",
        },
      });

      const dmPrefixMention = parseSlackEventCallback({
        type: "event_callback",
        event_id: "EvDmMention",
        event: {
          type: "app_mention",
          channel: "D0123456789",
          user: "U0999999999",
          text: "ping",
          ts: "1717171717.000301",
        },
      });
      expect(dmPrefixMention).toMatchObject({
        kind: "message",
        contextId: "msg:D0123456789:1717171717.000301",
      });

      // threadReplyPolicy: mention-only vs participating
      const threadReplyPayload = {
        type: "event_callback",
        event_id: "EvThreadReply",
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C0123456789",
          channel_type: "channel",
          user: "U0999999999",
          text: "Here is the log file",
          ts: "1717171717.000400",
          thread_ts: "1717171717.000100",
        },
      };

      expect(
        parseSlackEventCallback(threadReplyPayload, { threadReplyPolicy: "mention-only" }),
      ).toEqual({
        kind: "ignored",
        reason: "thread_policy_filtered",
      });

      expect(
        parseSlackEventCallback(threadReplyPayload, {
          threadReplyPolicy: "participating",
          isParticipatingThread: () => false,
        }),
      ).toEqual({
        kind: "ignored",
        reason: "thread_policy_filtered",
      });

      expect(
        parseSlackEventCallback(threadReplyPayload, {
          threadReplyPolicy: "participating",
          isParticipatingThread: (ch, ts) => ch === "C0123456789" && ts === "1717171717.000100",
        }),
      ).toMatchObject({
        kind: "message",
        contextId: "msg:C0123456789:1717171717.000400",
      });

      // Unsupported event type & empty text
      expect(
        parseSlackEventCallback({
          type: "event_callback",
          event_id: "EvReact",
          event: {
            type: "reaction_added",
            channel: "C0123456789",
            user: "U0999999999",
            ts: "1717171717.000500",
          },
        }),
      ).toEqual({
        kind: "ignored",
        reason: "unsupported_event",
      });

      expect(
        parseSlackEventCallback({
          type: "event_callback",
          event_id: "EvEmpty",
          event: {
            type: "message",
            channel: "D0123456789",
            channel_type: "im",
            user: "U0999999999",
            text: "   ",
            ts: "1717171717.000600",
          },
        }),
      ).toEqual({
        kind: "ignored",
        reason: "empty_text",
      });

      expect(stripSlackBotMention("hello", undefined, false)).toBe("hello");
    });
  });

  describe("SlackApiClient & SlackConnector validation and failure branches", () => {
    it("covers timeout validation, missing tokens per method, abort signals, malformed JSON/payloads, and mode validation", async () => {
      expect(() => new SlackApiClient({ botToken: TEST_BOT_TOKEN, timeoutMs: 0 })).toThrow(
        ConnectorValidationError,
      );

      expect(() => createSlackConnector({ botToken: TEST_BOT_TOKEN, mode: "socket" })).toThrow(
        ConnectorValidationError,
      );

      expect(() =>
        createSlackConnector({
          botToken: TEST_BOT_TOKEN,
          appToken: TEST_APP_TOKEN,
          mode: "webhook",
        }),
      ).toThrow(ConnectorValidationError);

      // Hybrid mode inference when both tokens/secrets are provided
      const hybrid = createSlackConnector({
        botToken: TEST_BOT_TOKEN,
        appToken: TEST_APP_TOKEN,
        signingSecret: TEST_SIGNING_KEY,
        displayName: "Custom Slack",
        description: "Custom description",
        appId: "A0CUSTOM01",
        verifyAuthOnStart: false,
        fetchFn: vi.fn(),
      });
      expect(hybrid.mode).toBe("hybrid");
      expect(hybrid.displayName).toBe("Custom Slack");

      // Webhook-only start/stop with verifyAuthOnStart: true
      const webhookVerified = createSlackConnector({
        botToken: TEST_BOT_TOKEN,
        signingSecret: TEST_SIGNING_KEY,
        verifyAuthOnStart: true,
        fetchFn: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                ok: true,
                team_id: "T0123456789",
                user_id: "U0VERIFIED01",
                is_enterprise_install: false,
              }),
              { status: 200 },
            ),
        ),
      });
      await webhookVerified.start();
      await webhookVerified.stop();

      // App-only client calling bot-only method throws ConnectorAuthError
      const appOnly = new SlackApiClient({
        appToken: TEST_APP_TOKEN,
        apiBaseUrl: "https://slack.com/api",
        sanitizeBroadcastMentions: false,
        fetchFn: vi.fn(),
      });
      await expect(appOnly.authTest()).rejects.toThrow(ConnectorAuthError);

      // Bot-only client calling openSocketConnection throws ConnectorAuthError
      const botOnly = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(),
      });
      await expect(botOnly.openSocketConnection()).rejects.toThrow(ConnectorAuthError);
      await expect(botOnly.postMessage({ channel: "C0123456789", text: "   " })).rejects.toThrow(
        ConnectorValidationError,
      );

      // Missing fields in auth.test and chat.postMessage responses
      const incompleteAuthClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      });
      await expect(incompleteAuthClient.authTest()).rejects.toThrow(ConnectorTransportError);
      await expect(
        incompleteAuthClient.postMessage({ channel: "C0123456789", text: "hi" }),
      ).rejects.toThrow(ConnectorTransportError);

      // Invalid JSON & non-object JSON responses
      const invalidJsonClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async () => new Response("not-json", { status: 502 })),
      });
      await expect(invalidJsonClient.authTest()).rejects.toMatchObject({
        statusCode: 502,
        retryable: true,
      });

      const arrayPayloadClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async () => new Response("[]", { status: 200 })),
      });
      await expect(arrayPayloadClient.authTest()).rejects.toThrow(ConnectorTransportError);

      // Network throw & pre-aborted signal during 429 backoff (both Error and string abort reason)
      const netErrClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async () => {
          throw new Error("ECONNRESET");
        }),
      });
      await expect(netErrClient.authTest()).rejects.toMatchObject({ retryable: true });

      const preAbortedRetryController = new AbortController();
      const preAbortedRetryClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async () => {
          preAbortedRetryController.abort("string-abort-reason");
          return new Response("{}", { status: 429 });
        }),
      });
      await expect(
        preAbortedRetryClient.authTest({ signal: preAbortedRetryController.signal }),
      ).rejects.toThrow("Request aborted");

      // Abort mid-429 Retry-After sleep
      const midRetryAbort = new AbortController();
      const retryAbortClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async () => {
          setTimeout(() => midRetryAbort.abort(new Error("Aborted during retry")), 10);
          return new Response("{}", { status: 429 });
        }),
      });
      await expect(retryAbortClient.authTest({ signal: midRetryAbort.signal })).rejects.toThrow(
        "Aborted during retry",
      );

      // Non-retryable ok:false Slack error (channel_not_found) + invalid URL in openSocketConnection
      const nonRetryableClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        appToken: TEST_APP_TOKEN,
        fetchFn: vi.fn(async (input) => {
          if (String(input).endsWith("/apps.connections.open")) {
            return new Response(JSON.stringify({ ok: true, url: ":::not-a-url" }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
            status: 200,
          });
        }),
      });
      await expect(
        nonRetryableClient.postMessage({ channel: "C0123456789", text: "hi" }),
      ).rejects.toMatchObject({ retryable: false });
      await expect(nonRetryableClient.openSocketConnection()).rejects.toThrow(
        ConnectorTransportError,
      );

      // Explicit mode="webhook" + participating thread LRU eviction
      const participatingConnector = createSlackConnector({
        botToken: TEST_BOT_TOKEN,
        signingSecret: TEST_SIGNING_KEY,
        mode: "webhook",
        threadReplyPolicy: "participating",
        maxParticipatingThreads: 1,
        nowSeconds: () => NOW_SEC,
        fetchFn: vi.fn(
          async () =>
            new Response(
              JSON.stringify({ ok: true, channel: "C0123456789", ts: "1717171717.555555" }),
              { status: 200 },
            ),
        ),
      });
      const { ctx: partCtx } = createReceiverCtx("slack");
      await participatingConnector.getReceiver().init?.(partCtx);
      await participatingConnector
        .getSender()
        .send(
          { connectorName: "slack", contextId: "channel:C0123456789:1717171717.000111" as never },
          { text: "one" },
        );
      await participatingConnector
        .getSender()
        .send(
          { connectorName: "slack", contextId: "channel:C0123456789:1717171717.000111" as never },
          { text: "one-again" },
        );
      await participatingConnector
        .getSender()
        .send(
          { connectorName: "slack", contextId: "channel:C0123456789:1717171717.000222" as never },
          { text: "two" },
        );

      const makeReplyBody = (threadTs: string) => {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: `Ev-${threadTs}`,
          event: {
            type: "message",
            channel: "C0123456789",
            channel_type: "channel",
            user: "U0999999999",
            text: "follow up",
            ts: "1717171717.000999",
            thread_ts: threadTs,
          },
        });
        const rawBody = new TextEncoder().encode(body);
        return {
          method: "POST",
          pathname: "/webhooks/slack",
          subPath: "",
          query: new URLSearchParams(),
          headers: {
            "x-slack-request-timestamp": String(NOW_SEC),
            "x-slack-signature": computeSlackSignature(TEST_SIGNING_KEY, NOW_SEC, rawBody),
          },
          rawBody,
        };
      };

      const evictedRes = await participatingConnector.getReceiver().handleWebhook!(
        makeReplyBody("1717171717.000111"),
      );
      expect(JSON.parse(String(evictedRes.body))).toMatchObject({
        ignored: true,
        reason: "thread_policy_filtered",
      });
      const activeRes = await participatingConnector.getReceiver().handleWebhook!(
        makeReplyBody("1717171717.000222"),
      );
      expect(JSON.parse(String(activeRes.body))).toMatchObject({
        ok: true,
        sessionId: "sess-edge",
      });
    });
  });

  describe("SlackSocketModeClient EventEmitter frames, timeouts, and error recovery", () => {
    it("supports .on() sockets, Buffer/ArrayBuffer/Uint8Array frames, malformed frames, hello timeout, and reconnect retry loops", async () => {
      const logger = createLogger();

      // 1. Socket without addEventListener or on throws ConnectorTransportError
      const brokenApiClient = new SlackApiClient({
        appToken: TEST_APP_TOKEN,
        fetchFn: vi.fn(
          async () =>
            new Response(
              JSON.stringify({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=1" }),
              { status: 200 },
            ),
        ),
      });

      const badSocketClient = new SlackSocketModeClient({
        connectorName: "slack",
        apiClient: brokenApiClient,
        onEventCallback: async () => undefined,
        createWebSocket: () => ({
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
        }),
      });
      await expect(badSocketClient.start()).rejects.toThrow(ConnectorTransportError);

      // 2. Hello timeout when server never sends hello
      const timeoutClient = new SlackSocketModeClient({
        connectorName: "slack",
        apiClient: brokenApiClient,
        connectTimeoutMs: 20,
        onEventCallback: async () => undefined,
        createWebSocket: () => ({
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
          on: vi.fn(),
        }),
      });
      await expect(timeoutClient.start()).rejects.toThrow('did not receive "hello"');

      // 3. .on()-style socket with Buffer / ArrayBuffer / Uint8Array frames, error events, callback failure, and reconnect retry
      const listeners = new Map<SlackWebSocketEventType, Array<(ev: unknown) => void>>();
      const sent: string[] = [];
      let socketCount = 0;
      let failNextOpen = false;

      const emitterApiClient = new SlackApiClient({
        appToken: TEST_APP_TOKEN,
        fetchFn: vi.fn(async () => {
          if (failNextOpen) {
            failNextOpen = false;
            throw new Error("Temporary network outage");
          }
          socketCount += 1;
          return new Response(
            JSON.stringify({
              ok: true,
              url: `wss://wss-primary.slack.com/link/?ticket=em-${socketCount}`,
            }),
            { status: 200 },
          );
        }),
      });

      const createEmitterSocket = (): SlackWebSocketLike => {
        listeners.clear();
        const sock: SlackWebSocketLike = {
          readyState: 1,
          send: (d) => sent.push(d),
          close: () => {
            for (const fn of listeners.get("close") ?? []) {
              fn({ code: 1006 });
            }
          },
          on: (ev, fn) => {
            const arr = listeners.get(ev) ?? [];
            arr.push(fn);
            listeners.set(ev, arr);
          },
        };
        queueMicrotask(() => {
          const helloBuf = Buffer.from(
            JSON.stringify({ type: "hello", connection_info: { app_id: "A1" } }),
            "utf8",
          );
          for (const fn of listeners.get("message") ?? []) {
            fn(helloBuf);
          }
        });
        return sock;
      };

      let callbackCalls = 0;
      const emitterClient = new SlackSocketModeClient({
        connectorName: "slack",
        apiClient: emitterApiClient,
        getLogger: () => logger,
        reconnectDelaysMs: [10, 15],
        onEventCallback: async () => {
          callbackCalls += 1;
          throw new Error("Simulated downstream failure");
        },
        createWebSocket: () => createEmitterSocket(),
      });

      // Concurrent start calls share startingPromise, and connected start() is idempotent
      await Promise.all([emitterClient.start(), emitterClient.start()]);
      expect(emitterClient.isConnected).toBe(true);
      await emitterClient.start();

      // Send malformed JSON, non-object JSON, empty frame, ArrayBuffer frame, Uint8Array frame, and error events
      const msgListeners = listeners.get("message") ?? [];
      for (const fn of msgListeners) {
        fn("");
        fn("{bad-json");
        fn("123");
        fn(12345);
        const abPacket = new TextEncoder().encode(
          JSON.stringify({ envelope_id: "env-ab", type: "events_api", payload: {} }),
        );
        fn(abPacket.buffer);
        fn(abPacket);
      }

      for (const fn of listeners.get("error") ?? []) {
        fn({ error: new Error("socket glitch") });
        fn({});
      }

      await vi.waitFor(() => {
        expect(callbackCalls).toBe(2);
      });
      expect(sent).toContain(JSON.stringify({ envelope_id: "env-ab" }));
      expect(logger.warn).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();

      // Trigger disconnect without explicit reason, where first reconnect fails and second succeeds
      failNextOpen = true;
      for (const fn of msgListeners) {
        fn(JSON.stringify({ type: "disconnect" }));
      }

      await vi.waitFor(() => {
        expect(socketCount).toBe(2);
      });

      await emitterClient.stop();
      expect(emitterClient.isConnected).toBe(false);

      // 4. Stop while in-flight task is pending, socket.close throws, and reconnect timer is scheduled
      let releaseTask!: () => void;
      const slowTaskClient = new SlackSocketModeClient({
        connectorName: "slack",
        apiClient: emitterApiClient,
        getLogger: () => logger,
        reconnectDelaysMs: [5_000],
        onEventCallback: () =>
          new Promise<void>((resolve) => {
            releaseTask = resolve;
          }),
        createWebSocket: () => {
          const ws = createEmitterSocket();
          return {
            ...ws,
            close: () => {
              throw new Error("close boom");
            },
          };
        },
      });
      await slowTaskClient.start();
      for (const fn of listeners.get("message") ?? []) {
        fn(JSON.stringify({ envelope_id: "env-slow", type: "events_api", payload: {} }));
      }
      setTimeout(() => releaseTask(), 10);
      await slowTaskClient.stop();

      // 5. Stop while reconnect timer is pending
      const pendingReconnectClient = new SlackSocketModeClient({
        connectorName: "slack",
        apiClient: emitterApiClient,
        reconnectDelaysMs: [10_000],
        onEventCallback: async () => undefined,
        createWebSocket: () => createEmitterSocket(),
      });
      await pendingReconnectClient.start();
      for (const fn of listeners.get("close") ?? []) {
        fn({});
      }
      await pendingReconnectClient.stop();
    });
  });
});
