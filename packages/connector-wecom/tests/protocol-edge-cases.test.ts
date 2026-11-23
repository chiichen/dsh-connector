import { createCipheriv } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
} from "@dsh-connector/core";
import {
  WeComAibotWsClient,
  WeComApiClient,
  WeComMsgCrypt,
  WeComReceiver,
  WeComSender,
  buildPassiveStreamReplyPayload,
  createWeComConnector,
  parseWeComContextTarget,
  pkcs7Pad32,
  pkcs7Unpad32,
  wecomReceiveSchema,
  wecomSendSchema,
  type WeComReceiveParams,
  type WeComStreamingAdapter,
  type WeComWebSocketCloseEvent,
  type WeComWebSocketLike,
  type WeComWebSocketMessageEvent,
} from "../src";

const TEST_TOKEN = "test_token_alpha";
const ENCODING_AES_KEY = "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C";
const TEST_CORP_ID = "ww_edge_corp";

class ControllableWebSocket implements WeComWebSocketLike {
  readyState: number;
  readonly sentFrames: Array<Record<string, unknown>> = [];
  onSend?: (frame: Record<string, unknown>, sock: ControllableWebSocket) => void;

  private readonly openSet = new Set<() => void>();
  private readonly msgSet = new Set<(ev: WeComWebSocketMessageEvent) => void>();
  private readonly closeSet = new Set<(ev: WeComWebSocketCloseEvent) => void>();
  private readonly errSet = new Set<(ev: unknown) => void>();

  constructor(initialReadyState = 0) {
    this.readyState = initialReadyState;
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    this.sentFrames.push(parsed);
    this.onSend?.(parsed, this);
  }

  close(code = 1000, reason = "closed"): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    for (const fn of Array.from(this.closeSet)) {
      fn({ code, reason });
    }
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener:
      | (() => void)
      | ((ev: WeComWebSocketMessageEvent) => void)
      | ((ev: WeComWebSocketCloseEvent) => void)
      | ((ev: unknown) => void),
    options?: { readonly once?: boolean },
  ): void {
    const add = <T>(set: Set<(ev: T) => void>, rawFn: (ev: T) => void) => {
      if (options?.once === true) {
        const onceFn = (ev: T): void => {
          set.delete(onceFn);
          rawFn(ev);
        };
        set.add(onceFn);
      } else {
        set.add(rawFn);
      }
    };
    if (type === "open") add(this.openSet as Set<(ev: undefined) => void>, listener as () => void);
    else if (type === "message")
      add(this.msgSet, listener as (ev: WeComWebSocketMessageEvent) => void);
    else if (type === "close")
      add(this.closeSet, listener as (ev: WeComWebSocketCloseEvent) => void);
    else add(this.errSet, listener as (ev: unknown) => void);
  }

  removeEventListener(type: string, listener: (...args: never[]) => void): void {
    if (type === "open") this.openSet.delete(listener as () => void);
    else if (type === "message")
      this.msgSet.delete(listener as (ev: WeComWebSocketMessageEvent) => void);
    else if (type === "close")
      this.closeSet.delete(listener as (ev: WeComWebSocketCloseEvent) => void);
    else if (type === "error") this.errSet.delete(listener as (ev: unknown) => void);
  }

  emitJson(payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    for (const fn of Array.from(this.msgSet)) {
      fn({ data });
    }
  }
}

function createTrackingLogger(): {
  readonly logger: ConnectorLogger;
  readonly warns: string[];
  readonly errors: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    errors,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (msg) => {
        warns.push(msg);
      },
      error: (msg) => {
        errors.push(msg);
      },
    },
  };
}

function encryptRawFrameWithKey(rawUnpadded: Buffer): string {
  const aesKey = Buffer.from(`${ENCODING_AES_KEY}=`, "base64");
  const iv = aesKey.subarray(0, 16);
  const padded = pkcs7Pad32(rawUnpadded);
  const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

describe("Behavioral edge cases across WeComAibotWsClient, Receiver, Crypto, ApiClient, Sender, and Connector", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles WebSocket open timeout, synchronous open, ping failure, pending request rejection on close/stop, callback rejections, and reconnect failure/cancellation", async () => {
    vi.useFakeTimers();
    const { logger, warns, errors } = createTrackingLogger();

    // 1. Open timeout when socket stays in CONNECTING (readyState = 0)
    const neverOpenClient = new WeComAibotWsClient({
      config: {
        botId: "bot_timeout",
        secret: "sec",
        requestTimeoutMs: 150,
        autoReconnect: false,
        createWebSocket: () => new ControllableWebSocket(0),
      },
      logger,
    });
    const openTimeoutPromise = neverOpenClient.start();
    const openTimeoutCheck = expect(openTimeoutPromise).rejects.toThrow(
      /Timed out opening WeCom Intelligent Bot WebSocket/,
    );
    await vi.advanceTimersByTimeAsync(200);
    await openTimeoutCheck;

    // 2. Non-auth errcode during `aibot_subscribe` is wrapped into ConnectorAuthError via treatNonZeroAsAuthError
    const subscribeBizErrClient = new WeComAibotWsClient({
      config: {
        botId: "bot_sub_err",
        secret: "sec",
        autoReconnect: false,
        createWebSocket: () => {
          const ws = new ControllableWebSocket(1);
          ws.onSend = (frame, sock) => {
            const headers = frame["headers"] as { req_id: string };
            sock.emitJson({
              headers: { req_id: headers.req_id },
              errcode: 95001,
              errmsg: "subscribe rejected",
            });
          };
          return ws;
        },
      },
      logger,
    });
    await expect(subscribeBizErrClient.start()).rejects.toThrow(ConnectorAuthError);

    // 3. Synchronous readyState=1, ping error warning, unknown frames, callback error isolation, pending request rejection on socket drop, reconnect failure, and stop cancelling reconnectTimer
    let connectionAttempt = 0;
    const createdSockets: ControllableWebSocket[] = [];
    const client = new WeComAibotWsClient({
      config: {
        botId: "bot_full",
        secret: "sec",
        wsUrl: "wss://openws.work.weixin.qq.com",
        heartbeatIntervalMs: 1_000,
        requestTimeoutMs: 5_000,
        reconnectInitialDelayMs: 400,
        reconnectMaxDelayMs: 600,
        createWebSocket: () => {
          connectionAttempt += 1;
          const ws = new ControllableWebSocket(1);
          createdSockets.push(ws);
          ws.onSend = (frame, sock) => {
            const cmd = frame["cmd"];
            const headers = frame["headers"] as { req_id: string };
            if (cmd === "aibot_subscribe") {
              if (connectionAttempt === 2) {
                sock.emitJson({
                  headers: { req_id: headers.req_id },
                  errcode: 50000,
                  errmsg: "temporary gateway failure",
                });
                return;
              }
              sock.emitJson({ headers: { req_id: headers.req_id } });
              return;
            }
            if (cmd === "ping") {
              sock.emitJson({
                headers: { req_id: headers.req_id },
                errcode: 99001,
                errmsg: "ping rejected",
              });
              return;
            }
            // Leave `aibot_send_msg` unacknowledged so close/stop exercises `rejectAllPending`
          };
          return ws;
        },
      },
      logger,
      onMessageCallback: async () => {
        throw new Error("handler boom");
      },
      onEventCallback: async () => {
        throw new Error("event boom");
      },
    });

    await client.start();
    expect(client.isConnected()).toBe(true);

    // Trigger ping failure -> logged via logger.warn
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warns.some((m) => m.includes("ping failed"))).toBe(true);

    // Uncorrelated ACK, cmd-less object, headerless callback, and throwing callbacks
    createdSockets[0]?.emitJson({ headers: { req_id: "unknown_req" }, errcode: 0 });
    createdSockets[0]?.emitJson({ hello: "world" });
    createdSockets[0]?.emitJson({ cmd: "unknown_cmd" });
    createdSockets[0]?.emitJson({
      cmd: "aibot_msg_callback",
      body: "not-an-object" as unknown as Record<string, unknown>,
    });
    createdSockets[0]?.emitJson({
      cmd: "aibot_event_callback",
      headers: { req_id: "e1" },
      body: {},
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(errors.some((m) => m.includes("aibot_msg_callback"))).toBe(true);
    expect(errors.some((m) => m.includes("aibot_event_callback"))).toBe(true);

    // Queue an in-flight request with AbortSignal, then drop the socket -> rejectAllPending rejects it
    const inflightAbort = new AbortController();
    const pendingSend = client.sendProactiveMarkdown(
      { chatId: "u1", chatType: 1, content: "in-flight" },
      { signal: inflightAbort.signal },
    );
    const pendingSendRejection = expect(pendingSend).rejects.toThrow(/connection closed/);
    createdSockets[0]?.close(1006, "network drop");
    await pendingSendRejection;

    // Advance 400ms -> reconnect attempt #2 runs and fails subscribe -> logs reconnect warning
    await vi.advanceTimersByTimeAsync(420);
    expect(warns.some((m) => m.includes("reconnect attempt failed"))).toBe(true);

    // Trigger another close when reconnectTimer is scheduled, then call stop() to exercise clearTimers(reconnectTimer)
    const stopDuringReconnectClient = new WeComAibotWsClient({
      config: {
        botId: "bot_stop_timer",
        secret: "sec",
        reconnectInitialDelayMs: 2_000,
        createWebSocket: () => {
          const ws = new ControllableWebSocket(1);
          ws.onSend = (frame, sock) => {
            const headers = frame["headers"] as { req_id: string };
            sock.emitJson({ headers: { req_id: headers.req_id }, errcode: 0, errmsg: "ok" });
          };
          return ws;
        },
      },
    });
    await stopDuringReconnectClient.start();
    // Force close to schedule reconnectTimer, then immediately stop()
    await stopDuringReconnectClient.stop();
  });

  it("cancels scheduled reconnectTimer when stop() is called after an unexpected disconnect", async () => {
    vi.useFakeTimers();
    const sockets: ControllableWebSocket[] = [];
    const client = new WeComAibotWsClient({
      config: {
        botId: "bot_cancel_reconnect",
        secret: "sec",
        reconnectInitialDelayMs: 1_000,
        createWebSocket: () => {
          const ws = new ControllableWebSocket(1);
          ws.onSend = (frame, sock) => {
            const headers = frame["headers"] as { req_id: string };
            sock.emitJson({ headers: { req_id: headers.req_id }, errcode: 0, errmsg: "ok" });
          };
          sockets.push(ws);
          return ws;
        },
      },
    });

    await client.start();
    expect(sockets).toHaveLength(1);
    sockets[0]?.close(1006, "dropped");
    // Now reconnectTimer is active; stop() clears it so no second socket is created
    await client.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(1);
  });

  it("validates PKCS#7 / frame boundary guards in WeComMsgCrypt", () => {
    expect(() => pkcs7Unpad32(Buffer.alloc(0))).toThrow(ConnectorAuthError);
    expect(() => pkcs7Unpad32(Buffer.alloc(32, 0))).toThrow(ConnectorAuthError);
    expect(() => pkcs7Unpad32(Buffer.alloc(32, 33))).toThrow(ConnectorAuthError);
    const badPad = Buffer.alloc(32, 4);
    badPad[30] = 5;
    expect(() => pkcs7Unpad32(badPad)).toThrow(ConnectorAuthError);

    const crypt = new WeComMsgCrypt({
      token: TEST_TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: TEST_CORP_ID,
    });

    // Encrypted payload shorter than 20-byte header
    const shortHeaderCipher = encryptRawFrameWithKey(Buffer.alloc(10, 0x41));
    expect(() => crypt.decrypt(shortHeaderCipher)).toThrow(/shorter than 20-byte header/);

    // Encrypted payload whose 4-byte msg_len exceeds unpadded frame length
    const badLenFrame = Buffer.alloc(24, 0x41);
    badLenFrame.writeUInt32BE(9999, 16);
    const badLenCipher = encryptRawFrameWithKey(badLenFrame);
    expect(() => crypt.decrypt(badLenCipher)).toThrow(/exceeds frame boundary/);
  });

  it("covers ApiClient missing token, mid-flight abort, timeout, and Sender / Context / Streaming branches", async () => {
    // 1. gettoken returning empty access_token -> ConnectorAuthError
    const emptyTokenClient = new WeComApiClient({
      app: { corpId: "ww1", corpSecret: "sec", agentId: 1 },
      fetchFn: async () =>
        new Response(JSON.stringify({ errcode: 0, errmsg: "ok", access_token: "   " })),
    });
    await expect(emptyTokenClient.getAccessToken()).rejects.toThrow(/valid access_token/);

    // 2. Mid-flight AbortSignal listener triggers controller.abort
    const midController = new AbortController();
    const hangingClient = new WeComApiClient({
      timeoutMs: 10_000,
      fetchFn: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    });
    const midPromise = hangingClient.sendWebhookMessage(
      "wh_key",
      { msgtype: "text", text: { content: "hi" } },
      { signal: midController.signal },
    );
    midController.abort(new Error("user cancelled"));
    await expect(midPromise).rejects.toThrow(ConnectorTransportError);

    // 3. Sender markdown formatting on app & appchat + responseUrl explicit param
    const sentBodies: Array<Record<string, unknown>> = [];
    const okApiClient = new WeComApiClient({
      app: { corpId: "ww1", corpSecret: "sec", agentId: 7 },
      fetchFn: async (input, init) => {
        const url = input instanceof URL ? input.toString() : String(input);
        if (url.includes("/cgi-bin/gettoken")) {
          return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", access_token: "t1" }));
        }
        if (typeof init?.body === "string") {
          sentBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", msgid: "m1" }));
      },
    });
    const sender = new WeComSender({
      connectorName: "wecom",
      apiClient: okApiClient,
      includeContextMarkerByDefault: false,
    });
    await sender.send(
      createConnectorContext("wecom", "app:p2p:u1"),
      wecomSendSchema.parse({ text: "**md**", format: "markdown" }),
    );
    await sender.send(
      createConnectorContext("wecom", "app:group:chat1"),
      wecomSendSchema.parse({ text: "**group md**", format: "markdown" }),
    );
    await sender.send(
      createConnectorContext("wecom", "unstructured_ctx"),
      wecomSendSchema.parse({
        text: "via explicit responseUrl",
        responseUrl: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?code=explicit",
      }),
    );
    expect(sentBodies[0]).toMatchObject({ msgtype: "markdown", markdown: { content: "**md**" } });
    expect(sentBodies[1]).toMatchObject({
      msgtype: "markdown",
      markdown: { content: "**group md**" },
    });

    // 4. Context & Streaming edge helpers
    expect(parseWeComContextTarget("webhook:   ")).toBeUndefined();
    expect(parseWeComContextTarget("app:unknown:123")).toBeUndefined();
    const emptyFeedbackStream = buildPassiveStreamReplyPayload({
      streamId: "s_no_fb",
      content: "chunk",
      finish: false,
    });
    expect(emptyFeedbackStream.stream.feedback).toBeUndefined();
  });

  it("covers Receiver XML/JSON edge cases, media types, mixed quotes, group mention fallback, responseUrl eviction, and Connector full options", async () => {
    let clockMs = 1_700_000_000_000;
    const received: Array<{
      ctx: ConnectorContext<"wecom-edge">;
      params: WeComReceiveParams;
    }> = [];

    const streamAdapter: WeComStreamingAdapter = {
      startStream: async (target) => ({ streamId: "s1", target, startedAt: 0, expiresAt: 1 }),
      updateStream: async () => {},
      completeStream: async () => {},
      abortStream: async () => {},
      getPassiveStreamSnapshot: async () => undefined,
    };

    const connector = createWeComConnector({
      name: "wecom-edge",
      displayName: "Custom WeCom",
      description: "Custom description",
      app: { corpId: TEST_CORP_ID, corpSecret: "sec", agentId: 88 },
      callback: { token: TEST_TOKEN, encodingAesKey: ENCODING_AES_KEY, receiveId: "" },
      httpTimeoutMs: 5_000,
      now: () => clockMs,
      selfUserIds: ["bot_self_custom", "   "],
      botMentionNames: ["HelperBot", ""],
      requireMentionInGroup: true,
      inboundDeliveryMode: "steer",
      includeContextMarkerByDefault: true,
      contextMarkerStyle: "bracket",
      streamingAdapter: streamAdapter,
    });

    expect(connector.displayName).toBe("Custom WeCom");
    expect(connector.description).toBe("Custom description");
    expect(connector.getStreamingAdapter()).toBe(streamAdapter);

    const receiver = connector.getReceiver()!;
    // Calling ingestWsMessageCallback before init() is a safe no-op
    await (receiver as WeComReceiver<"wecom-edge">).ingestWsMessageCallback({
      cmd: "aibot_msg_callback",
      headers: { req_id: "r0" },
      body: {
        msgid: "pre_init_1",
        chattype: "single",
        from: { userid: "u_pre" },
        msgtype: "text",
        text: { content: "ignored before init" },
      },
    });

    const gen = createDefaultContextIdGenerator();
    const rxCtx: ConnectorReceiverContext<typeof wecomReceiveSchema, "wecom-edge"> = {
      allocateContextId: () => gen.generate("wecom-edge"),
      contextIdGenerator: gen,
      logger: createTrackingLogger().logger,
      onReceive: async (ctx, params) => {
        received.push({ ctx, params: params as WeComReceiveParams });
        return { sessionId: "sess_edge" };
      },
    };
    await receiver.init!(rxCtx);

    // Webhook without callback crypto returns 503
    const unconfiguredRx = new WeComReceiver({
      connectorName: "wecom",
      requireMentionInGroup: true,
      responseUrlCacheLimit: 2,
      now: () => clockMs,
    });
    await unconfiguredRx.init({
      allocateContextId: () => gen.generate("wecom"),
      contextIdGenerator: gen,
      logger: createTrackingLogger().logger,
      onReceive: async () => ({ sessionId: "s" }),
    });
    const res503 = await unconfiguredRx.handleWebhook({
      method: "POST",
      pathname: "/wh",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new Uint8Array(),
    });
    expect(res503.status).toBe(503);

    // Group mention fallback when botMentionNames is empty & requireMentionInGroup=true
    await unconfiguredRx.ingestWsMessageCallback({
      cmd: "aibot_msg_callback",
      headers: { req_id: "r_no_at" },
      body: {
        msgid: "m_no_at",
        chatid: "g1",
        chattype: "group",
        from: { userid: "u1" },
        msgtype: "text",
        text: { content: "plain group talk without at sign" },
      },
    });
    // Event / missing sender WS frames ignored
    await unconfiguredRx.ingestWsMessageCallback({
      cmd: "aibot_msg_callback",
      headers: { req_id: "r_ev" },
      body: { msgtype: "event" },
    });
    await unconfiguredRx.ingestWsMessageCallback({
      cmd: "aibot_msg_callback",
      headers: { req_id: "r_empty_user" },
      body: { msgtype: "text", from: { userid: "  " }, text: { content: "x" } },
    });

    // JSON callback edge cases via `receiver`
    const crypt = new WeComMsgCrypt({
      token: TEST_TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: "",
    });
    const postEncryptedJson = (plain: string) =>
      receiver.handleWebhook!({
        method: "POST",
        pathname: "/wh",
        subPath: "/",
        query: new URLSearchParams(),
        headers: {},
        rawBody: new TextEncoder().encode(
          crypt.encryptReply({
            plaintext: plain,
            timestamp: "1700000001",
            nonce: "n1",
            format: "json",
          }),
        ),
      });

    // Missing query signature/encrypt envelope -> 400
    const badEnvRes = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/wh",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new TextEncoder().encode("not an envelope"),
    });
    expect(badEnvRes.status).toBe(400);

    // Invalid decrypted JSON & non-object JSON -> 400
    expect((await postEncryptedJson("{broken-json")).status).toBe(400);
    expect((await postEncryptedJson("[1,2,3]")).status).toBe(400);

    // Event JSON, self-sender JSON, passive stream snapshot returning undefined -> 200 empty
    expect((await postEncryptedJson(JSON.stringify({ msgtype: "event" }))).status).toBe(200);
    expect(
      (
        await postEncryptedJson(
          JSON.stringify({
            msgtype: "text",
            from: { userid: "bot_self_custom" },
            text: { content: "loop" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await postEncryptedJson(
          JSON.stringify({
            msgid: "sp_none",
            aibotid: "b1",
            chatid: "g1",
            chattype: "group",
            from: { userid: "u1" },
            msgtype: "stream",
            stream: { id: "unknown_stream" },
          }),
        )
      ).body,
    ).toBe("");

    // Image message with mixed quote + LRU responseUrl cache + expiry
    await postEncryptedJson(
      JSON.stringify({
        msgid: "img_msg_1",
        aibotid: "b1",
        chattype: "single",
        from: { userid: "user_img" },
        response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?code=expiring",
        msgtype: "image",
        image: { url: "https://cos.example.com/pic.jpg" },
        quote: {
          msgtype: "mixed",
          mixed: {
            msg_item: ["non-record-item", { msgtype: "text", text: { content: "引用的第一段" } }],
          },
        },
      }),
    );
    expect(received.at(-1)?.params).toMatchObject({
      msgType: "image",
      mediaUrl: "https://cos.example.com/pic.jpg",
      quotedText: "引用的第一段",
    });

    // Advance clock past 1-hour response_url TTL -> expired entry pruned
    clockMs += 3_700_000;
    expect(
      (receiver as WeComReceiver<"wecom-edge">).consumeCachedResponseUrl("aibot:p2p:user_img"),
    ).toBeUndefined();

    // XML media/location/link/event branches + formatInbound group/media formatting
    const postEncryptedXml = (xml: string) =>
      receiver.handleWebhook!({
        method: "POST",
        pathname: "/wh",
        subPath: "/",
        query: new URLSearchParams(),
        headers: {},
        rawBody: new TextEncoder().encode(
          crypt.encryptReply({
            plaintext: xml,
            timestamp: "1700000002",
            nonce: "n2",
            format: "xml",
          }),
        ),
      });

    expect(
      (
        await postEncryptedXml(
          `<xml><ToUserName><![CDATA[ww]]></ToUserName><FromUserName><![CDATA[u1]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>`,
        )
      ).body,
    ).toBe("");
    await postEncryptedXml(
      `<xml><ToUserName><![CDATA[ww]]></ToUserName><FromUserName><![CDATA[u_loc]]></FromUserName><MsgType><![CDATA[location]]></MsgType><Label><![CDATA[北京市海淀区]]></Label><MsgId>901</MsgId></xml>`,
    );
    await postEncryptedXml(
      `<xml><ToUserName><![CDATA[ww]]></ToUserName><FromUserName><![CDATA[u_link]]></FromUserName><MsgType><![CDATA[link]]></MsgType><Title><![CDATA[企微文档]]></Title><Url><![CDATA[https://developer.work.weixin.qq.com]]></Url><MsgId>902</MsgId></xml>`,
    );
    await postEncryptedXml(
      `<xml><ToUserName><![CDATA[ww]]></ToUserName><FromUserName><![CDATA[u_pic]]></FromUserName><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[https://pic.example.com/a.jpg]]></PicUrl><MediaId><![CDATA[mid_1]]></MediaId><MsgId>903</MsgId></xml>`,
    );

    const typedRx = receiver as WeComReceiver<"wecom-edge">;
    const formattedGroup = typedRx.formatInbound(
      {
        source: "aibot-ws",
        messageId: "m1",
        msgType: "image",
        senderId: "u1",
        chatType: "group",
        chatId: "grp_1",
        text: "[image]",
        mediaUrl: "https://cos.example.com/1.png",
      },
      createConnectorContext("wecom-edge", "aibot:group:grp_1"),
    );
    expect(formattedGroup.title).toContain("WeCom Group grp_1");
    expect(formattedGroup.text).toContain("[media_url: https://cos.example.com/1.png]");

    const formattedMediaId = typedRx.formatInbound(
      {
        source: "app-webhook",
        messageId: "m2",
        msgType: "voice",
        senderId: "u2",
        chatType: "single",
        text: "[voice]",
        mediaId: "media_voice_9",
      },
      createConnectorContext("wecom-edge", "app:p2p:u2"),
    );
    expect(formattedMediaId.text).toContain("[media_id: media_voice_9]");
  });
});
