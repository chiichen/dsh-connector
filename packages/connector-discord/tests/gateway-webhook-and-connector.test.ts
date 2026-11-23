import { generateKeyPairSync, sign } from "node:crypto";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import { describe, expect, it, vi } from "vitest";
import {
  DISCORD_GATEWAY_OPCODES,
  DISCORD_INTERACTION_CALLBACK_TYPES,
  DISCORD_INTERACTION_TYPES,
  DiscordGatewayClient,
  DiscordReceiver,
  DiscordRestClient,
  buildDiscordGatewayUrl,
  buildEditChannelMessagePath,
  buildEditOriginalInteractionPath,
  buildTriggerTypingPath,
  createDiscordConnector,
  defaultCreateDiscordWebSocket,
  type DiscordGatewayPacket,
  type DiscordReceiveEvent,
  type DiscordStreamingAdapter,
  type WebSocketCloseEventLike,
  type WebSocketErrorEventLike,
  type WebSocketLike,
  type WebSocketMessageEventLike,
} from "../src";

class MockWebSocket implements WebSocketLike {
  readonly url: string;
  readyState = 0;
  readonly sentFrames: DiscordGatewayPacket[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  readonly #openListeners: Array<() => void> = [];
  readonly #messageListeners: Array<(ev: WebSocketMessageEventLike) => void> = [];
  readonly #closeListeners: Array<(ev: WebSocketCloseEventLike) => void> = [];
  readonly #errorListeners: Array<(ev: WebSocketErrorEventLike) => void> = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data) as DiscordGatewayPacket);
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
    for (const listener of this.#closeListeners) {
      listener({
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    }
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEventLike) => void): void;
  addEventListener(type: "close", listener: (event: WebSocketCloseEventLike) => void): void;
  addEventListener(type: "error", listener: (event: WebSocketErrorEventLike) => void): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener:
      | (() => void)
      | ((event: WebSocketMessageEventLike) => void)
      | ((event: WebSocketCloseEventLike) => void)
      | ((event: WebSocketErrorEventLike) => void),
  ): void {
    if (type === "open") {
      this.#openListeners.push(listener as () => void);
    } else if (type === "message") {
      this.#messageListeners.push(listener as (ev: WebSocketMessageEventLike) => void);
    } else if (type === "close") {
      this.#closeListeners.push(listener as (ev: WebSocketCloseEventLike) => void);
    } else {
      this.#errorListeners.push(listener as (ev: WebSocketErrorEventLike) => void);
    }
  }

  serverOpen(): void {
    this.readyState = 1;
    for (const listener of this.#openListeners) {
      listener();
    }
  }

  serverSend(packet: DiscordGatewayPacket | string | Uint8Array | ArrayBuffer): void {
    const data =
      typeof packet === "string" || packet instanceof Uint8Array || packet instanceof ArrayBuffer
        ? packet
        : JSON.stringify(packet);
    for (const listener of this.#messageListeners) {
      listener({ data });
    }
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    for (const listener of this.#closeListeners) {
      listener({ code, reason });
    }
  }

  serverError(error: Error): void {
    for (const listener of this.#errorListeners) {
      listener({ error, message: error.message });
    }
  }
}

function createSilentLogger(): ConnectorLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTestReceiverContext() {
  const received: Array<{
    context: ConnectorContext<"discord">;
    params: DiscordReceiveEvent;
    meta: InboundDeliveryMeta | undefined;
  }> = [];
  const generator = createDefaultContextIdGenerator();
  const logger = createSilentLogger();

  const ctx: ConnectorReceiverContext<typeof import("../src").discordReceiveSchema, "discord"> = {
    contextIdGenerator: generator,
    allocateContextId: () => generator.generate("discord"),
    logger,
    onReceive: vi.fn(async (context, params, meta) => {
      received.push({ context, params, meta });
      return { sessionId: `session-for-${context.contextId}` };
    }),
  };

  return { ctx, received, logger };
}

function createSignedWebhookRequest(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  payload: unknown,
  timestamp = "1763892000",
  method = "POST",
) {
  const rawBody = new TextEncoder().encode(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody)]),
    privateKey,
  ).toString("hex");

  return {
    method,
    pathname: "/webhooks/connectors/discord",
    subPath: "",
    query: new URLSearchParams(),
    headers: {
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
      "content-type": "application/json",
    },
    rawBody,
  };
}

describe("Stage 3: Gateway v10 state machine, MESSAGE_CREATE & Interactions Webhook Receiver, and Streaming Seam", () => {
  describe("Streaming extension seam (src/streaming.ts & DiscordConnector)", () => {
    it("builds official REST v10 streaming paths and exposes optional streamingAdapter on connector", async () => {
      expect(buildEditChannelMessagePath("41771983423143937", "334385199974967042")).toBe(
        "channels/41771983423143937/messages/334385199974967042",
      );
      expect(buildEditOriginalInteractionPath("20001", "tok_xyz")).toBe(
        "webhooks/20001/tok_xyz/messages/@original",
      );
      expect(
        buildEditOriginalInteractionPath("20001", "tok_xyz", {
          threadId: "99999",
          withComponents: true,
        }),
      ).toBe("webhooks/20001/tok_xyz/messages/@original?thread_id=99999&with_components=true");
      expect(buildTriggerTypingPath("41771983423143937")).toBe("channels/41771983423143937/typing");

      const mockAdapter: DiscordStreamingAdapter = {
        startStream: vi.fn(async (target) => ({
          streamId: "stream-1",
          target,
          messageId: "90001",
          channelId: "41771983423143937",
          startedAt: 1000,
        })),
        updateStream: vi.fn(async (handle) => handle),
        completeStream: vi.fn(async () => ({
          externalId: "90001",
          messageId: "90001",
          messageIds: ["90001"],
          channelId: "41771983423143937",
          summary: "completed",
          raw: [],
          data: {
            messageId: "90001",
            messageIds: ["90001"],
            channelId: "41771983423143937",
          },
        })),
        sendTypingIndicator: vi.fn(async () => undefined),
      };

      const connector = createDiscordConnector({
        botToken: "bot-token",
        enableGateway: false,
        streaming: { enabled: false, editThrottleMs: 800 },
        streamingAdapter: mockAdapter,
      });

      expect(connector.name).toBe("discord");
      expect(connector.getStreamingAdapter()).toBe(mockAdapter);
      expect(connector.getStreamingOptions()).toEqual({ enabled: false, editThrottleMs: 800 });
      expect(connector.getSender()).toBeDefined();
      expect(connector.getReceiver()).toBeDefined();

      const handle = await connector.getStreamingAdapter()!.startStream({
        mode: "channel-message",
        channelId: "41771983423143937",
      });
      expect(handle.streamId).toBe("stream-1");
    });
  });

  describe("Gateway v10 WebSocket lifecycle (Hello, Heartbeat, Identify, Resume, Reconnect, Invalid Session, Close Codes)", () => {
    it("completes Hello -> Identify -> Ready, answers server Heartbeat, detects zombie ACK timeout, and Resumes on resume_gateway_url", async () => {
      vi.useFakeTimers();
      try {
        const sockets: MockWebSocket[] = [];
        const fetchFn: typeof fetch = vi.fn(async (input) => {
          const url = input instanceof URL ? input.href : String(input);
          if (url.endsWith("/gateway/bot")) {
            return new Response(JSON.stringify({ url: "wss://gateway.discord.gg/" }), {
              status: 200,
            });
          }
          return new Response(JSON.stringify({ id: "10001", username: "dsh-bot", bot: true }), {
            status: 200,
          });
        });

        const connector = createDiscordConnector({
          botToken: "test-bot-token",
          fetchFn,
          createWebSocket: (url) => {
            const ws = new MockWebSocket(url);
            sockets.push(ws);
            return ws;
          },
          randomFn: () => 0.5,
          reconnectDelaysMs: [100],
        });

        const { ctx } = createTestReceiverContext();
        await connector.getReceiver()!.init!(ctx);

        const startPromise = connector.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(sockets).toHaveLength(1);
        const ws1 = sockets[0]!;
        expect(ws1.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");

        ws1.serverOpen();
        ws1.serverSend({
          op: DISCORD_GATEWAY_OPCODES.HELLO,
          d: { heartbeat_interval: 2000 },
        });

        // Should have sent IDENTIFY (op 2)
        expect(ws1.sentFrames[0]?.op).toBe(DISCORD_GATEWAY_OPCODES.IDENTIFY);

        // Server sends READY (op 0, s: 1)
        ws1.serverSend({
          op: DISCORD_GATEWAY_OPCODES.DISPATCH,
          s: 1,
          t: "READY",
          d: {
            v: 10,
            user: { id: "10001", username: "dsh-bot", bot: true },
            session_id: "sess_abc",
            resume_gateway_url: "wss://gateway-us-east1.discord.gg",
            application: { id: "20001" },
          },
        });

        await startPromise;

        // Server requests immediate Heartbeat (op 1)
        ws1.serverSend({ op: DISCORD_GATEWAY_OPCODES.HEARTBEAT, d: null });
        expect(ws1.sentFrames.at(-1)).toEqual({
          op: DISCORD_GATEWAY_OPCODES.HEARTBEAT,
          d: 1,
        });
        // Server ACKs
        ws1.serverSend({ op: DISCORD_GATEWAY_OPCODES.HEARTBEAT_ACK });

        // First scheduled jittered heartbeat at 2000 * 0.5 = 1000ms
        await vi.advanceTimersByTimeAsync(1000);
        expect(ws1.sentFrames.at(-1)).toEqual({
          op: DISCORD_GATEWAY_OPCODES.HEARTBEAT,
          d: 1,
        });

        // Do NOT send HEARTBEAT_ACK -> next interval (2000ms) detects zombie connection & closes with 4000!
        await vi.advanceTimersByTimeAsync(2000);
        expect(ws1.closedWith?.code).toBe(4000);

        // Reconnect delay 100ms -> opens ws2 on resume_gateway_url!
        await vi.advanceTimersByTimeAsync(100);
        expect(sockets).toHaveLength(2);
        const ws2 = sockets[1]!;
        expect(ws2.url).toBe("wss://gateway-us-east1.discord.gg/?v=10&encoding=json");

        ws2.serverOpen();
        ws2.serverSend({
          op: DISCORD_GATEWAY_OPCODES.HELLO,
          d: { heartbeat_interval: 2000 },
        });
        // Should send RESUME (op 6) with session_id and seq: 1
        expect(ws2.sentFrames[0]).toEqual({
          op: DISCORD_GATEWAY_OPCODES.RESUME,
          d: {
            token: "test-bot-token",
            session_id: "sess_abc",
            seq: 1,
          },
        });
        ws2.serverSend({
          op: DISCORD_GATEWAY_OPCODES.DISPATCH,
          s: 2,
          t: "RESUMED",
          d: {},
        });

        // INVALID_SESSION with d: false clears session and re-identifies on initial gateway URL
        ws2.serverSend({
          op: DISCORD_GATEWAY_OPCODES.INVALID_SESSION,
          d: false,
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(sockets).toHaveLength(3);
        const ws3 = sockets[2]!;
        expect(ws3.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
        ws3.serverOpen();
        ws3.serverSend({
          op: DISCORD_GATEWAY_OPCODES.HELLO,
          d: { heartbeat_interval: 2000 },
        });
        expect(ws3.sentFrames[0]?.op).toBe(DISCORD_GATEWAY_OPCODES.IDENTIFY);

        await connector.stop();
        expect(ws3.closedWith?.code).toBe(1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects fatal close codes (4004 Authentication Failed & 4014 Disallowed Intents) without infinite reconnects", async () => {
      const sockets4004: MockWebSocket[] = [];
      const authConnector = createDiscordConnector({
        botToken: "bad-token",
        gatewayUrl: "wss://gateway.discord.gg/",
        botUserId: "10001",
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          sockets4004.push(ws);
          queueMicrotask(() => {
            ws.serverOpen();
            ws.serverClose(4004, "Authentication failed.");
          });
          return ws;
        },
        reconnectDelaysMs: [10],
      });

      await expect(authConnector.start()).rejects.toThrow(ConnectorAuthError);
      expect(sockets4004).toHaveLength(1);

      const sockets4014: MockWebSocket[] = [];
      const intentsConnector = createDiscordConnector({
        botToken: "good-token",
        gatewayUrl: "wss://gateway.discord.gg/",
        botUserId: "10001",
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          sockets4014.push(ws);
          queueMicrotask(() => {
            ws.serverOpen();
            ws.serverClose(4014, "Disallowed intent(s).");
          });
          return ws;
        },
        reconnectDelaysMs: [10],
      });

      await expect(intentsConnector.start()).rejects.toThrow(ConnectorTransportError);
      expect(sockets4014).toHaveLength(1);
    });
  });

  describe("MESSAGE_CREATE routing (DM, @mention, Thread, Bot self-message filtering, Context Marker)", () => {
    it("filters bot/self messages and routes DM, @mentioned Guild Channel, Thread, and Context Marker replies", async () => {
      const sockets: MockWebSocket[] = [];
      const fetchFn: typeof fetch = vi.fn(async (input) => {
        const url = input instanceof URL ? input.href : String(input);
        if (url.endsWith("/threads")) {
          return new Response(
            JSON.stringify({
              id: "700003",
              type: 11,
              parent_id: "500001",
              owner_id: "10001",
              name: "Created thread",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: "500001", type: 0, name: "general" }), {
          status: 200,
        });
      });

      const connector = createDiscordConnector({
        botToken: "test-bot-token",
        gatewayUrl: "wss://gateway.discord.gg/",
        botUserId: "10001",
        fetchFn,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          sockets.push(ws);
          return ws;
        },
      });

      const { ctx, received } = createTestReceiverContext();
      const receiver = connector.getReceiver()!;
      await receiver.init!(ctx);

      const startPromise = connector.start();
      await Promise.resolve();
      const ws = sockets[0]!;
      ws.serverOpen();
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.HELLO,
        d: { heartbeat_interval: 45_000 },
      });
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 1,
        t: "READY",
        d: {
          v: 10,
          user: { id: "10001", username: "dsh-bot", bot: true },
          session_id: "sess_1",
          resume_gateway_url: "wss://gateway.discord.gg",
          application: { id: "20001" },
        },
      });
      await startPromise;

      // 1. Bot's own message -> MUST be ignored
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "800001",
          channel_id: "300001",
          author: { id: "10001", username: "dsh-bot", bot: true },
          content: "I am the bot",
          timestamp: "2026-11-23T10:00:00.000Z",
          type: 0,
        },
      });

      // 2. Another bot's message -> MUST be ignored
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 3,
        t: "MESSAGE_CREATE",
        d: {
          id: "800002",
          channel_id: "300001",
          author: { id: "99999", username: "other-bot", bot: true },
          content: "Beep boop",
          timestamp: "2026-11-23T10:00:01.000Z",
          type: 0,
        },
      });

      // 3. Unmentioned guild channel message -> MUST be ignored
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 4,
        t: "MESSAGE_CREATE",
        d: {
          id: "800003",
          guild_id: "900001",
          channel_id: "500001",
          channel_type: 0,
          author: { id: "600001", username: "alice" },
          content: "random chat without mentioning bot",
          mentions: [],
          timestamp: "2026-11-23T10:00:02.000Z",
          type: 0,
        },
      });

      // 4. Direct Message (DM) -> routed to dm:300001 without mention
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 5,
        t: "MESSAGE_CREATE",
        d: {
          id: "800004",
          channel_id: "300001",
          channel_type: 1,
          author: { id: "600001", username: "alice", global_name: "Alice" },
          content: "Hello in DM!",
          timestamp: "2026-11-23T10:00:03.000Z",
          type: 0,
        },
      });

      // 5. Guild Channel @mention -> routed to channel:500001 with mention stripped
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 6,
        t: "MESSAGE_CREATE",
        d: {
          id: "800005",
          guild_id: "900001",
          channel_id: "500001",
          channel_type: 0,
          author: { id: "600001", username: "alice" },
          member: { nick: "Alice (Dev)" },
          content: "<@10001> deploy staging please",
          mentions: [{ id: "10001", username: "dsh-bot", bot: true }],
          timestamp: "2026-11-23T10:00:04.000Z",
          type: 0,
        },
      });

      // 6. Thread message (after THREAD_CREATE cached parent_id) -> routed to thread:500001:700001 without mention
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 7,
        t: "THREAD_CREATE",
        d: {
          id: "700001",
          guild_id: "900001",
          parent_id: "500001",
          type: 11,
          name: "Bug thread",
        },
      });
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 8,
        t: "MESSAGE_CREATE",
        d: {
          id: "800006",
          guild_id: "900001",
          channel_id: "700001",
          channel_type: 11,
          author: { id: "600002", username: "bob" },
          content: "Follow up inside thread",
          mentions: [],
          timestamp: "2026-11-23T10:00:05.000Z",
          type: 0,
        },
      });

      // 7. Reply to a bot message containing a [#ctx:...] marker -> binds extracted contextId and strips marker!
      const markedParentText = prependContextMarker(
        "Alert #42 triggered",
        "550e8400-e29b-41d4-a716-446655440000",
        "bracket",
      );
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 9,
        t: "MESSAGE_CREATE",
        d: {
          id: "800007",
          guild_id: "900001",
          channel_id: "500001",
          channel_type: 0,
          author: { id: "600001", username: "alice" },
          content: "Acknowledge and rollback",
          mentions: [],
          type: 19,
          message_reference: { message_id: "799999", channel_id: "500001" },
          referenced_message: {
            id: "799999",
            channel_id: "500001",
            author: { id: "10001", username: "dsh-bot", bot: true },
            content: markedParentText,
            timestamp: "2026-11-23T09:59:00.000Z",
            type: 0,
          },
          timestamp: "2026-11-23T10:00:06.000Z",
        },
      });

      // Wait for async message handlers
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(received).toHaveLength(4);

      expect(received[0]?.context.contextId).toBe("dm:300001");
      expect(received[0]?.params.text).toBe("Hello in DM!");
      expect(received[0]?.meta?.idempotencyKey).toBe("discord:msg:800004");

      expect(received[1]?.context.contextId).toBe("channel:500001");
      expect(received[1]?.params.text).toBe("deploy staging please");
      expect(received[1]?.params.authorName).toBe("Alice (Dev)");

      expect(received[2]?.context.contextId).toBe("thread:500001:700001");
      expect(received[2]?.params.isThread).toBe(true);
      expect(received[2]?.params.text).toBe("Follow up inside thread");

      expect(received[3]?.context.contextId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(received[3]?.params.referencedText).toBe("Alert #42 triggered");

      const formatted = receiver.formatInbound!(
        received[1]!.params,
        createConnectorContext("discord", "channel:500001"),
      );
      expect(typeof formatted === "object" ? formatted.text : formatted).toContain(
        "deploy staging please",
      );

      await connector.stop();
    });
  });

  describe("Interactions HTTP Webhook (Ed25519 verification, PING -> PONG, Command/Component/Modal routing)", () => {
    it("handles 405 non-POST, 401 bad signature, 200 PONG on PING, and 200 DEFERRED ack on slash commands & modals", async () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const otherKeys = generateKeyPairSync("ed25519");
      const publicKeyHex = Buffer.from(
        publicKey.export({ format: "jwk" }).x ?? "",
        "base64url",
      ).toString("hex");

      const connector = createDiscordConnector({
        publicKey: publicKeyHex,
        enableGateway: false,
      });

      const { ctx, received } = createTestReceiverContext();
      const receiver = connector.getReceiver()!;
      await receiver.init!(ctx);

      // 1. GET -> 405
      const methodRes = await receiver.handleWebhook!(
        createSignedWebhookRequest(privateKey, { type: 1 }, "1763892000", "GET"),
      );
      expect(methodRes.status).toBe(405);

      // 2. Wrong signature -> 401
      const badSigRes = await receiver.handleWebhook!(
        createSignedWebhookRequest(otherKeys.privateKey, { type: 1 }),
      );
      expect(badSigRes.status).toBe(401);

      // 3. PING (type: 1) -> 200 {"type":1}
      const pingRes = await receiver.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "910001",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.PING,
          token: "ping_tok",
        }),
      );
      expect(pingRes.status).toBe(200);
      expect(pingRes.headers?.["content-type"]).toContain("application/json");
      expect(JSON.parse(String(pingRes.body))).toEqual({
        type: DISCORD_INTERACTION_CALLBACK_TYPES.PONG,
      });
      expect(received).toHaveLength(0);

      // 4. APPLICATION_COMMAND (type: 2) in a Thread -> routes to thread:500001:700001 and returns DEFERRED (type: 5)
      const cmdRes = await receiver.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "910002",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
          token: "cmd_tok_123",
          guild_id: "900001",
          channel_id: "700001",
          channel: {
            id: "700001",
            type: 11,
            parent_id: "500001",
            name: "Incident #9",
          },
          member: {
            nick: "Charlie",
            user: { id: "600003", username: "charlie" },
          },
          data: {
            id: "cmd_1",
            name: "ask",
            type: 1,
            options: [{ name: "prompt", type: 3, value: "check pod logs" }],
          },
        }),
      );
      expect(cmdRes.status).toBe(200);
      expect(JSON.parse(String(cmdRes.body))).toEqual({
        type: DISCORD_INTERACTION_CALLBACK_TYPES.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      });
      expect(received).toHaveLength(1);
      expect(received[0]?.context.contextId).toBe("thread:500001:700001");
      expect(received[0]?.params.commandName).toBe("ask");
      expect(received[0]?.params.interactionToken).toBe("cmd_tok_123");
      expect(received[0]?.params.text).toContain("check pod logs");
      expect(received[0]?.meta?.idempotencyKey).toBe("discord:interaction:910002");

      // 5. MESSAGE_COMPONENT (type: 3) in DM & MODAL_SUBMIT (type: 5)
      const modalRes = await receiver.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "910003",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.MODAL_SUBMIT,
          token: "modal_tok_456",
          channel_id: "300009",
          user: { id: "600004", username: "dana" },
          data: {
            custom_id: "feedback_modal",
            components: [
              {
                type: 1,
                components: [{ type: 4, custom_id: "details", value: "All services healthy" }],
              },
            ],
          },
        }),
      );
      expect(modalRes.status).toBe(200);
      expect(received).toHaveLength(2);
      expect(received[1]?.context.contextId).toBe("dm:300009");
      expect(received[1]?.params.customId).toBe("feedback_modal");
      expect(received[1]?.params.text).toContain("All services healthy");
    });

    it("covers webhook validation errors, unsupported/bot interactions, nested subcommands, and MESSAGE_COMPONENT deferred updates", async () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyHex = Buffer.from(
        publicKey.export({ format: "jwk" }).x ?? "",
        "base64url",
      ).toString("hex");

      // Missing publicKey -> 401
      const noKeyConnector = createDiscordConnector({
        botToken: "tok",
        enableGateway: false,
      });
      const noKeyRes = await noKeyConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, { type: 1 }),
      );
      expect(noKeyRes.status).toBe(401);

      // Uninitialized receiverContext -> 500
      const uninitConnector = createDiscordConnector({
        publicKey: publicKeyHex,
        botUserId: "10001",
      });
      const uninitRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "920001",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
          token: "tok_1",
          channel_id: "400001",
          user: { id: "600001", username: "alice" },
        }),
      );
      expect(uninitRes.status).toBe(500);

      // Initialize receiverContext
      const { ctx, received } = createTestReceiverContext();
      await uninitConnector.getReceiver()!.init!(ctx);
      await uninitConnector.start();
      await uninitConnector.stop();

      // Malformed JSON -> 400
      const badJsonRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, "{not-json"),
      );
      expect(badJsonRes.status).toBe(400);

      // Non-object / missing numeric type -> 400
      const badTypeRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, { hello: "world" }),
      );
      expect(badTypeRes.status).toBe(400);

      // Missing id/token -> 400
      const missingFieldsRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
        }),
      );
      expect(missingFieldsRes.status).toBe(400);

      // Unsupported interaction type (4 = AUTOCOMPLETE) -> 202
      const autoRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "920002",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND_AUTOCOMPLETE,
          token: "tok_2",
        }),
      );
      expect(autoRes.status).toBe(202);

      // Missing invoking user -> 400
      const noUserRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "920003",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
          token: "tok_3",
          channel_id: "400001",
        }),
      );
      expect(noUserRes.status).toBe(400);

      // Bot-invoked interaction -> 202 ignored
      const botInterRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "920004",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
          token: "tok_4",
          channel_id: "400001",
          user: { id: "999999", username: "helper-bot", bot: true },
        }),
      );
      expect(botInterRes.status).toBe(202);

      // Missing channel_id -> 400
      const noChanRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "920005",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
          token: "tok_5",
          user: { id: "600001", username: "alice" },
        }),
      );
      expect(noChanRes.status).toBe(400);

      // Nested subcommand options in Guild channel + MESSAGE_COMPONENT with values & context marker
      const nestedCmdRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "920006",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
          token: "tok_6",
          guild_id: "900001",
          channel_id: "500001",
          channel: { id: "500001", type: 0 },
          user: { id: "600001", username: "alice", global_name: "Alice G" },
          data: {
            name: "ops",
            options: [
              {
                name: "deploy",
                type: 1,
                options: [
                  { name: "env", type: 3, value: "prod" },
                  { name: "dry_run", type: 5 },
                ],
              },
            ],
          },
        }),
      );
      expect(nestedCmdRes.status).toBe(200);
      expect(received.at(-1)?.context.contextId).toBe("channel:500001");
      expect(received.at(-1)?.params.text).toBe("/ops deploy env: prod dry_run");

      const markedMsg = prependContextMarker(
        "Choose action:",
        "550e8400-e29b-41d4-a716-446655440099",
        "bracket",
      );
      const compRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "920007",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.MESSAGE_COMPONENT,
          token: "tok_7",
          guild_id: "900001",
          channel_id: "500001",
          user: { id: "600001", username: "alice" },
          message: {
            id: "890001",
            channel_id: "500001",
            author: { id: "10001", username: "dsh-bot", bot: true },
            content: markedMsg,
            timestamp: "2026-11-23T10:00:00.000Z",
            type: 0,
          },
          data: {
            custom_id: "approve_select",
            values: ["ship_it", "notify_oncall"],
          },
        }),
      );
      expect(compRes.status).toBe(200);
      expect(JSON.parse(String(compRes.body))).toEqual({
        type: DISCORD_INTERACTION_CALLBACK_TYPES.DEFERRED_UPDATE_MESSAGE,
      });
      expect(received.at(-1)?.context.contextId).toBe("550e8400-e29b-41d4-a716-446655440099");
      expect(received.at(-1)?.params.text).toBe(
        "[component:approve_select]: ship_it, notify_oncall",
      );

      // Modal with row-level value and multi-select values
      const modalSelectRes = await uninitConnector.getReceiver()!.handleWebhook!(
        createSignedWebhookRequest(privateKey, {
          id: "920008",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.MODAL_SUBMIT,
          token: "tok_8",
          channel_id: "300009",
          user: { id: "600001", username: "alice" },
          data: {
            custom_id: "multi_modal",
            components: [
              {
                type: 4,
                custom_id: "top_val",
                value: "direct",
                components: [{ type: 3, custom_id: "tags", values: ["p0", "infra"] }],
              },
            ],
          },
        }),
      );
      expect(modalSelectRes.status).toBe(200);
      expect(received.at(-1)?.params.text).toContain("tags: p0, infra");
    });
  });

  describe("Additional edge cases for Connector options, Gateway dispatches/frames, auto-thread, and attachments", () => {
    it("validates connector options, streaming path errors, and Gateway URL protocol rules", () => {
      expect(() => createDiscordConnector({})).toThrow(ConnectorValidationError);
      expect(() =>
        createDiscordConnector({ publicKey: "a".repeat(64), enableGateway: true }),
      ).toThrow(ConnectorValidationError);
      expect(() => buildEditOriginalInteractionPath("20001", "   ")).toThrow(
        ConnectorValidationError,
      );
      expect(() => buildEditOriginalInteractionPath("20001", "bad/slash")).toThrow(
        ConnectorValidationError,
      );
      expect(() => buildDiscordGatewayUrl("not a valid url")).toThrow(ConnectorValidationError);
      expect(() => buildDiscordGatewayUrl("ws://insecure.example.com")).toThrow(
        ConnectorValidationError,
      );
      expect(buildDiscordGatewayUrl("wss://gateway.discord.gg")).toBe(
        "wss://gateway.discord.gg/?v=10&encoding=json",
      );

      const restConnector = createDiscordConnector({
        botToken: "tok_rest",
        enableGateway: false,
      });
      expect(restConnector.getRestClient()).toBeInstanceOf(DiscordRestClient);
    });

    it("handles binary frames, op 7 RECONNECT, session-reset 4009, GUILD_CREATE/THREAD_LIST_SYNC/DELETE cache, createWebSocket retry, and stop-before-READY", async () => {
      vi.useFakeTimers();
      try {
        const logger = createSilentLogger();
        const sockets: MockWebSocket[] = [];
        let failFirstSocket = true;

        const api = new DiscordRestClient({
          botToken: "tok",
          fetchFn: vi.fn(async () => new Response("{}", { status: 200 })),
        });

        const gateway = new DiscordGatewayClient({
          botToken: "tok",
          api,
          gatewayUrl: "wss://gateway.discord.gg",
          botUserId: "10001",
          shard: [0, 1],
          reconnectDelaysMs: [50],
          randomFn: () => 0.25,
          logger,
          createWebSocket: (url) => {
            if (failFirstSocket) {
              failFirstSocket = false;
              throw new Error("Transient DNS failure");
            }
            const ws = new MockWebSocket(url);
            sockets.push(ws);
            return ws;
          },
          onMessageCreate: async () => {
            throw new Error("boom inside message handler");
          },
        });

        const startPromise = gateway.start();
        await vi.advanceTimersByTimeAsync(0);
        // First attempt threw -> scheduled reconnect at 50ms
        expect(sockets).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(50);
        expect(sockets).toHaveLength(1);

        const ws1 = sockets[0]!;
        ws1.serverOpen();
        ws1.serverError(new Error("socket hiccup"));
        // Malformed JSON & ArrayBuffer frames
        ws1.serverSend("not-json");
        const helloBytes = new TextEncoder().encode(
          JSON.stringify({ op: DISCORD_GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 4000 } }),
        );
        ws1.serverSend(helloBytes);

        // Send READY inside an ArrayBuffer!
        const readyBuf = new TextEncoder().encode(
          JSON.stringify({
            op: DISCORD_GATEWAY_OPCODES.DISPATCH,
            s: 10,
            t: "READY",
            d: {
              v: 10,
              user: { id: "10001", username: "bot", bot: true },
              session_id: "sess_bin",
              resume_gateway_url: "wss://resume.discord.gg",
              application: { id: "app_20001" },
            },
          }),
        ).buffer;
        // Dispatch ArrayBuffer directly via message event
        ws1.serverSend(readyBuf);
        await startPromise;
        // Calling start() while already running is a no-op
        await gateway.start();

        expect(gateway.getBotUserId()).toBe("10001");
        expect(gateway.getApplicationId()).toBe("app_20001");

        // Cache events: GUILD_CREATE, CHANNEL_UPDATE, THREAD_LIST_SYNC, CHANNEL_DELETE, THREAD_DELETE
        ws1.serverSend({
          op: DISCORD_GATEWAY_OPCODES.DISPATCH,
          s: 11,
          t: "GUILD_CREATE",
          d: {
            id: "900001",
            channels: [{ id: "500010", type: 0, name: "eng" }],
            threads: [{ id: "700010", type: 11, parent_id: "500010", name: "t1" }],
          },
        });
        expect(gateway.getCachedChannel("500010")?.name).toBe("eng");
        expect(gateway.getCachedChannel("700010")?.parent_id).toBe("500010");

        ws1.serverSend({
          op: DISCORD_GATEWAY_OPCODES.DISPATCH,
          s: 12,
          t: "THREAD_LIST_SYNC",
          d: {
            threads: [{ id: "700011", type: 11, parent_id: "500010", name: "t2" }],
          },
        });
        expect(gateway.getCachedChannel("700011")?.name).toBe("t2");

        ws1.serverSend({
          op: DISCORD_GATEWAY_OPCODES.DISPATCH,
          s: 13,
          t: "CHANNEL_DELETE",
          d: { id: "500010" },
        });
        ws1.serverSend({
          op: DISCORD_GATEWAY_OPCODES.DISPATCH,
          s: 14,
          t: "THREAD_DELETE",
          d: { id: "700011" },
        });
        expect(gateway.getCachedChannel("500010")).toBeUndefined();
        expect(gateway.getCachedChannel("700011")).toBeUndefined();

        // Trigger MESSAGE_CREATE whose handler rejects -> logged cleanly without unhandled rejection
        ws1.serverSend({
          op: DISCORD_GATEWAY_OPCODES.DISPATCH,
          s: 15,
          t: "MESSAGE_CREATE",
          d: {
            id: "880001",
            channel_id: "700010",
            author: { id: "600001", username: "alice" },
            content: "hi",
            timestamp: "2026-11-23T10:00:00.000Z",
            type: 0,
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.error).toHaveBeenCalled();

        // Server sends RECONNECT (op 7) -> reconnects and RESUMES
        ws1.serverSend({ op: DISCORD_GATEWAY_OPCODES.RECONNECT });
        await vi.advanceTimersByTimeAsync(50);
        expect(sockets).toHaveLength(2);
        const ws2 = sockets[1]!;
        ws2.serverOpen();
        // Malformed HELLO -> closes with 4000 and reconnects
        ws2.serverSend({ op: DISCORD_GATEWAY_OPCODES.HELLO, d: {} });
        await vi.advanceTimersByTimeAsync(50);
        expect(sockets).toHaveLength(3);

        // Close code 4009 (SESSION_TIMED_OUT) resets session and re-IDENTIFYs
        const ws3 = sockets[2]!;
        ws3.serverOpen();
        ws3.serverClose(4009, "Session timed out");
        await vi.advanceTimersByTimeAsync(50);
        expect(sockets).toHaveLength(4);
        const ws4 = sockets[3]!;
        ws4.serverOpen();
        ws4.serverSend({
          op: DISCORD_GATEWAY_OPCODES.HELLO,
          d: { heartbeat_interval: 4000 },
        });
        expect(ws4.sentFrames[0]?.op).toBe(DISCORD_GATEWAY_OPCODES.IDENTIFY);

        // Post-READY fatal close logs fatal termination without throwing unhandled rejection
        ws4.serverClose(4014, "Disallowed intent after ready");
        expect(logger.error).toHaveBeenCalledWith(
          "Fatal Discord Gateway session termination",
          expect.objectContaining({ error: expect.stringContaining("4014") }),
        );

        await gateway.stop();

        // Channel cache LRU eviction beyond 2048 entries
        for (let idx = 0; idx < 2052; idx += 1) {
          gateway.rememberChannel({ id: String(100_000 + idx), type: 0 });
        }
        expect(gateway.getCachedChannel("100000")).toBeUndefined();
        expect(gateway.getCachedChannel("102051")).toBeDefined();

        // Bootstrap REST failure resets running state cleanly
        const failingApi = new DiscordRestClient({
          botToken: "bad_tok",
          fetchFn: vi.fn(async () => new Response("{}", { status: 401 })),
        });
        const failingGateway = new DiscordGatewayClient({
          botToken: "bad_tok",
          api: failingApi,
          onMessageCreate: () => undefined,
        });
        await expect(failingGateway.start()).rejects.toThrow(ConnectorAuthError);

        // Stopping before READY while a reconnect timer is pending clears reconnect timer & rejects start()
        const pendingGateway = new DiscordGatewayClient({
          botToken: "tok",
          api,
          gatewayUrl: "wss://gateway.discord.gg",
          botUserId: "10001",
          reconnectDelaysMs: [500],
          createWebSocket: () => {
            throw new Error("socket creation failed");
          },
          onMessageCreate: () => undefined,
        });
        const pendingStart = pendingGateway.start();
        await vi.advanceTimersByTimeAsync(0);
        await pendingGateway.stop();
        await expect(pendingStart).rejects.toThrow(ConnectorTransportError);
      } finally {
        vi.useRealTimers();
      }
    });

    it("supports autoCreateThreadOnMention (success & fallback), uncached getChannel lookup, system/webhook filtering, and attachments formatting", async () => {
      let failThreadCreate = false;
      const fetchFn: typeof fetch = vi.fn(async (input) => {
        const url = input instanceof URL ? input.href : String(input);
        if (url.endsWith("/threads")) {
          if (failThreadCreate) {
            return new Response(JSON.stringify({ message: "Missing Permissions" }), {
              status: 403,
            });
          }
          return new Response(
            JSON.stringify({
              id: "770001",
              type: 11,
              parent_id: "550001",
              name: "Auto thread",
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/channels/770099")) {
          return new Response(
            JSON.stringify({ id: "770099", type: 11, parent_id: "550001", name: "Fetched thread" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: "550001", type: 0, name: "alerts" }), {
          status: 200,
        });
      });

      const sockets: MockWebSocket[] = [];
      const connector = createDiscordConnector({
        botToken: "tok",
        gatewayUrl: "wss://gateway.discord.gg",
        botUserId: "10001",
        autoCreateThreadOnMention: true,
        autoArchiveDurationMinutes: 60,
        fetchFn,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          sockets.push(ws);
          return ws;
        },
      });

      const { ctx, received } = createTestReceiverContext();
      const receiver = connector.getReceiver()!;
      await receiver.init!(ctx);

      const startP = connector.start();
      await Promise.resolve();
      const ws = sockets[0]!;
      ws.serverOpen();
      ws.serverSend({ op: DISCORD_GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 30_000 } });
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 1,
        t: "READY",
        d: {
          v: 10,
          user: { id: "10001", username: "dsh-bot", bot: true },
          session_id: "s1",
          resume_gateway_url: "wss://gateway.discord.gg",
        },
      });
      await startP;

      // System THREAD_STARTER_MESSAGE (type 21) and webhook message -> ignored
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "810001",
          channel_id: "770001",
          author: { id: "600001", username: "alice" },
          content: "<@10001> starter",
          timestamp: "2026-11-23T10:00:00.000Z",
          type: 21,
        },
      });
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 3,
        t: "MESSAGE_CREATE",
        d: {
          id: "810002",
          channel_id: "550001",
          webhook_id: "wh_1",
          author: { id: "600001", username: "webhook" },
          content: "<@10001> hook",
          timestamp: "2026-11-23T10:00:00.000Z",
          type: 0,
        },
      });
      // Empty mention without text or attachments -> ignored
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 4,
        t: "MESSAGE_CREATE",
        d: {
          id: "810003",
          guild_id: "900001",
          channel_id: "550001",
          author: { id: "600001", username: "alice" },
          content: "<@!10001>",
          timestamp: "2026-11-23T10:00:00.000Z",
          type: 0,
        },
      });

      // Uncached channel mention -> fetches channel (type 0) AND auto-creates thread 770001!
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 5,
        t: "MESSAGE_CREATE",
        d: {
          id: "810004",
          guild_id: "900001",
          channel_id: "550001",
          author: { id: "600001", username: "alice" },
          content: `<@!10001> ${"investigate latency spike ".repeat(6)}`,
          attachments: [
            {
              id: "att_1",
              filename: "trace.json",
              url: "https://cdn.discordapp.com/attachments/trace.json",
              content_type: "application/json",
              size: 512,
            },
          ],
          timestamp: "2026-11-23T10:00:01.000Z",
          type: 0,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toHaveLength(1);
      expect(received[0]?.context.contextId).toBe("thread:550001:770001");

      // Format inbound with referencedText + attachments
      const formatted = receiver.formatInbound!(
        {
          ...received[0]!.params,
          referencedText: "Earlier alert",
        },
        received[0]!.context,
      );
      const formattedText = typeof formatted === "object" ? formatted.text : formatted;
      expect(formattedText).toContain("> Replying to: Earlier alert");
      expect(formattedText).toContain("trace.json");

      // Auto-thread creation failure falls back gracefully to channel:550001, plus attachment-only DM
      failThreadCreate = true;
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 6,
        t: "MESSAGE_CREATE",
        d: {
          id: "810005",
          guild_id: "900001",
          channel_id: "550001",
          author: { id: "600001", username: "alice" },
          content: "<@10001> fallback test",
          timestamp: "2026-11-23T10:00:02.000Z",
          type: 0,
        },
      });
      // Uncached thread lookup via getChannel(770099) + attachment-only content
      ws.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 7,
        t: "MESSAGE_CREATE",
        d: {
          id: "810006",
          guild_id: "900001",
          channel_id: "770099",
          channel_type: 11,
          author: { id: "600001", username: "alice" },
          content: "",
          attachments: [
            {
              id: "att_2",
              filename: "screenshot.png",
              url: "https://cdn.discordapp.com/attachments/screenshot.png",
              size: 1024,
            },
          ],
          timestamp: "2026-11-23T10:00:03.000Z",
          type: 0,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toHaveLength(3);
      expect(received[1]?.context.contextId).toBe("channel:550001");
      expect(received[2]?.context.contextId).toBe("thread:550001:770099");
      expect(received[2]?.params.text).toContain("screenshot.png");

      await connector.stop();
    });

    it("covers defaultCreateDiscordWebSocket, receiver pre-init & uncached errors, gateway unknown frames, and minimal webhook payloads", async () => {
      // 1. defaultCreateDiscordWebSocket with missing vs custom globalThis.WebSocket
      const origWs = globalThis.WebSocket;
      try {
        Object.defineProperty(globalThis, "WebSocket", {
          value: undefined,
          configurable: true,
          writable: true,
        });
        expect(() => defaultCreateDiscordWebSocket("wss://gateway.discord.gg")).toThrow(
          ConnectorTransportError,
        );

        Object.defineProperty(globalThis, "WebSocket", {
          value: MockWebSocket,
          configurable: true,
          writable: true,
        });
        const created = defaultCreateDiscordWebSocket("wss://gateway.discord.gg");
        expect(created).toBeInstanceOf(MockWebSocket);
      } finally {
        Object.defineProperty(globalThis, "WebSocket", {
          value: origWs,
          configurable: true,
          writable: true,
        });
      }

      // 2. DiscordReceiver before init(), getReceiverContext(), botUserId omitted, and failing getChannel
      const errApi = new DiscordRestClient({
        botToken: "tok",
        fetchFn: vi.fn(async () => new Response("{}", { status: 500 })),
      });
      const standaloneReceiver = new DiscordReceiver({
        api: errApi,
        requireMentionInGuild: false,
      });
      expect(standaloneReceiver.getReceiverContext()).toBeUndefined();

      // Calling handleMessageCreate before init() is a safe no-op
      await standaloneReceiver.handleMessageCreate(
        {
          id: "890010",
          channel_id: "590010",
          author: { id: "600001", username: "alice" },
          content: "hello",
          timestamp: "invalid-date",
          type: 0,
        },
        {
          botUserId: undefined,
          applicationId: undefined,
          getCachedChannel: () => undefined,
          rememberChannel: () => undefined,
        },
      );

      const { ctx, received } = createTestReceiverContext();
      await standaloneReceiver.init(ctx);
      expect(standaloneReceiver.getReceiverContext()).toBe(ctx);

      // Guild message with uncached failing getChannel + learned botUserId from gatewayCtx
      await standaloneReceiver.handleMessageCreate(
        {
          id: "890011",
          guild_id: "900001",
          channel_id: "590010",
          author: { id: "600001", username: "alice" },
          content: "hello without botUserId preconfigured",
          timestamp: "invalid-date",
          type: 0,
        },
        {
          botUserId: "10001",
          applicationId: "20001",
          getCachedChannel: () => undefined,
          rememberChannel: () => undefined,
        },
      );
      // Thread message where parent lookup fails -> falls back to single-segment thread:790010
      await standaloneReceiver.handleMessageCreate(
        {
          id: "890012",
          guild_id: "900001",
          channel_id: "790010",
          channel_type: 11,
          author: { id: "600001", username: "alice" },
          content: "",
          attachments: [
            { id: "a1", filename: "doc.txt", url: "https://cdn.discordapp.com/doc.txt", size: 10 },
          ],
          timestamp: "2026-11-23T10:00:00.000Z",
          type: 0,
        },
        {
          botUserId: undefined,
          applicationId: undefined,
          getCachedChannel: () => undefined,
          rememberChannel: () => undefined,
        },
      );
      expect(received).toHaveLength(2);
      expect(received[0]?.context.contextId).toBe("channel:590010");
      expect(received[1]?.context.contextId).toBe("thread:790010");

      const dmPrompt = standaloneReceiver.formatInbound(
        {
          ...received[0]!.params,
          isDirectMessage: true,
        },
        createConnectorContext("discord", "dm:300001"),
      );
      expect(dmPrompt.title).toContain("Direct Message");

      // 3. Gateway unknown opcodes/dispatches, empty channel id, send() throwing
      const logger = createSilentLogger();
      let activeWs: MockWebSocket | undefined;
      const gw = new DiscordGatewayClient({
        botToken: "tok",
        api: new DiscordRestClient({
          botToken: "tok",
          fetchFn: vi.fn(
            async () => new Response('{"id":"10001","username":"b"}', { status: 200 }),
          ),
        }),
        gatewayUrl: "wss://gateway.discord.gg",
        botUserId: "10001",
        logger,
        createWebSocket: (url) => {
          activeWs = new MockWebSocket(url);
          return activeWs;
        },
        onMessageCreate: () => undefined,
      });
      gw.rememberChannel({ id: "", type: 0 });
      const gwStart = gw.start();
      await Promise.resolve();
      activeWs!.serverOpen();
      // Non-string/non-buffer event data, non-op object, unknown op, unknown dispatch
      activeWs!.serverSend({ op: 99, d: {} });
      activeWs!.serverSend("{}");
      activeWs!.serverSend({
        op: DISCORD_GATEWAY_OPCODES.HELLO,
        d: { heartbeat_interval: 30_000 },
      });
      activeWs!.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 1,
        t: "PRESENCE_UPDATE",
        d: {},
      });
      activeWs!.serverSend({
        op: DISCORD_GATEWAY_OPCODES.DISPATCH,
        s: 2,
        t: "READY",
        d: {
          v: 10,
          user: { id: "10001", username: "bot" },
          session_id: "s_x",
          resume_gateway_url: "wss://gateway.discord.gg",
        },
      });
      await gwStart;
      activeWs!.send = () => {
        throw new Error("broken pipe");
      };
      activeWs!.serverSend({ op: DISCORD_GATEWAY_OPCODES.HEARTBEAT, d: null });
      expect(logger.warn).toHaveBeenCalled();
      await gw.stop();

      // 4. Minimal webhook interactions (no data, command without options, component without values, modal without components)
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyHex = Buffer.from(
        publicKey.export({ format: "jwk" }).x ?? "",
        "base64url",
      ).toString("hex");
      const whConn = createDiscordConnector({ publicKey: publicKeyHex });
      await whConn.getReceiver()!.init!(ctx);

      for (const [idx, payload] of [
        {
          id: "930001",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
          token: "t1",
          channel_id: "300001",
          user: { id: "600001", username: "alice" },
        },
        {
          id: "930002",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND,
          token: "t2",
          channel_id: "300001",
          user: { id: "600001", username: "alice" },
          data: { name: "ping" },
        },
        {
          id: "930003",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.MESSAGE_COMPONENT,
          token: "t3",
          channel_id: "300001",
          user: { id: "600001", username: "alice" },
          data: { custom_id: "btn_ok" },
        },
        {
          id: "930004",
          application_id: "20001",
          type: DISCORD_INTERACTION_TYPES.MODAL_SUBMIT,
          token: "t4",
          channel_id: "300001",
          user: { id: "600001", username: "alice" },
          data: { custom_id: "empty_modal" },
        },
      ].entries()) {
        const res = await whConn.getReceiver()!.handleWebhook!(
          createSignedWebhookRequest(privateKey, payload, `176389200${idx}`),
        );
        expect(res.status).toBe(200);
      }
    });
  });
});
