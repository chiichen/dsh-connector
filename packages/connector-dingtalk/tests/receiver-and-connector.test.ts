import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorInboundPrompt,
  type ConnectorReceiverContext,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import {
  buildDingTalkStreamWebSocketUrl,
  computeDingTalkSignature,
  createDingTalkConnector,
  DingTalkConnector,
  DingTalkReceiver,
  dingTalkReceiveSchema,
  type DingTalkCloseEventLike,
  type DingTalkInboundMessage,
  type DingTalkMessageEventLike,
  type DingTalkStreamingAdapter,
  type DingTalkWebSocketLike,
} from "../src";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type WsEventType = "open" | "message" | "error" | "close";
type WsListener = (event: DingTalkMessageEventLike & DingTalkCloseEventLike) => void;

class MockWebSocket implements DingTalkWebSocketLike {
  readyState = 0;
  readonly sentFrames: string[] = [];
  closedWith?: { code?: number; reason?: string };
  private readonly listeners: Record<WsEventType, Set<WsListener>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  constructor(readonly url: string) {}

  addEventListener(type: WsEventType, listener: WsListener): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: WsEventType, listener: WsListener): void {
    this.listeners[type].delete(listener);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  simulateServerMessage(frame: unknown): void {
    const raw = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.emit("message", { data: raw });
  }

  simulateBinaryMessage(bytes: Uint8Array): void {
    this.emit("message", { data: bytes });
  }

  simulateError(): void {
    this.emit("error", {});
  }

  simulateServerClose(code = 1006, reason = "abnormal"): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  emit(type: WsEventType, event: DingTalkMessageEventLike & DingTalkCloseEventLike): void {
    const snapshot = Array.from(this.listeners[type]);
    for (const listener of snapshot) {
      listener(event);
    }
  }
}

function createHarness<TName extends string = "dingtalk">(connectorName: TName) {
  const received: Array<{
    context: ConnectorContext<TName>;
    params: DingTalkInboundMessage;
    meta?: InboundDeliveryMeta;
    formatted?: ConnectorInboundPrompt | string;
  }> = [];
  const generator = createDefaultContextIdGenerator();

  const ctx: ConnectorReceiverContext<typeof dingTalkReceiveSchema, TName> = {
    allocateContextId: () => generator.generate(connectorName),
    contextIdGenerator: generator,
    onReceive: async (context, params, meta) => {
      received.push({
        context,
        params,
        ...(meta !== undefined ? { meta } : {}),
      });
      return { sessionId: `sess-${received.length}`, deduplicated: false };
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  };

  return { ctx, received };
}

describe("Stage 3: DingTalkReceiver (Webhook + Stream WebSocket) and DingTalkConnector", () => {
  describe("HTTP Outgoing webhook handling, loop filtering, context markers, and sessionWebhook round-trip", () => {
    it("verifies HMAC-SHA256 headers, normalizes text/richText/audio/quoted markers, caches sessionWebhook, and filters self-messages", async () => {
      const nowMs = 1_700_000_000_000;
      const secret = "webhook-secret-123";
      const ts = String(nowMs - 5_000);
      const sign = computeDingTalkSignature(ts, secret);

      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok" }));

      const connector = createDingTalkConnector({
        webhookSigningSecret: secret,
        botUserIds: ["$:LWCP_v1:$configured-bot"],
        botStaffIds: ["bot-staff-id"],
        requireAtInGroup: true,
        now: () => nowMs,
        fetchFn: fetchMock,
      });

      const receiver = connector.getReceiver()!;
      const sender = connector.getSender()!;
      const { ctx, received } = createHarness("dingtalk");
      await receiver.init?.(ctx);
      await connector.start();

      // 1. Non-POST -> 405
      const getRes = await receiver.handleWebhook!({
        method: "GET",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: {},
        rawBody: new Uint8Array(),
      });
      expect(getRes.status).toBe(405);

      // 2. Bad signature -> 401
      const unauthRes = await receiver.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: { timestamp: ts, sign: "bad" },
        rawBody: new TextEncoder().encode("{}"),
      });
      expect(unauthRes.status).toBe(401);

      // 3. Invalid JSON -> 400
      const badJsonRes = await receiver.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: { timestamp: ts, sign },
        rawBody: new TextEncoder().encode("{not-json"),
      });
      expect(badJsonRes.status).toBe(400);

      // 4. Bot self-message (senderId === chatbotUserId) -> ignored 200
      const selfRes = await receiver.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: { timestamp: ts, sign },
        rawBody: new TextEncoder().encode(
          JSON.stringify({
            msgId: "msg-self",
            msgtype: "text",
            text: { content: "echo loop" },
            conversationId: "cid-1",
            conversationType: "2",
            senderId: "$:LWCP_v1:$bot",
            chatbotUserId: "$:LWCP_v1:$bot",
            isInAtList: true,
          }),
        ),
      });
      expect(selfRes.status).toBe(200);
      expect(received).toHaveLength(0);

      // 5. Group message without @bot when requireAtInGroup: true -> ignored 200
      const notAtRes = await receiver.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: { timestamp: ts, sign },
        rawBody: new TextEncoder().encode(
          JSON.stringify({
            msgId: "msg-no-at",
            msgtype: "text",
            text: { content: "casual chat" },
            conversationId: "cid-1",
            conversationType: "2",
            senderId: "$:LWCP_v1:$user1",
            isInAtList: false,
          }),
        ),
      });
      expect(notAtRes.status).toBe(200);
      expect(received).toHaveLength(0);

      // 6. Group message with quoted context marker + sessionWebhook -> binds quoted contextId & caches sessionWebhook
      const quotedContent = prependContextMarker(
        "Previous bot report",
        "ticket:INC-7788",
        "bracket",
      );
      const groupWebhookUrl = "https://oapi.dingtalk.com/robot/sendBySession?session=grp7788";
      const validGroupRes = await receiver.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: { timestamp: ts, sign },
        rawBody: new TextEncoder().encode(
          JSON.stringify({
            msgId: "msg-group-1",
            msgtype: "text",
            text: {
              content: " @Bot please follow up ",
              isReplyMsg: true,
              repliedMsg: {
                msgType: "text",
                content: JSON.stringify({ text: quotedContent }),
              },
            },
            conversationId: "cidGroup7788==",
            conversationType: "2",
            conversationTitle: "SRE War Room",
            senderId: "$:LWCP_v1:$alice",
            senderStaffId: "alice01",
            senderNick: "Alice",
            chatbotUserId: "$:LWCP_v1:$bot",
            isInAtList: true,
            sessionWebhook: groupWebhookUrl,
            sessionWebhookExpiredTime: nowMs + 600_000,
            createAt: nowMs - 1_000,
          }),
        ),
      });
      expect(validGroupRes.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]!.context.contextId).toBe("ticket:INC-7788");
      expect(received[0]!.params.text).toBe("@Bot please follow up");
      expect(received[0]!.params.quotedText).toBe("Previous bot report");
      expect(received[0]!.meta?.idempotencyKey).toBe("msg-group-1");

      const formatted = receiver.formatInbound!(received[0]!.params, received[0]!.context);
      expect(typeof formatted).toBe("object");
      if (typeof formatted === "object") {
        expect(formatted.title).toContain("SRE War Room");
        expect(formatted.text).toContain("> Previous bot report");
        expect(formatted.text).toContain("@Bot please follow up");
      }

      // Outbound reply on `group:cidGroup7788==` in webhook-only mode automatically uses cached sessionWebhook!
      const sendRes = await sender.send(createConnectorContext(connector, "group:cidGroup7788=="), {
        text: "Acknowledged INC-7788",
      });
      expect(sendRes.channel).toBe("sessionWebhook");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 7. RichText & Audio recognition in single chat
      await receiver.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: { timestamp: ts, sign },
        rawBody: new TextEncoder().encode(
          JSON.stringify({
            msgId: "msg-rich-1",
            msgtype: "richText",
            content: {
              richText: [
                { text: "Line one" },
                { type: "picture", downloadCode: "dl-1" },
                { text: { content: "Line two" } },
              ],
            },
            conversationId: "cid-dm-1",
            conversationType: "1",
            senderId: "$:LWCP_v1:$bob",
            senderStaffId: "bob02",
            senderNick: "Bob",
          }),
        ),
      });
      expect(received).toHaveLength(2);
      expect(received[1]!.context.contextId).toBe("p2p:bob02");
      expect(received[1]!.params.text).toBe("Line one\n[picture]\nLine two");

      await receiver.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: { timestamp: ts, sign },
        rawBody: new TextEncoder().encode(
          JSON.stringify({
            msgId: "msg-audio-1",
            msgtype: "audio",
            content: {
              recognition: "语音识别内容",
              duration: 3000,
            },
            conversationId: "cid-dm-2",
            conversationType: "1",
            senderId: "$:LWCP_v1:$externalOnly",
          }),
        ),
      });
      expect(received).toHaveLength(3);
      expect(received[2]!.context.contextId).toBe("p2p-id:$:LWCP_v1:$externalOnly");
      expect(received[2]!.params.text).toBe("语音识别内容");

      await connector.stop();
    });
  });

  describe("Stream mode WebSocket registration, ping/CALLBACK/EVENT ACKs, disconnect & reconnect", () => {
    it("builds WebSocket URL accurately regardless of endpoint trailing path", () => {
      expect(
        buildDingTalkStreamWebSocketUrl(
          "wss://wss-open-connection.dingtalk.com:443/connect",
          "ticket-abc",
        ),
      ).toBe("wss://wss-open-connection.dingtalk.com/connect?ticket=ticket-abc");

      expect(
        buildDingTalkStreamWebSocketUrl("wss://wss-open-connection.dingtalk.com", "ticket-xyz"),
      ).toBe("wss://wss-open-connection.dingtalk.com/connect?ticket=ticket-xyz");
    });

    it("opens Stream gateway, ACKs ping/CALLBACK/EVENT frames, handles server disconnect, and reconnects cleanly", async () => {
      const sockets: MockWebSocket[] = [];
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            endpoint: "wss://wss-open-connection.dingtalk.com:443/connect",
            ticket: "ticket-1",
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            endpoint: "wss://wss-open-connection.dingtalk.com:443/connect",
            ticket: "ticket-2",
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            endpoint: "wss://wss-open-connection.dingtalk.com:443/connect",
            ticket: "ticket-3",
          }),
        );

      const connector = new DingTalkConnector({
        name: "dingtalk-stream",
        clientId: "ding-app-id",
        clientSecret: "ding-app-secret",
        localIp: "10.0.0.8",
        streamSubscriptions: [{ type: "EVENT", topic: "*" }],
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 50,
        fetchFn: fetchMock,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          sockets.push(ws);
          queueMicrotask(() => ws.simulateOpen());
          return ws;
        },
      });

      const { ctx, received } = createHarness("dingtalk-stream");
      await connector.getReceiver()!.init!(ctx);
      await connector.start();
      // Calling start() again while running is idempotent
      await connector.start();

      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.url).toContain("ticket=ticket-1");

      const [openUrl, openInit] = fetchMock.mock.calls[0]!;
      expect(String(openUrl)).toBe("https://api.dingtalk.com/v1.0/gateway/connections/open");
      expect(JSON.parse(String(openInit?.body))).toMatchObject({
        clientId: "ding-app-id",
        clientSecret: "ding-app-secret",
        localIp: "10.0.0.8",
        subscriptions: [
          { type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" },
          { type: "EVENT", topic: "*" },
        ],
      });

      // 1. SYSTEM ping -> echoes opaque in ACK
      sockets[0]!.simulateServerMessage({
        specVersion: "1.0",
        type: "SYSTEM",
        headers: {
          topic: "ping",
          messageId: "sys-ping-1",
          contentType: "application/json",
        },
        data: JSON.stringify({ opaque: "opaque-uuid-99" }),
      });

      expect(sockets[0]!.sentFrames).toHaveLength(1);
      expect(JSON.parse(sockets[0]!.sentFrames[0]!)).toEqual({
        code: 200,
        headers: {
          contentType: "application/json",
          messageId: "sys-ping-1",
        },
        message: "OK",
        data: JSON.stringify({ opaque: "opaque-uuid-99" }),
      });

      // 2. CALLBACK robot message -> sends immediate 200 OK ACK and dispatches onReceive
      sockets[0]!.simulateServerMessage({
        specVersion: "1.0",
        type: "CALLBACK",
        headers: {
          topic: "/v1.0/im/bot/messages/get",
          messageId: "cb-msg-1",
          contentType: "application/json",
        },
        data: JSON.stringify({
          msgId: "dt-msg-101",
          msgtype: "text",
          text: { content: "Stream hello!" },
          conversationId: "cid-stream-1",
          conversationType: "1",
          senderId: "$:LWCP_v1:$u101",
          senderStaffId: "staff101",
          senderNick: "Charlie",
        }),
      });

      expect(sockets[0]!.sentFrames).toHaveLength(2);
      expect(JSON.parse(sockets[0]!.sentFrames[1]!)).toEqual({
        code: 200,
        headers: {
          contentType: "application/json",
          messageId: "cb-msg-1",
        },
        message: "OK",
        data: JSON.stringify({ response: {} }),
      });

      await vi.waitFor(() => {
        expect(received).toHaveLength(1);
      });
      expect(received[0]!.context).toEqual(
        createConnectorContext("dingtalk-stream", "p2p:staff101"),
      );
      expect(received[0]!.params.text).toBe("Stream hello!");
      expect(received[0]!.meta?.idempotencyKey).toBe("dt-msg-101");

      // 3. EVENT frame -> sends status: SUCCESS ACK
      sockets[0]!.simulateServerMessage({
        specVersion: "1.0",
        type: "EVENT",
        headers: {
          topic: "*",
          messageId: "evt-1",
          contentType: "application/json",
        },
        data: JSON.stringify({ eventType: "user_add_org" }),
      });
      expect(sockets[0]!.sentFrames).toHaveLength(3);
      expect(JSON.parse(sockets[0]!.sentFrames[2]!)).toEqual({
        code: 200,
        headers: {
          contentType: "application/json",
          messageId: "evt-1",
        },
        message: "OK",
        data: JSON.stringify({ status: "SUCCESS", message: "OK" }),
      });

      // 4. SYSTEM disconnect -> sends NO ACK, closes current socket, and opens fresh connection (ticket-2)
      const beforeDisconnectFrames = sockets[0]!.sentFrames.length;
      sockets[0]!.simulateServerMessage({
        specVersion: "1.0",
        type: "SYSTEM",
        headers: {
          topic: "disconnect",
          messageId: "sys-disc-1",
          contentType: "application/json",
        },
        data: JSON.stringify({ reason: "rebalance" }),
      });
      expect(sockets[0]!.sentFrames).toHaveLength(beforeDisconnectFrames);

      await vi.waitFor(() => {
        expect(sockets).toHaveLength(2);
      });
      expect(sockets[1]!.url).toContain("ticket=ticket-2");

      // 5. Unexpected socket drop -> reconnects with backoff (ticket-3)
      sockets[1]!.simulateServerClose(1006, "dropped");
      await vi.waitFor(() => {
        expect(sockets).toHaveLength(3);
      });
      expect(sockets[2]!.url).toContain("ticket=ticket-3");

      // 6. stop() closes active socket and prevents any further reconnect
      await connector.stop();
      expect(sockets[2]!.readyState).toBe(3);
    });

    it("surfaces ConnectorAuthError when Stream gateway rejects credentials and exposes streaming adapter slot", async () => {
      const badGatewayFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ code: "invalidClientIdOrSecret" }, 401));

      const dummyAdapter: DingTalkStreamingAdapter<"dingtalk"> = {
        async startStream(_ctx, input) {
          return {
            outTrackId: "t1",
            cardTemplateId: "tpl",
            openSpaceId: "dtv1.card//IM_ROBOT.u1",
            streamKey: "msgContent",
            target: input.target,
          };
        },
        async updateStream() {},
        async completeStream() {},
        async abortStream() {},
      };

      const connector = createDingTalkConnector({
        clientId: "bad-id",
        clientSecret: "bad-sec",
        fetchFn: badGatewayFetch,
        streaming: {
          cardTemplateId: "tpl",
          adapter: dummyAdapter,
        },
      });

      expect(connector.getStreamingAdapter()).toBe(dummyAdapter);
      expect(connector.getStreamingOptions()?.cardTemplateId).toBe("tpl");

      const { ctx } = createHarness("dingtalk");
      await connector.getReceiver()!.init!(ctx);
      await expect(connector.start()).rejects.toBeInstanceOf(ConnectorAuthError);

      // Inbound mode "none" returns undefined receiver
      const sendOnly = createDingTalkConnector({
        clientId: "id",
        clientSecret: "sec",
        inboundMode: "none",
        fetchFn: badGatewayFetch,
      });
      expect(sendOnly.getReceiver()).toBeUndefined();
      expect(sendOnly.getSender()).toBeDefined();
      expect(sendOnly.getStreamingAdapter()).toBeUndefined();
    });

    it("handles Stream handshake failures, reconnect backoff recovery, media message types, and malformed frames gracefully", async () => {
      expect(() => buildDingTalkStreamWebSocketUrl("not-a-url", "t")).toThrow(
        ConnectorValidationError,
      );

      // Receiver without init() throws ConnectorValidationError on webhook
      const uninitConnector = createDingTalkConnector({
        outgoingToken: "tok-1",
      });
      await expect(
        uninitConnector.getReceiver()!.handleWebhook!({
          method: "POST",
          pathname: "/webhooks/dingtalk",
          subPath: "",
          query: new URLSearchParams(),
          headers: { token: "tok-1" },
          rawBody: new TextEncoder().encode("{}"),
        }),
      ).rejects.toBeInstanceOf(ConnectorValidationError);

      // Stream mode without credentials throws ConnectorAuthError
      const missingCreds = createDingTalkConnector({
        inboundMode: "stream",
      });
      await expect(missingCreds.start()).rejects.toBeInstanceOf(ConnectorAuthError);

      // Gateway 502 & missing ticket
      const gwFailFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 502))
        .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://ws.dingtalk.com" }, 200));

      const gwFailConn = createDingTalkConnector({
        clientId: "id",
        clientSecret: "sec",
        fetchFn: gwFailFetch,
      });
      await expect(gwFailConn.start()).rejects.toBeInstanceOf(ConnectorTransportError);
      await expect(gwFailConn.start()).rejects.toBeInstanceOf(ConnectorTransportError);

      // Handshake error, handshake close, and handshake timeout
      const hsFetch = vi.fn<typeof fetch>(() =>
        Promise.resolve(jsonResponse({ endpoint: "wss://ws.dingtalk.com/connect", ticket: "tk" })),
      );

      const errWsConn = createDingTalkConnector({
        clientId: "id",
        clientSecret: "sec",
        fetchFn: hsFetch,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          queueMicrotask(() => ws.simulateError());
          return ws;
        },
      });
      await expect(errWsConn.start()).rejects.toBeInstanceOf(ConnectorTransportError);

      const closeWsConn = createDingTalkConnector({
        clientId: "id",
        clientSecret: "sec",
        fetchFn: hsFetch,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          queueMicrotask(() => ws.simulateServerClose(1008, "policy"));
          return ws;
        },
      });
      await expect(closeWsConn.start()).rejects.toBeInstanceOf(ConnectorTransportError);

      const timeoutWsConn = createDingTalkConnector({
        clientId: "id",
        clientSecret: "sec",
        wsHandshakeTimeoutMs: 15,
        fetchFn: hsFetch,
        createWebSocket: (url) => new MockWebSocket(url),
      });
      await expect(timeoutWsConn.start()).rejects.toBeInstanceOf(ConnectorTransportError);

      // Aborting handshake mid-flight via stop() + safeSendFrame send error tolerance
      let pendingSocket: MockWebSocket | undefined;
      const stopDuringHandshakeConn = createDingTalkConnector({
        clientId: "id",
        clientSecret: "sec",
        wsHandshakeTimeoutMs: 5_000,
        fetchFn: hsFetch,
        createWebSocket: (url) => {
          pendingSocket = new MockWebSocket(url);
          return pendingSocket;
        },
      });
      const startPromise = stopDuringHandshakeConn.start();
      await vi.waitFor(() => {
        expect(pendingSocket).toBeDefined();
      });
      await stopDuringHandshakeConn.stop();
      await expect(startPromise).rejects.toThrow();

      let throwSocket: MockWebSocket | undefined;
      const sendErrConn = createDingTalkConnector({
        clientId: "id",
        clientSecret: "sec",
        autoReconnect: false,
        fetchFn: hsFetch,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          ws.send = () => {
            throw new Error("broken pipe");
          };
          throwSocket = ws;
          queueMicrotask(() => ws.simulateOpen());
          return ws;
        },
      });
      await sendErrConn.start();
      throwSocket!.simulateServerMessage({
        type: "SYSTEM",
        headers: { topic: "ping", messageId: "p-err" },
        data: "not-json-ping-data",
      });
      await sendErrConn.stop();

      // Reconnect failure followed by recovery + malformed frames + media types
      const sockets: MockWebSocket[] = [];
      const recoveryFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ endpoint: "wss://ws.dingtalk.com/connect", ticket: "tk-ok-1" }),
        )
        .mockResolvedValueOnce(jsonResponse({ message: "503" }, 503))
        .mockResolvedValueOnce(
          jsonResponse({ endpoint: "wss://ws.dingtalk.com/connect", ticket: "tk-ok-2" }),
        );

      const recoveryConn = createDingTalkConnector({
        clientId: "id",
        clientSecret: "sec",
        outgoingToken: "tok-both",
        inboundMode: "both",
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 25,
        fetchFn: recoveryFetch,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          sockets.push(ws);
          queueMicrotask(() => ws.simulateOpen());
          return ws;
        },
      });

      const { ctx, received } = createHarness("dingtalk");
      let failNextOnReceive = false;
      const customCtx: ConnectorReceiverContext<typeof dingTalkReceiveSchema, "dingtalk"> = {
        ...ctx,
        onReceive: async (c, p, m) => {
          if (failNextOnReceive) {
            failNextOnReceive = false;
            throw new Error("downstream transient failure");
          }
          return ctx.onReceive(c, p, m);
        },
      };
      await recoveryConn.getReceiver()!.init!(customCtx);
      await recoveryConn.start();

      // Runtime error event + malformed frames + Uint8Array binary frame + send failure resilience
      sockets[0]!.simulateError();
      sockets[0]!.simulateServerMessage("{bad-frame");
      sockets[0]!.simulateServerMessage(JSON.stringify({ noHeaders: true }));
      sockets[0]!.simulateServerMessage({
        type: "SYSTEM",
        headers: { topic: "REGISTERED" },
      });
      sockets[0]!.simulateServerMessage({
        type: "CALLBACK",
        headers: { topic: "/v1.0/im/bot/messages/get", messageId: "cb-bad-json" },
        data: "{not-json",
      });

      failNextOnReceive = true;
      const binaryFrame = new TextEncoder().encode(
        JSON.stringify({
          type: "CALLBACK",
          headers: { topic: "/v1.0/im/bot/messages/get", messageId: "cb-bin" },
          data: JSON.stringify({
            msgId: "m-err",
            msgtype: "picture",
            content: JSON.stringify({ downloadCode: "pic-dl-1" }),
            conversationId: "cid-1",
            conversationType: "1",
            senderId: "u-pic",
          }),
        }),
      );
      sockets[0]!.simulateBinaryMessage(binaryFrame);

      // Non-object JSON webhook -> 400, plus file/video/empty/object-quoted/string-richText payloads
      const rx = recoveryConn.getReceiver()!;
      const scalarWebhook = await rx.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/dingtalk",
        subPath: "",
        query: new URLSearchParams(),
        headers: { token: "tok-both" },
        rawBody: new TextEncoder().encode('"just-a-string"'),
      });
      expect(scalarWebhook.status).toBe(400);

      for (const payload of [
        { senderId: "u1" }, // missing conversationId -> ignored
        {
          msgtype: "text",
          text: { content: "   " },
          conversationId: "cid-1",
          senderId: "u1",
        }, // empty text -> ignored
        {
          msgId: "m-file",
          msgtype: "file",
          content: { fileName: "spec.pdf", downloadCode: "dl" },
          conversationId: "cid-1",
          conversationType: "1",
          senderId: "u1",
          text: {
            isReplyMsg: true,
            repliedMsg: { content: { text: "quoted object text" } },
          },
          sessionWebhook: "http://untrusted.example.com/hook",
        },
        {
          msgId: "m-video",
          msgtype: "video",
          conversationId: "cid-1",
          conversationType: "1",
          senderId: "u1",
        },
        {
          msgId: "m-rich-str",
          msgtype: "richText",
          content: JSON.stringify({
            richText: [{ content: "stringified rich item" }],
          }),
          conversationId: "cid-1",
          conversationType: "1",
          senderId: "u1",
        },
      ]) {
        const resp = await rx.handleWebhook!({
          method: "POST",
          pathname: "/webhooks/dingtalk",
          subPath: "",
          query: new URLSearchParams(),
          headers: { token: "tok-both" },
          rawBody: new TextEncoder().encode(JSON.stringify(payload)),
        });
        expect(resp.status).toBe(200);
      }

      expect(received.map((r) => r.params.text)).toEqual([
        "[file: spec.pdf]",
        "[video]",
        "stringified rich item",
      ]);

      // Trigger drop -> first reconnect fails (503) -> second reconnect succeeds (tk-ok-2)
      sockets[0]!.simulateServerClose(1006, "network blip");
      await vi.waitFor(() => {
        expect(sockets).toHaveLength(2);
      });
      expect(sockets[1]!.url).toContain("ticket=tk-ok-2");

      await recoveryConn.stop();
    });

    it("covers formatInbound variants, string timestamps, plain-text replies, in-flight drain, and outbound-only stop()", async () => {
      const outboundOnly = createDingTalkConnector({ inboundMode: "none" });
      await expect(outboundOnly.stop()).resolves.toBeUndefined();

      let resolveSlowReceive: (() => void) | undefined;
      const slowReceiveGate = new Promise<void>((resolve) => {
        resolveSlowReceive = resolve;
      });

      const sockets: MockWebSocket[] = [];
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ endpoint: "wss://wss-open-connection.dingtalk.com", ticket: "tk-drain" }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ endpoint: "wss://wss-open-connection.dingtalk.com", ticket: "tk-never" }),
        );

      const rx = new DingTalkReceiver({
        connectorName: "dingtalk",
        clientId: "cli",
        clientSecret: "sec",
        outgoingToken: "tok-v",
        localIp: "10.0.0.8",
        streamSubscriptions: [{ type: "EVENT", topic: "*" }],
        reconnectInitialDelayMs: 5_000,
        fetchFn,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          sockets.push(ws);
          queueMicrotask(() => ws.simulateOpen());
          return ws;
        },
      });

      const idGen = createDefaultContextIdGenerator();
      const received: DingTalkInboundMessage[] = [];
      rx.init({
        contextIdGenerator: idGen,
        allocateContextId: () => idGen.generate("dingtalk"),
        onReceive: async (_ctx, params) => {
          received.push(params);
          if (params.msgId === "m-slow") {
            await slowReceiveGate;
          }
          return { sessionId: "s-99" };
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      // formatInbound group + P2P without senderNick
      const groupPrompt = rx.formatInbound(
        {
          msgId: "m1",
          msgtype: "text",
          text: "Deploy ready",
          conversationId: "cid-g",
          conversationType: "2",
          conversationTitle: "Release Room",
          senderId: "u1",
          senderStaffId: "staff-1",
        },
        createConnectorContext("dingtalk", "group:cid-g"),
      );
      expect(groupPrompt).toEqual({
        title: "[DingTalk] Release Room",
        text: "[Release Room] staff-1: Deploy ready",
      });

      const anonPrompt = rx.formatInbound(
        {
          msgId: "m2",
          msgtype: "text",
          text: "Ping",
          conversationId: "cid-p",
          conversationType: "1",
          senderId: "u-anon",
        },
        createConnectorContext("dingtalk", "p2p-id:u-anon"),
      );
      expect(anonPrompt).toEqual({
        title: "[DingTalk] u-anon",
        text: "Ping",
      });

      // Plain string quoted reply + string epoch timestamp + unknown msgtype + malformed content JSON + non-array richText
      for (const payload of [
        {
          msgId: "m-plain-q",
          msgtype: "custom_unknown",
          text: {
            content: "Follow up",
            isReplyMsg: true,
            repliedMsg: { content: "Plain quoted line" },
          },
          createAt: "1700000009000",
          conversationId: "cid-p",
          conversationType: "1",
          senderId: "u1",
        },
        {
          msgId: "m-bad-content",
          msgtype: "richText",
          content: "{broken-json",
          conversationId: "cid-p",
          conversationType: "1",
          senderId: "u1",
        },
      ]) {
        const res = await rx.handleWebhook({
          method: "POST",
          pathname: "/webhooks/dingtalk",
          subPath: "",
          query: new URLSearchParams(),
          headers: { token: "tok-v" },
          rawBody: new TextEncoder().encode(JSON.stringify(payload)),
        });
        expect(res.status).toBe(200);
      }
      expect(received[0]?.quotedText).toBe("Plain quoted line");
      expect(received[0]?.createAt).toBe(1_700_000_009_000);

      // Start stream -> dispatch slow callback + trigger pending reconnect timer -> stopStream drains both cleanly
      await rx.startStream();
      await rx.startStream(); // idempotent when already running
      sockets[0]!.simulateServerMessage({
        type: "CALLBACK",
        headers: { topic: "/v1.0/im/bot/messages/get", messageId: "cb-slow" },
        data: JSON.stringify({
          msgId: "m-slow",
          msgtype: "text",
          text: { content: "In flight" },
          conversationId: "cid-p",
          conversationType: "1",
          senderId: "u1",
        }),
      });
      sockets[0]!.simulateServerClose(1006, "drop-with-long-timer");

      const stopPromise = rx.stopStream();
      resolveSlowReceive?.();
      await stopPromise;
      expect(received.some((m) => m.msgId === "m-slow")).toBe(true);
    });

    it("covers defaultCreateWebSocket, richText/media/quote edge branches, and frame fallbacks", async () => {
      const createdWs: MockWebSocket[] = [];
      class GlobalStubWebSocket extends MockWebSocket {
        constructor(url: string) {
          super(url);
          createdWs.push(this);
          queueMicrotask(() => this.simulateOpen());
        }
      }
      vi.stubGlobal("WebSocket", GlobalStubWebSocket);

      try {
        const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
          jsonResponse({
            endpoint: "wss://wss-open-connection.dingtalk.com",
            ticket: "tk-global",
          }),
        );

        const rx = new DingTalkReceiver({
          connectorName: "dingtalk",
          clientId: "cli",
          clientSecret: "sec",
          outgoingToken: "tok-edge",
          streamSubscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }],
          fetchFn,
        });

        const idGen = createDefaultContextIdGenerator();
        const received: DingTalkInboundMessage[] = [];
        rx.init({
          contextIdGenerator: idGen,
          allocateContextId: () => idGen.generate("dingtalk"),
          onReceive: async (_ctx, params) => {
            received.push(params);
            return { sessionId: "s-edge" };
          },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        });

        await rx.startStream();
        expect(createdWs).toHaveLength(1);

        // Non-string/non-Uint8Array data + SYSTEM ping with broken JSON + CALLBACK without messageId/non-object data + EVENT without messageId
        createdWs[0]!.emit("message", { data: undefined });
        createdWs[0]!.simulateServerMessage({
          type: "SYSTEM",
          headers: { topic: "ping", messageId: "p-empty" },
          data: "{bad-ping-json",
        });
        createdWs[0]!.simulateServerMessage({
          type: "CALLBACK",
          headers: { topic: "other/topic" },
        });
        createdWs[0]!.simulateServerMessage({
          type: "CALLBACK",
          headers: { topic: "/v1.0/im/bot/messages/get", messageId: "cb-arr" },
          data: "[]",
        });
        createdWs[0]!.simulateServerMessage({
          type: "EVENT",
          headers: { topic: "evt" },
        });

        await rx.stopStream();

        // Webhook payloads exercising richText/audio/picture/file/quote/msgId edge cases
        const edgePayloads = [
          {
            // omitted msgtype -> defaults to "text", omitted text -> ignored
            conversationId: "cid-1",
            senderId: "u1",
          },
          {
            // audio without recognition -> ignored
            msgtype: "audio",
            content: {},
            conversationId: "cid-1",
            senderId: "u1",
          },
          {
            // picture without downloadCode -> ignored
            msgtype: "picture",
            content: {},
            conversationId: "cid-1",
            senderId: "u1",
          },
          {
            // richText with non-record item, empty nested text, and pictureDownloadCode + file without fileName
            msgtype: "richText",
            content: {
              richText: [null, { text: { content: "   " } }, { pictureDownloadCode: "pdl-1" }],
            },
            conversationId: "cid-1",
            senderId: "u1",
            createAt: "0",
            text: {
              isReplyMsg: true,
              repliedMsg: { content: JSON.stringify({ content: "json-content-quote" }) },
            },
          },
          {
            // file without fileName + broken JSON quote starting with '{'
            msgtype: "file",
            content: "[]",
            conversationId: "cid-1",
            senderId: "u1",
            text: {
              isReplyMsg: true,
              repliedMsg: { content: "{broken-quote" },
            },
          },
          {
            // empty string quote + marker-only quote + object quote with content key + non-object quote
            text: {
              content: "Marker only quote",
              isReplyMsg: true,
              repliedMsg: {
                content: prependContextMarker(
                  "",
                  createConnectorContext("dingtalk", "ctx-only").contextId,
                ),
              },
            },
            conversationId: "cid-1",
            senderId: "u1",
          },
          {
            text: {
              content: "Empty string quote",
              isReplyMsg: true,
              repliedMsg: { content: "   " },
            },
            conversationId: "cid-1",
            senderId: "u1",
          },
          {
            text: {
              content: "Object content quote",
              isReplyMsg: true,
              repliedMsg: { content: { content: "from-obj-content" } },
            },
            conversationId: "cid-1",
            senderId: "u1",
          },
          {
            text: {
              content: "Scalar quote",
              isReplyMsg: true,
              repliedMsg: { content: 42 as unknown as string },
            },
            conversationId: "cid-1",
            senderId: "u1",
          },
        ];

        for (const payload of edgePayloads) {
          const res = await rx.handleWebhook({
            method: "POST",
            pathname: "/webhooks/dingtalk",
            subPath: "",
            query: new URLSearchParams(),
            headers: { token: "tok-edge" },
            rawBody: new TextEncoder().encode(JSON.stringify(payload)),
          });
          expect(res.status).toBe(200);
        }

        expect(received.map((m) => m.text)).toEqual([
          "[picture]",
          "[file]",
          "Marker only quote",
          "Empty string quote",
          "Object content quote",
          "Scalar quote",
        ]);
        expect(received[0]?.quotedText).toBe("json-content-quote");
        expect(received[1]?.quotedText).toBe("{broken-quote");
        expect(received[2]?.quotedText).toBeUndefined();
        expect(received[4]?.quotedText).toBe("from-obj-content");
        expect(received[5]?.quotedText).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }

      // Gateway 401/500 without detail + WS close without code + non-Error send/ingest throws
      const gwFailFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(
          jsonResponse({ endpoint: "wss://wss-open-connection.dingtalk.com", ticket: "tk-nc" }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ endpoint: "wss://wss-open-connection.dingtalk.com", ticket: "tk-str" }),
        );

      let wsAttempt = 0;
      let strSocket: MockWebSocket | undefined;
      const rxBranches = new DingTalkReceiver({
        connectorName: "dingtalk",
        clientId: "cli",
        clientSecret: "sec",
        fetchFn: gwFailFetch,
        createWebSocket: (url) => {
          wsAttempt += 1;
          const ws = new MockWebSocket(url);
          if (wsAttempt === 1) {
            queueMicrotask(() => ws.emit("close", {})); // event.code === undefined
          } else {
            strSocket = ws;
            ws.send = () => {
              throw "non-error-ws-send";
            };
            queueMicrotask(() => ws.simulateOpen());
          }
          return ws;
        },
      });
      const idGen2 = createDefaultContextIdGenerator();
      rxBranches.init({
        contextIdGenerator: idGen2,
        allocateContextId: () => idGen2.generate("dingtalk"),
        onReceive: async () => {
          throw "non-error-on-receive";
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      await expect(rxBranches.startStream()).rejects.toBeInstanceOf(ConnectorAuthError);
      await expect(rxBranches.startStream()).rejects.toBeInstanceOf(ConnectorTransportError);
      await expect(rxBranches.startStream()).rejects.toBeInstanceOf(ConnectorTransportError);

      await rxBranches.startStream();
      strSocket!.simulateServerMessage({
        type: "CALLBACK",
        headers: { topic: "/v1.0/im/bot/messages/get", messageId: "cb-s" },
        data: JSON.stringify({
          text: { content: "hi" },
          conversationId: "cid-1",
          senderId: "u1",
        }),
      });
      await rxBranches.stopStream();
    });
  });
});
