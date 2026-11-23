import { describe, expect, it, vi } from "vitest";
import {
  createConnectorContext,
  createDefaultContextIdGenerator,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import {
  computeSlackSignature,
  createSlackConnector,
  SLACK_APP_TOKEN_PREFIX,
  SLACK_BOT_TOKEN_PREFIX,
  slackReceiveSchema,
  type SlackReceiveParams,
  type SlackStreamingAdapter,
  type SlackWebSocketEventType,
  type SlackWebSocketLike,
} from "../src";

const TEST_BOT_TOKEN = `${SLACK_BOT_TOKEN_PREFIX}fixture-bot-token-0001`;
const TEST_APP_TOKEN = `${SLACK_APP_TOKEN_PREFIX}fixture-app-token-0001`;
const TEST_SIGNING_KEY = "unit-test-slack-signing-key";
const FIXED_NOW_SECONDS = 1_717_171_717;

function createMockLogger(): ConnectorLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockReceiverHarness<TName extends string = "slack">(connectorName: TName) {
  const received: Array<{
    context: ConnectorContext<TName>;
    params: SlackReceiveParams;
    meta: InboundDeliveryMeta | undefined;
  }> = [];
  const generator = createDefaultContextIdGenerator();
  const logger = createMockLogger();

  const ctx: ConnectorReceiverContext<typeof slackReceiveSchema, TName> = {
    allocateContextId: () => generator.generate(connectorName),
    contextIdGenerator: generator,
    logger,
    onReceive: vi.fn(async (context, params, meta) => {
      received.push({ context, params, meta });
      return { sessionId: `sess-${received.length}` };
    }),
  };

  return { ctx, received, logger };
}

function createSignedWebhookRequest(
  bodyObj: unknown,
  options?: {
    method?: string;
    signingSecret?: string;
    timestampSeconds?: number;
    extraHeaders?: Record<string, string>;
  },
) {
  const rawText = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
  const rawBody = new TextEncoder().encode(rawText);
  const ts = options?.timestampSeconds ?? FIXED_NOW_SECONDS;
  const secret = options?.signingSecret ?? TEST_SIGNING_KEY;
  const signature = computeSlackSignature(secret, ts, rawBody);

  return {
    method: options?.method ?? "POST",
    pathname: "/webhooks/slack",
    subPath: "",
    query: new URLSearchParams(),
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": signature,
      ...options?.extraHeaders,
    },
    rawBody,
  };
}

class MockSlackWebSocket implements SlackWebSocketLike {
  readyState = 1;
  readonly sentFrames: string[] = [];
  closedWith: { code?: number; reason?: string } | undefined;

  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: SlackWebSocketEventType, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) {
      return;
    }
    this.readyState = 3;
    this.closedWith = {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
  }

  emitServerMessage(packet: unknown): void {
    const data = typeof packet === "string" ? packet : JSON.stringify(packet);
    this.emit("message", { data });
  }

  emitError(err: Error): void {
    this.emit("error", { error: err });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("Stage 3: Slack Events API HTTP Webhook, Socket Mode WebSocket, and full Connector闭环", () => {
  it("handles Events API url_verification challenge and rejects invalid methods or signatures", async () => {
    const connector = createSlackConnector({
      botToken: TEST_BOT_TOKEN,
      signingSecret: TEST_SIGNING_KEY,
      nowSeconds: () => FIXED_NOW_SECONDS,
      fetchFn: vi.fn(),
    });

    const receiver = connector.getReceiver();
    const { ctx } = createMockReceiverHarness("slack");
    await receiver.init?.(ctx);

    // Non-POST rejected with 405
    const getRes = await receiver.handleWebhook!({
      ...createSignedWebhookRequest({ type: "url_verification", challenge: "xyz" }),
      method: "GET",
    });
    expect(getRes.status).toBe(405);

    // Tampered signature rejected with 401
    const badSigRes = await receiver.handleWebhook!(
      createSignedWebhookRequest(
        { type: "url_verification", challenge: "xyz" },
        { signingSecret: "wrong-signing-key" },
      ),
    );
    expect(badSigRes.status).toBe(401);

    // Valid url_verification echoes challenge with HTTP 200
    const challengeRes = await receiver.handleWebhook!(
      createSignedWebhookRequest({
        challenge: "url-verification-challenge-echo",
        type: "url_verification",
      }),
    );
    expect(challengeRes.status).toBe(200);
    expect(JSON.parse(String(challengeRes.body))).toEqual({
      challenge: "url-verification-challenge-echo",
    });
  });

  it("parses message.im, app_mention, and channel thread replies while filtering bot_id self-messages and unaddressed channel chatter", async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const connector = createSlackConnector({
      botToken: TEST_BOT_TOKEN,
      signingSecret: TEST_SIGNING_KEY,
      botUserId: "U0BOTUSER01",
      nowSeconds: () => FIXED_NOW_SECONDS,
      fetchFn: vi.fn(async (_input, init) => {
        sentPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            ok: true,
            channel: String((JSON.parse(String(init?.body)) as Record<string, unknown>)["channel"]),
            ts: "1717171717.900001",
          }),
          { status: 200 },
        );
      }),
    });

    const receiver = connector.getReceiver();
    const sender = connector.getSender();
    const { ctx, received } = createMockReceiverHarness("slack");
    await receiver.init?.(ctx);

    // 1. Direct message (message.im)
    const dmRes = await receiver.handleWebhook!(
      createSignedWebhookRequest({
        type: "event_callback",
        team_id: "T0123456789",
        api_app_id: "A0123456789",
        event_id: "EvDM001",
        event_time: FIXED_NOW_SECONDS,
        event: {
          type: "message",
          channel: "D0123456789",
          channel_type: "im",
          user: "U0999999999",
          text: "Hello &amp; check &lt;status&gt;",
          ts: "1717171717.000100",
        },
      }),
    );
    expect(dmRes.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.context.contextId).toBe("dm:D0123456789");
    expect(received[0]?.params.text).toBe("Hello & check <status>");
    expect(received[0]?.meta?.idempotencyKey).toBe("D0123456789:1717171717.000100");

    // Format inbound check
    const dmPrompt = receiver.formatInbound!(received[0]!.params, received[0]!.context);
    expect(typeof dmPrompt === "object" ? dmPrompt.text : dmPrompt).toContain(
      "Hello & check <status>",
    );

    // 2. Channel app_mention (top-level message -> anchors thread_ts to message ts)
    await receiver.handleWebhook!(
      createSignedWebhookRequest({
        type: "event_callback",
        team_id: "T0123456789",
        event_id: "EvMENTION001",
        event_time: FIXED_NOW_SECONDS,
        event: {
          type: "app_mention",
          channel: "C0123456789",
          user: "U0999999999",
          text: "<@U0BOTUSER01> please review PR #42",
          ts: "1717171717.000200",
        },
      }),
    );
    expect(received).toHaveLength(2);
    expect(received[1]?.context.contextId).toBe("channel:C0123456789:1717171717.000200");
    expect(received[1]?.params.text).toBe("please review PR #42");
    expect(received[1]?.params.threadTs).toBe("1717171717.000200");
    expect(received[1]?.meta?.idempotencyKey).toBe("C0123456789:1717171717.000200");

    const channelPrompt = receiver.formatInbound!(received[1]!.params, received[1]!.context);
    expect(channelPrompt).toMatchObject({
      title: "Slack C0123456789 (1717171717.000200)",
    });

    // 3. Follow-up reply in that channel thread WITHOUT @mention -> routed to same thread context!
    await receiver.handleWebhook!(
      createSignedWebhookRequest({
        type: "event_callback",
        team_id: "T0123456789",
        event_id: "EvTHREAD001",
        event_time: FIXED_NOW_SECONDS,
        event: {
          type: "message",
          channel: "C0123456789",
          channel_type: "channel",
          user: "U0999999999",
          text: "Also verify unit tests",
          ts: "1717171717.000300",
          thread_ts: "1717171717.000200",
        },
      }),
    );
    expect(received).toHaveLength(3);
    expect(received[2]?.context.contextId).toBe("channel:C0123456789:1717171717.000200");
    expect(received[2]?.params.text).toBe("Also verify unit tests");

    // 4. Outbound reply in that session context automatically attaches thread_ts
    await sender.send(received[2]!.context, { text: "All checks passed!" });
    expect(sentPayloads[0]).toMatchObject({
      channel: "C0123456789",
      thread_ts: "1717171717.000200",
      text: "All checks passed!",
    });

    // 5. Bot self-message (bot_id present) MUST be filtered out to prevent loops
    const botMsgRes = await receiver.handleWebhook!(
      createSignedWebhookRequest({
        type: "event_callback",
        event_id: "EvBOT001",
        event: {
          type: "message",
          channel: "D0123456789",
          channel_type: "im",
          user: "U0BOTUSER01",
          bot_id: "B0123456789",
          text: "All checks passed!",
          ts: "1717171717.900001",
        },
      }),
    );
    expect(botMsgRes.status).toBe(200);
    expect(JSON.parse(String(botMsgRes.body))).toMatchObject({
      ok: true,
      ignored: true,
      reason: "bot_message",
    });
    expect(received).toHaveLength(3);

    // 6. Top-level channel message without @mention is ignored
    const topChannelRes = await receiver.handleWebhook!(
      createSignedWebhookRequest({
        type: "event_callback",
        event_id: "EvCHAN001",
        event: {
          type: "message",
          channel: "C0123456789",
          channel_type: "channel",
          user: "U0999999999",
          text: "Anyone up for lunch?",
          ts: "1717171717.000400",
        },
      }),
    );
    expect(JSON.parse(String(topChannelRes.body))).toMatchObject({
      ok: true,
      ignored: true,
      reason: "unaddressed_channel_message",
    });
    expect(received).toHaveLength(3);

    // 7. Quoted context marker in Slack blockquote (&gt; [#ctx:...]) overrides contextId and strips marker
    const markedText = prependContextMarker("Original notification", "incident:INC-7788", "bracket")
      .split("\n")
      .map((line) => `&gt; ${line}`)
      .concat(["Investigating this incident now"])
      .join("\n");

    await receiver.handleWebhook!(
      createSignedWebhookRequest({
        type: "event_callback",
        event_id: "EvMARKER001",
        event: {
          type: "message",
          channel: "D0123456789",
          channel_type: "im",
          user: "U0999999999",
          text: markedText,
          ts: "1717171717.000500",
        },
      }),
    );
    expect(received).toHaveLength(4);
    expect(received[3]?.context.contextId).toBe("incident:INC-7788");
    expect(received[3]?.params.text).toBe(
      "> Original notification\nInvestigating this incident now",
    );
  });

  it("connects via Socket Mode (apps.connections.open), ACKs envelope_id, dispatches events, reconnects on disconnect, and exposes streaming adapter slot", async () => {
    const sockets: MockSlackWebSocket[] = [];
    let openConnCount = 0;

    const mockStreamingAdapter: SlackStreamingAdapter = {
      startStream: vi.fn<SlackStreamingAdapter["startStream"]>(async (target) => ({
        channelId: target.channelId,
        messageTs: "1717171717.888888",
        mode: "native-stream",
      })),
      appendStream: vi.fn<SlackStreamingAdapter["appendStream"]>(async (handle) => ({
        ok: true,
        channel: handle.channelId,
        ts: handle.messageTs,
      })),
      completeStream: vi.fn<SlackStreamingAdapter["completeStream"]>(async (handle) => ({
        ok: true,
        channel: handle.channelId,
        ts: handle.messageTs,
      })),
    };

    const connector = createSlackConnector({
      name: "slack-ops",
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      reconnectDelaysMs: [10],
      streaming: {
        preferredMode: "native-stream",
        adapter: mockStreamingAdapter,
      },
      fetchFn: vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/auth.test")) {
          return new Response(
            JSON.stringify({
              ok: true,
              team_id: "T0123456789",
              user_id: "U0AUTOBOT01",
              bot_id: "B0AUTOBOT01",
            }),
            { status: 200 },
          );
        }
        openConnCount += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            url: `wss://wss-primary.slack.com/link/?ticket=ticket-${openConnCount}`,
          }),
          { status: 200 },
        );
      }),
      createWebSocket: (url) => {
        const ws = new MockSlackWebSocket(url);
        sockets.push(ws);
        queueMicrotask(() => {
          ws.emitServerMessage({
            type: "hello",
            connection_info: { app_id: "A0123456789" },
          });
        });
        return ws;
      },
    });

    expect(connector.name).toBe("slack-ops");
    expect(connector.getStreamingAdapter()).toBe(mockStreamingAdapter);
    expect(connector.getStreamingOptions()?.preferredMode).toBe("native-stream");

    const { ctx, received } = createMockReceiverHarness("slack-ops");
    await connector.getReceiver().init?.(ctx);

    await connector.start();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("wss://wss-primary.slack.com/link/?ticket=ticket-1");

    // Emit Socket Mode events_api packet -> must immediately ACK envelope_id and deliver to onReceive
    sockets[0]!.emitServerMessage({
      envelope_id: "env-uuid-001",
      type: "events_api",
      accepts_response_payload: false,
      payload: {
        type: "event_callback",
        api_app_id: "A0123456789",
        event_id: "EvSOCK001",
        event: {
          type: "app_mention",
          channel: "C0123456789",
          user: "U0999999999",
          text: "<@U0AUTOBOT01> hello over socket mode",
          ts: "1717171717.000700",
        },
      },
    });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });

    expect(sockets[0]!.sentFrames).toContain(JSON.stringify({ envelope_id: "env-uuid-001" }));
    expect(received[0]?.context).toEqual(
      createConnectorContext("slack-ops", "channel:C0123456789:1717171717.000700"),
    );
    expect(received[0]?.params.text).toBe("hello over socket mode");

    // Emit Slack disconnect refresh_requested -> closes first socket and opens a fresh socket
    sockets[0]!.emitServerMessage({
      type: "disconnect",
      reason: "refresh_requested",
    });

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
    });
    expect(sockets[1]?.url).toBe("wss://wss-primary.slack.com/link/?ticket=ticket-2");

    await connector.stop();
    expect(sockets[1]?.closedWith?.code).toBe(1000);
  });
});
