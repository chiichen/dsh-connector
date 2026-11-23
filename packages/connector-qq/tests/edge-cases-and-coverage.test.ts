import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  prependContextMarker,
} from "@dsh-connector/core";
import {
  createQqConnector,
  deriveQqEd25519KeyPair,
  formatQqContextId,
  parseQqContextId,
  QqAccessTokenManager,
  QqEventReceiver,
  QqGatewayClient,
  QqMessageSender,
  QqPassiveReplyTracker,
  QQ_C2C_PASSIVE_MAX_REPLIES,
  QQ_C2C_PASSIVE_TTL_MS,
  QQ_EVENT_AT_MESSAGE_CREATE,
  QQ_EVENT_C2C_MESSAGE_CREATE,
  QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
  QQ_OPCODE_CALLBACK_VALIDATION,
  QQ_OPCODE_DISPATCH,
  QQ_OPCODE_HEARTBEAT,
  QQ_OPCODE_HELLO,
  QQ_OPCODE_INVALID_SESSION,
  QQ_SANDBOX_API_BASE_URL,
  QQ_WS_CLOSE_AUTH_FAILED,
  QQ_WS_CLOSE_BOT_BANNED,
  QQ_WS_CLOSE_INVALID_SEQ,
  QQ_WS_CLOSE_SESSION_EXPIRED,
  signQqWebhookBodyForTest,
  verifyQqWebhookSignature,
  type QqInboundMessage,
  type QqWebSocketLike,
} from "../src/index";

class TestSocket implements QqWebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = 1;
  throwOnClose = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = ""): void {
    if (this.throwOnClose) {
      throw new Error("socket close boom");
    }
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe("Stage 4: Comprehensive edge-case and error-handling coverage", () => {
  it("covers addressing validation edge cases and scene-specific missing target errors", async () => {
    expect(() => formatQqContextId({ scene: "group", groupOpenId: " " })).toThrow(
      ConnectorValidationError,
    );
    expect(() => formatQqContextId({ scene: "channel", channelId: "" })).toThrow(
      ConnectorValidationError,
    );

    const c2cCtx = createConnectorContext("qq", "c2c:U1");
    const connector = createQqConnector({
      appId: "100",
      clientSecret: "sec",
      sandbox: true,
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });

    // Context scene conflict
    await expect(
      connector.getSender().send(c2cCtx, { text: "hi", scene: "channel" }),
    ).rejects.toBeInstanceOf(ConnectorValidationError);

    // Scene-specific missing target field names on UUID context
    const uuidCtx = createConnectorContext("qq", "550e8400-e29b-41d4-a716-446655440000");
    await expect(
      connector.getSender().send(uuidCtx, { text: "hi", scene: "c2c" }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorTargetRequiredError && err.targetField === "openId",
    );
    await expect(
      connector.getSender().send(uuidCtx, { text: "hi", scene: "group" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ConnectorTargetRequiredError && err.targetField === "groupOpenId",
    );
    await expect(
      connector.getSender().send(uuidCtx, { text: "hi", scene: "channel" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ConnectorTargetRequiredError && err.targetField === "channelId",
    );
  });

  it("covers QqAccessTokenManager validation, abort, invalid JSON, HTTP errors, and missing token cases", async () => {
    expect(() => new QqAccessTokenManager({ appId: " ", clientSecret: "sec" })).toThrow(
      ConnectorValidationError,
    );
    expect(() => new QqAccessTokenManager({ appId: "app", clientSecret: " " })).toThrow(
      ConnectorValidationError,
    );

    // Caller AbortSignal aborted during fetch
    const abortCtrl = new AbortController();
    const abortManager = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () => {
        abortCtrl.abort(new Error("caller cancelled"));
        throw new Error("network aborted");
      }) as typeof fetch,
    });
    await expect(abortManager.getAccessToken(abortCtrl.signal)).rejects.toThrow("caller cancelled");

    // Network failure
    const netFail = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(netFail.getAccessToken()).rejects.toBeInstanceOf(ConnectorTransportError);

    // Invalid JSON on 502
    const badJson = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () => new Response("not-json", { status: 502 })) as typeof fetch,
    });
    await expect(badJson.getAccessToken()).rejects.toSatisfy(
      (e: unknown) => e instanceof ConnectorTransportError && e.retryable === true,
    );

    // HTTP 403
    const http403 = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () => new Response("{}", { status: 403 })) as typeof fetch,
    });
    await expect(http403.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);

    // HTTP 500 without bizCode
    const http500 = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    });
    await expect(http500.getAccessToken()).rejects.toSatisfy(
      (e: unknown) => e instanceof ConnectorTransportError && e.retryable === true,
    );

    // Missing access_token & unparseable expires_in fallback
    const emptyToken = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () =>
        new Response(JSON.stringify({ access_token: "  " }), { status: 200 })) as typeof fetch,
    });
    await expect(emptyToken.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);

    const fallbackTtl = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () =>
        new Response(JSON.stringify({ access_token: "ok-tok", expires_in: "invalid" }), {
          status: 200,
        })) as typeof fetch,
    });
    expect(await fallbackTtl.getAccessToken()).toBe("ok-tok");
  });

  it("covers QqPassiveReplyTracker TTL expiry, quota exhaustion, capacity eviction, and QqMessageSender error branches", async () => {
    const tracker = new QqPassiveReplyTracker();
    tracker.recordInbound({ scene: "c2c", openId: "U1" }, "   ", 0);
    expect(tracker.consumeAutoPassiveMsgId({ scene: "c2c", openId: "U1" }, 0)).toBeUndefined();

    // Quota exhaustion (max 4 in C2C)
    tracker.recordInbound({ scene: "c2c", openId: "U1" }, "M_QUOTA", 100);
    for (let i = 0; i < QQ_C2C_PASSIVE_MAX_REPLIES; i += 1) {
      expect(tracker.consumeAutoPassiveMsgId({ scene: "c2c", openId: "U1" }, 200)).toBe("M_QUOTA");
    }
    expect(tracker.consumeAutoPassiveMsgId({ scene: "c2c", openId: "U1" }, 200)).toBeUndefined();

    // TTL expiry
    tracker.recordInbound({ scene: "c2c", openId: "U2" }, "M_TTL", 100);
    expect(
      tracker.consumeAutoPassiveMsgId({ scene: "c2c", openId: "U2" }, 100 + QQ_C2C_PASSIVE_TTL_MS),
    ).toBeUndefined();

    // Capacity eviction (>1024 targets and >2048 msgSeqs)
    for (let i = 0; i < 1_030; i += 1) {
      tracker.recordInbound({ scene: "group", groupOpenId: `G_${i}` }, `MSG_${i}`, 1_000);
    }
    for (let i = 0; i < 2_055; i += 1) {
      tracker.nextMsgSeq(`SEQ_${i}`);
    }

    const tokenManager = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () =>
        new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
          status: 200,
        })) as typeof fetch,
    });

    // Mutually exclusive replyToMessageId and eventId
    const sender1 = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    expect(sender1.getPassiveTracker()).toBeInstanceOf(QqPassiveReplyTracker);
    await expect(
      sender1.send(createConnectorContext("qq", "c2c:U1"), {
        text: "x",
        replyToMessageId: "M1",
        eventId: "E1",
      }),
    ).rejects.toBeInstanceOf(ConnectorValidationError);

    // eventId branch on C2C and Channel (markdown)
    const capturedUrls: string[] = [];
    const capturedPayloads: Array<Record<string, unknown>> = [];
    const sandboxConnector = createQqConnector({
      appId: "app",
      clientSecret: "sec",
      sandbox: true,
      transport: "both",
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/app/getAppAccessToken")) {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
            status: 200,
          });
        }
        capturedUrls.push(url);
        capturedPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("", { status: 200 });
      }) as typeof fetch,
    });

    const eventRes = await sandboxConnector
      .getSender()
      .send(createConnectorContext("qq", "c2c:U_EVT"), {
        text: "welcome",
        eventId: "EVT_FRIEND_ADD",
        msgSeq: 3,
      });
    expect(capturedUrls[0]).toBe(`${QQ_SANDBOX_API_BASE_URL}/v2/users/U_EVT/messages`);
    expect(capturedPayloads[0]).toEqual({
      msg_type: 0,
      content: "welcome",
      event_id: "EVT_FRIEND_ADD",
      msg_seq: 3,
    });
    expect(eventRes.messageId).toBe("unknown");

    await sandboxConnector.getSender().send(createConnectorContext("qq", "channel:CH_MD"), {
      text: "**md**",
      format: "markdown",
      eventId: "EVT_CH",
    });
    expect(capturedPayloads[1]).toEqual({
      markdown: { content: "**md**" },
      event_id: "EVT_CH",
    });

    // Sender network error, caller abort, invalid JSON, 403 auth error, 500 transport error
    const abortCtrl = new AbortController();
    const senderAbort = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      fetchFn: (async () => {
        abortCtrl.abort(new Error("send aborted"));
        throw new Error("net");
      }) as typeof fetch,
    });
    await expect(
      senderAbort.send(
        createConnectorContext("qq", "c2c:U1"),
        { text: "x" },
        { signal: abortCtrl.signal },
      ),
    ).rejects.toThrow("send aborted");

    const senderNetErr = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      fetchFn: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    });
    await expect(
      senderNetErr.send(createConnectorContext("qq", "c2c:U1"), { text: "x" }),
    ).rejects.toBeInstanceOf(ConnectorTransportError);

    const senderBadJson = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      fetchFn: (async () => new Response("<<<", { status: 502 })) as typeof fetch,
    });
    await expect(
      senderBadJson.send(createConnectorContext("qq", "c2c:U1"), { text: "x" }),
    ).rejects.toBeInstanceOf(ConnectorTransportError);

    const sender403 = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      fetchFn: (async () =>
        new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })) as typeof fetch,
    });
    await expect(
      sender403.send(createConnectorContext("qq", "c2c:U1"), { text: "x" }),
    ).rejects.toBeInstanceOf(ConnectorAuthError);

    const senderBizErr = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      fetchFn: (async () =>
        new Response(JSON.stringify({ code: 40054005, message: "dedup" }), {
          status: 400,
        })) as typeof fetch,
    });
    await expect(
      senderBizErr.send(createConnectorContext("qq", "c2c:U1"), { text: "x" }),
    ).rejects.toBeInstanceOf(ConnectorTransportError);

    const senderHttp500 = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      fetchFn: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    });
    await expect(
      senderHttp500.send(createConnectorContext("qq", "c2c:U1"), { text: "x" }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConnectorTransportError && e.retryable);
  });

  it("covers Ed25519 signature validation edge cases and Webhook error / formatting branches", async () => {
    expect(() => deriveQqEd25519KeyPair("")).toThrow(ConnectorValidationError);
    expect(verifyQqWebhookSignature("sec", "", new Uint8Array(), "aa")).toBe(false);
    // High bits set on byte 63 (0xff & 0xe0 !== 0)
    const nonCanonicalSig = `${"00".repeat(63)}ff`;
    expect(
      verifyQqWebhookSignature("sec", "1700000000", new Uint8Array([1, 2]), nonCanonicalSig),
    ).toBe(false);

    const mockSecret = "mock-qq-bot-secret";
    const connector = createQqConnector({
      appId: "11111111",
      clientSecret: mockSecret,
    });
    const receiver = connector.getReceiver();

    // Uninitialized dispatch returns false gracefully
    const rawNonPost = await receiver.handleWebhook!({
      method: "GET",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new Uint8Array(),
    });
    expect(rawNonPost.status).toBe(405);

    // Mismatched X-Bot-Appid (including string[] header value)
    const wrongAppRes = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: { "X-Bot-Appid": ["99999999"] },
      rawBody: new TextEncoder().encode("{}"),
    });
    expect(wrongAppRes.status).toBe(401);

    // Malformed JSON & non-object JSON
    const badJsonRes = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new TextEncoder().encode("{bad"),
    });
    expect(badJsonRes.status).toBe(400);

    const arrJsonRes = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new TextEncoder().encode("[1,2,3]"),
    });
    expect(arrJsonRes.status).toBe(400);

    // OpCode 13 with invalid signature header -> 401; missing plain_token -> 400
    const op13BadSig = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: { "x-signature-ed25519": "bad" },
      rawBody: new TextEncoder().encode(
        JSON.stringify({
          op: QQ_OPCODE_CALLBACK_VALIDATION,
          d: { plain_token: "a", event_ts: "1" },
        }),
      ),
    });
    expect(op13BadSig.status).toBe(401);

    const op13MissingFields = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new TextEncoder().encode(
        JSON.stringify({ op: QQ_OPCODE_CALLBACK_VALIDATION, d: {} }),
      ),
    });
    expect(op13MissingFields.status).toBe(400);

    // Initialize receiver and test nested msg_elements, attachments, mentions is_you, formatInbound, and ignored/incomplete events
    const received: QqInboundMessage[] = [];
    receiver.init?.({
      allocateContextId: () => createDefaultContextIdGenerator().generate("qq"),
      contextIdGenerator: createDefaultContextIdGenerator(),
      onReceive: async (_ctx, params) => {
        received.push(params as QqInboundMessage);
        return { sessionId: "s1" };
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });

    const ts = "1725442500";
    const sendSignedWebhook = async (payload: unknown) => {
      const rawBody = new TextEncoder().encode(JSON.stringify(payload));
      return receiver.handleWebhook!({
        method: "POST",
        pathname: "/webhooks/connectors/qq",
        subPath: "",
        query: new URLSearchParams(),
        headers: {
          "x-signature-timestamp": ts,
          "x-signature-ed25519": signQqWebhookBodyForTest(mockSecret, ts, rawBody),
        },
        rawBody,
      });
    };

    // Unsupported event & malformed event payloads
    await sendSignedWebhook({ op: QQ_OPCODE_DISPATCH, t: "FRIEND_ADD", d: {} });
    await sendSignedWebhook({ op: QQ_OPCODE_DISPATCH, t: QQ_EVENT_C2C_MESSAGE_CREATE, d: "bad" });
    await sendSignedWebhook({ op: QQ_OPCODE_DISPATCH, t: QQ_EVENT_C2C_MESSAGE_CREATE, d: {} });
    await sendSignedWebhook({
      op: QQ_OPCODE_DISPATCH,
      t: QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
      d: { id: "M1", author: { id: "U1" } },
    });
    await sendSignedWebhook({
      op: QQ_OPCODE_DISPATCH,
      t: QQ_EVENT_AT_MESSAGE_CREATE,
      d: { id: "M1", author: { id: "U1" } },
    });
    expect(received).toHaveLength(0);

    // Rich group message with nested msg_elements, attachments, is_you mention, non-bot mention, and malformed ext entries
    await sendSignedWebhook({
      op: QQ_OPCODE_DISPATCH,
      t: QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
      d: {
        id: "M_RICH",
        group_openid: "G_RICH",
        author: { id: "U_RICH", member_nickname: "Nick" },
        mentions: [
          { id: "BOT_DYN_ID", member_openid: "BOT_MEM_ID", is_you: true },
          { id: "OTHER_USER", is_you: false },
        ],
        content: "<@!BOT_DYN_ID> <@!OTHER_USER> check image",
        message_scene: { ext: [123, "noequals", "=emptykey", "msg_idx=IDX_1"] },
        msg_elements: [
          null,
          {
            message_type: 101,
            msg_elements: [{ message_type: 103, content: "nested quote line" }],
          },
        ],
        attachments: [
          null,
          {
            url: "https://multimedia.nt.qq.com.cn/img.png",
            filename: "img.png",
            content_type: "image/png",
            size: 1024,
            width: 800,
            height: 600,
          },
        ],
      },
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("<@!OTHER_USER> check image");
    expect(received[0]!.quotedContent).toBe("nested quote line");
    expect(received[0]!.attachments).toHaveLength(1);

    const formattedGroup = receiver.formatInbound!(
      received[0]!,
      createConnectorContext("qq", "group:G_RICH"),
    );
    expect(formattedGroup).toEqual({
      title: "QQ Group G_RICH",
      text: "[QQ group @Nick]\n> nested quote line\n\n<@!OTHER_USER> check image",
    });

    // Channel without guild_id + formatInbound for C2C & Channel
    await sendSignedWebhook({
      op: QQ_OPCODE_DISPATCH,
      t: QQ_EVENT_AT_MESSAGE_CREATE,
      d: {
        id: "M_CH_ONLY",
        channel_id: "CH_ONLY_1",
        author: { id: "U_CH" },
        content: prependContextMarker("hello channel", "ctx-from-body", "html-comment"),
      },
    });
    expect(received).toHaveLength(2);
    expect(
      receiver.formatInbound!(received[1]!, createConnectorContext("qq", "channel:CH_ONLY_1")),
    ).toEqual({
      title: "QQ Channel CH_ONLY_1",
      text: "[QQ channel @U_CH]\nhello channel",
    });
    expect(
      receiver.formatInbound!(
        {
          eventType: QQ_EVENT_C2C_MESSAGE_CREATE,
          scene: "c2c",
          messageId: "M1",
          text: "hi",
          quotedContent: "line1\nline2",
          senderId: "U1",
        },
        createConnectorContext("qq", "c2c:U1"),
      ),
    ).toEqual({
      title: "QQ C2C U1",
      text: "> line1\n> line2\n\nhi",
    });
  });

  it("covers WebSocket Gateway error/close branches, zombie heartbeat timeout, binary frames, and maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    try {
      const tokenManager = new QqAccessTokenManager({
        appId: "app",
        clientSecret: "sec",
        fetchFn: (async () =>
          new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
            status: 200,
          })) as typeof fetch,
      });

      const warnLogs: string[] = [];
      const errorLogs: string[] = [];
      const sink = {
        registerBotUserId: () => {},
        dispatchEnvelope: async () => {
          throw new Error("handler boom");
        },
        getLogger: () => ({
          debug: () => {},
          info: () => {},
          warn: (msg: string) => warnLogs.push(msg),
          error: (msg: string) => errorLogs.push(msg),
        }),
      };

      // 1. Gateway discovery failure cases (network, 401, 500, empty url)
      const gwNetFail = new QqGatewayClient({
        connectorName: "qq",
        tokenManager,
        receiver: sink,
        fetchFn: (async () => {
          throw new Error("net");
        }) as typeof fetch,
      });
      await expect(gwNetFail.start()).rejects.toBeInstanceOf(ConnectorTransportError);

      const gw401 = new QqGatewayClient({
        connectorName: "qq",
        tokenManager,
        receiver: sink,
        fetchFn: (async () => new Response("{}", { status: 401 })) as typeof fetch,
      });
      await expect(gw401.start()).rejects.toBeInstanceOf(ConnectorAuthError);

      const gw500 = new QqGatewayClient({
        connectorName: "qq",
        tokenManager,
        receiver: sink,
        fetchFn: (async () => new Response("{}", { status: 500 })) as typeof fetch,
      });
      await expect(gw500.start()).rejects.toBeInstanceOf(ConnectorTransportError);

      const gwEmptyUrl = new QqGatewayClient({
        connectorName: "qq",
        tokenManager,
        receiver: sink,
        fetchFn: (async () =>
          new Response(JSON.stringify({ url: "" }), { status: 200 })) as typeof fetch,
      });
      await expect(gwEmptyUrl.start()).rejects.toBeInstanceOf(ConnectorTransportError);

      // 2. Fatal close codes during initial start (4004 auth & 4915 banned) + premature close before READY
      const makeInitialCloseClient = (closeCode: number) =>
        new QqGatewayClient({
          connectorName: "qq",
          tokenManager,
          receiver: sink,
          gatewayUrl: "wss://mock.qq.com/ws",
          createWebSocket: () => {
            const ws = new TestSocket();
            queueMicrotask(() => ws.close(closeCode, "closed"));
            return ws;
          },
        });

      await expect(makeInitialCloseClient(QQ_WS_CLOSE_AUTH_FAILED).start()).rejects.toBeInstanceOf(
        ConnectorAuthError,
      );
      await expect(makeInitialCloseClient(QQ_WS_CLOSE_BOT_BANNED).start()).rejects.toBeInstanceOf(
        ConnectorTransportError,
      );
      await expect(makeInitialCloseClient(1006).start()).rejects.toBeInstanceOf(
        ConnectorTransportError,
      );

      // 3. Full runtime edge cases: binary frames (Uint8Array & ArrayBuffer), server op=1 heartbeat request,
      // zombie heartbeat timeout (missing ACK), resumable op=9 (d=true), close 4007, reconnect failure retry, maxReconnectAttempts exhaustion
      const sockets: TestSocket[] = [];
      let failNextConnect = false;
      const gw = new QqGatewayClient({
        connectorName: "qq",
        tokenManager,
        receiver: sink,
        gatewayUrl: "wss://mock.qq.com/ws",
        reconnectDelaysMs: [20],
        maxReconnectAttempts: 2,
        createWebSocket: () => {
          if (failNextConnect) {
            failNextConnect = false;
            throw new Error("ws dial failed");
          }
          const ws = new TestSocket();
          sockets.push(ws);
          return ws;
        },
      });

      const p1 = gw.start();
      const p2 = gw.start(); // Idempotent in-flight startPromise reuse
      await vi.advanceTimersByTimeAsync(0);
      const ws1 = sockets[0]!;

      // Non-string/ignored frames, binary Uint8Array Hello (default heartbeat interval when omitted), ArrayBuffer READY
      ws1.onmessage?.({ data: 12345 });
      ws1.onmessage?.({ data: "not-json" });
      ws1.onmessage?.({ data: "[1]" });
      ws1.onmessage?.({
        data: new TextEncoder().encode(JSON.stringify({ op: QQ_OPCODE_HELLO, d: {} })),
      });
      ws1.onmessage?.({
        data: new TextEncoder().encode(
          JSON.stringify({
            op: QQ_OPCODE_DISPATCH,
            s: 10,
            t: "READY",
            d: { session_id: "S_BIN", user: { id: "B_1" } },
          }),
        ).buffer,
      });
      await Promise.all([p1, p2]);
      await gw.start(); // Idempotent already-running check

      // Server sends op=1 Heartbeat -> immediate op=1 reply; unknown op=999; dispatch rejection logged
      ws1.onerror?.(new Error("minor glitch"));
      ws1.onmessage?.({ data: JSON.stringify({ op: QQ_OPCODE_HEARTBEAT }) });
      ws1.onmessage?.({ data: JSON.stringify({ op: 999 }) });
      ws1.onmessage?.({
        data: JSON.stringify({
          op: QQ_OPCODE_DISPATCH,
          s: 11,
          t: QQ_EVENT_C2C_MESSAGE_CREATE,
          d: {},
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(ws1.sent.some((f) => f["op"] === QQ_OPCODE_HEARTBEAT)).toBe(true);

      // Advance 2x 45_000ms without Heartbeat ACK -> zombie close triggers reconnect!
      // First reconnect fails (`failNextConnect = true`), second reconnect succeeds (`maxReconnectAttempts: 2`)
      failNextConnect = true;
      await vi.advanceTimersByTimeAsync(45_000); // sends heartbeat, awaitingHeartbeatAck = true
      await vi.advanceTimersByTimeAsync(45_000); // zombie close -> schedules attempt 1 (fails)
      await vi.advanceTimersByTimeAsync(25); // attempt 1 throws -> schedules attempt 2
      await vi.advanceTimersByTimeAsync(25); // attempt 2 connects ws2!
      expect(sockets).toHaveLength(2);

      const ws2 = sockets[1]!;
      // Resumable Invalid Session (d: true) -> closes with 4009, then hits maxReconnectAttempts (2) and stops!
      ws2.onmessage?.({ data: JSON.stringify({ op: QQ_OPCODE_INVALID_SESSION, d: true }) });
      expect(errorLogs.some((m) => m.includes("max reconnect attempts exhausted"))).toBe(true);
      expect(warnLogs.length).toBeGreaterThan(0);

      // Close with 4007 invalid seq + stop() tolerating ws.close throwing
      const sockets2: TestSocket[] = [];
      const gw2 = new QqGatewayClient({
        connectorName: "qq",
        tokenManager,
        receiver: sink,
        gatewayUrl: "wss://mock.qq.com/ws",
        reconnectDelaysMs: [20],
        createWebSocket: () => {
          const ws = new TestSocket();
          sockets2.push(ws);
          return ws;
        },
      });
      const start2 = gw2.start();
      await vi.advanceTimersByTimeAsync(0);
      sockets2[0]!.onmessage?.({
        data: JSON.stringify({ op: QQ_OPCODE_HELLO, d: { heartbeat_interval: 500 } }),
      });
      sockets2[0]!.onmessage?.({
        data: JSON.stringify({
          op: QQ_OPCODE_DISPATCH,
          s: 1,
          t: "READY",
          d: { session_id: "S2" },
        }),
      });
      await start2;
      sockets2[0]!.close(QQ_WS_CLOSE_INVALID_SEQ, "bad seq");
      sockets2[0]!.close(QQ_WS_CLOSE_SESSION_EXPIRED, "expired");
      await vi.advanceTimersByTimeAsync(25);
      sockets2[1]!.throwOnClose = true;
      await gw2.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers all optional QqConnector options, receiver pre-init / sparse attachment branches, auth/sender message-less errors, and gateway stop-during-flight / default WebSocket factory", async () => {
    // 1. parseQqContextId whitespace channel branch ("channel:   ")
    expect(parseQqContextId("channel:   ")).toBeUndefined();

    // 2. QqConnector with all optional pass-through fields + transport="both" + webhook-only start/stop
    const fullConnector = createQqConnector({
      name: "qq-full",
      displayName: "QQ Full",
      description: "Full options test",
      appId: "10001",
      clientSecret: "mock-qq-bot-secret",
      botUserId: "BOT_1",
      apiBaseUrl: "https://api.sgroup.qq.com/",
      tokenUrl: "https://bots.qq.com/app/getAppAccessToken",
      gatewayUrl: "wss://api.sgroup.qq.com/websocket",
      transport: "both",
      intents: 1 << 25,
      shard: [0, 1],
      defaultFormat: "markdown",
      includeContextMarker: true,
      autoPassiveReply: false,
      fallbackToPlainOnMarkdownReject: false,
      requestTimeoutMs: 5_000,
      tokenRefreshBufferMs: 30_000,
      reconnectDelaysMs: [10],
      maxReconnectAttempts: 1,
      now: () => 1_700_000_000_000,
      fetchFn: (async () =>
        new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
        })) as typeof fetch,
      createWebSocket: () => new TestSocket(),
    });
    expect(fullConnector.name).toBe("qq-full");
    expect(fullConnector.getReceiver().handleWebhook).toBeTypeOf("function");

    const webhookOnly = createQqConnector({
      appId: "10002",
      clientSecret: "mock-qq-bot-secret",
      transport: "webhook",
    });
    await webhookOnly.start();
    await webhookOnly.stop();

    // 3. QqEventReceiver pre-init getLogger / dispatchEnvelope, sparse attachments, and scene-less formatInbound
    const standaloneReceiver = new QqEventReceiver({
      connectorName: "qq",
      appId: "10002",
      clientSecret: "mock-qq-bot-secret",
      passiveTracker: new QqPassiveReplyTracker(),
    });
    expect(standaloneReceiver.getLogger()).toBeUndefined();
    expect(
      await standaloneReceiver.dispatchEnvelope({
        op: QQ_OPCODE_DISPATCH,
        t: QQ_EVENT_C2C_MESSAGE_CREATE,
        d: { id: "M1", author: { id: "U1" }, content: "hi" },
      }),
    ).toBe(false);
    standaloneReceiver.registerBotUserId("   ");
    standaloneReceiver.registerBotUserId("BOT_NEW");

    const captured: QqInboundMessage[] = [];
    standaloneReceiver.init({
      allocateContextId: () => createDefaultContextIdGenerator().generate("qq"),
      contextIdGenerator: createDefaultContextIdGenerator(),
      onReceive: async (_ctx, params) => {
        captured.push(params as QqInboundMessage);
        return { sessionId: "s" };
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    await standaloneReceiver.dispatchEnvelope({
      op: QQ_OPCODE_DISPATCH,
      t: QQ_EVENT_C2C_MESSAGE_CREATE,
      d: {
        id: "M_SPARSE",
        author: { id: "U_SPARSE" },
        content: 12345,
        attachments: [{}],
      },
    });
    expect(captured[0]!.attachments).toEqual([{}]);

    expect(
      standaloneReceiver.formatInbound(
        {
          eventType: QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
          scene: "group",
          messageId: "M1",
          text: "hi",
          senderId: "U1",
        },
        createConnectorContext("qq", "group:G1"),
      ).title,
    ).toBe("QQ Group");
    expect(
      standaloneReceiver.formatInbound(
        {
          eventType: QQ_EVENT_AT_MESSAGE_CREATE,
          scene: "channel",
          messageId: "M2",
          text: "hi",
          senderId: "U1",
        },
        createConnectorContext("qq", "channel:C1"),
      ).title,
    ).toBe("QQ Channel");

    // 4. QqAccessTokenManager & QqMessageSender message-less error branches & explicit msgSeq
    const authBizNoMsg = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () =>
        new Response(JSON.stringify({ code: 10004 }), { status: 200 })) as typeof fetch,
    });
    await expect(authBizNoMsg.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);

    const transportBizNoMsg = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () =>
        new Response(JSON.stringify({ code: 50099 }), { status: 200 })) as typeof fetch,
    });
    await expect(transportBizNoMsg.getAccessToken()).rejects.toSatisfy(
      (e: unknown) => e instanceof ConnectorTransportError && !e.retryable,
    );

    const nonStringToken = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () =>
        new Response(JSON.stringify({ access_token: 999, expires_in: "bad" }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(nonStringToken.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);

    const goodTokenMgr = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "sec",
      fetchFn: (async () =>
        new Response(JSON.stringify({ access_token: "ok-tok", expires_in: "bad" }), {
          status: 200,
        })) as typeof fetch,
    });
    expect(await goodTokenMgr.getAccessToken()).toBe("ok-tok");

    const tracker = new QqPassiveReplyTracker();
    expect(tracker.nextMsgSeq("M_EXP", 10)).toBe(10);

    const sender403WithMsg = new QqMessageSender({
      connectorName: "qq",
      tokenManager: goodTokenMgr,
      fetchFn: (async () =>
        new Response(JSON.stringify({ message: "forbidden bot" }), {
          status: 403,
        })) as typeof fetch,
    });
    await expect(
      sender403WithMsg.send(createConnectorContext("qq", "c2c:U1"), { text: "x" }),
    ).rejects.toThrow("forbidden bot");

    const sender200BizNoMsg = new QqMessageSender({
      connectorName: "qq",
      tokenManager: goodTokenMgr,
      fetchFn: (async () =>
        new Response(JSON.stringify({ code: 99999 }), { status: 200 })) as typeof fetch,
    });
    await expect(
      sender200BizNoMsg.send(createConnectorContext("qq", "c2c:U1"), { text: "x" }),
    ).rejects.toThrow("code=99999");

    // 5. QqGatewayClient default WebSocket factory, stop mid-discovery, stop while reconnectTimer pending, and closed-socket sendFrame
    vi.useFakeTimers();
    const originalWs = globalThis.WebSocket;
    try {
      const createdByDefault: TestSocket[] = [];
      class GlobalFakeWs extends TestSocket {
        constructor(_url: string) {
          super();
          createdByDefault.push(this);
        }
      }
      globalThis.WebSocket = GlobalFakeWs as unknown as typeof WebSocket;

      const gwDefaultWs = new QqGatewayClient({
        connectorName: "qq",
        tokenManager: goodTokenMgr,
        receiver: standaloneReceiver,
        gatewayUrl: "wss://mock.qq.com/ws",
        reconnectDelaysMs: [],
      });
      const startDef = gwDefaultWs.start();
      await vi.advanceTimersByTimeAsync(0);
      createdByDefault[0]!.onmessage?.({
        data: JSON.stringify({ op: QQ_OPCODE_HELLO, d: { heartbeat_interval: 100 } }),
      });
      createdByDefault[0]!.onmessage?.({
        data: JSON.stringify({ op: QQ_OPCODE_DISPATCH, s: 1, t: "READY", d: {} }),
      });
      await startDef;

      // Trigger disconnect so reconnectTimer is scheduled, then immediately stop() to clear reconnectTimer!
      createdByDefault[0]!.close(1006, "dropped");
      await gwDefaultWs.stop();

      // Stop mid-flight while GET /gateway is pending
      let resolveDiscovery!: (res: Response) => void;
      const gwMidStop = new QqGatewayClient({
        connectorName: "qq",
        tokenManager: goodTokenMgr,
        receiver: standaloneReceiver,
        fetchFn: (() =>
          new Promise<Response>((resolve) => {
            resolveDiscovery = resolve;
          })) as typeof fetch,
      });
      const midStart = gwMidStop.start();
      await vi.advanceTimersByTimeAsync(0);
      await gwMidStop.stop();
      resolveDiscovery(
        new Response(JSON.stringify({ url: "wss://mock.qq.com/ws" }), { status: 200 }),
      );
      await midStart;
    } finally {
      globalThis.WebSocket = originalWs;
      vi.useRealTimers();
    }
  });
});
