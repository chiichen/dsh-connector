import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  createDefaultContextIdGenerator,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import { WeComReceiver } from "../src/receiver";
import type {
  WeComReceiveParams,
  WeComWebSocketCloseEvent,
  WeComWebSocketLike,
  WeComWebSocketMessageEvent,
} from "../src/types";
import { WeComAibotWsClient } from "../src/ws-client";

class MockWebSocket implements WeComWebSocketLike {
  readyState = 0;
  readonly sentFrames: Array<Record<string, unknown>> = [];
  throwOnSend = false;
  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(ev: WeComWebSocketMessageEvent) => void>();
  private readonly closeListeners = new Set<(ev: WeComWebSocketCloseEvent) => void>();
  private readonly errorListeners = new Set<(ev: unknown) => void>();

  onSendFrame?: (frame: Record<string, unknown>, socket: MockWebSocket) => void;

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("socket write failed");
    }
    const parsed = JSON.parse(data) as Record<string, unknown>;
    this.sentFrames.push(parsed);
    this.onSendFrame?.(parsed, this);
  }

  close(code = 1000, reason = "closed"): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    const snapshot = Array.from(this.closeListeners);
    for (const listener of snapshot) {
      listener({ code, reason });
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
    const wrapOnce = <T>(set: Set<(arg: T) => void>, fn: (arg: T) => void) => {
      if (options?.once === true) {
        const wrapped = (arg: T): void => {
          set.delete(wrapped);
          fn(arg);
        };
        set.add(wrapped);
      } else {
        set.add(fn);
      }
    };

    if (type === "open") {
      wrapOnce(this.openListeners as Set<(arg: undefined) => void>, listener as () => void);
    } else if (type === "message") {
      wrapOnce(this.messageListeners, listener as (ev: WeComWebSocketMessageEvent) => void);
    } else if (type === "close") {
      wrapOnce(this.closeListeners, listener as (ev: WeComWebSocketCloseEvent) => void);
    } else {
      wrapOnce(this.errorListeners, listener as (ev: unknown) => void);
    }
  }

  removeEventListener(type: string, listener: (...args: never[]) => void): void {
    if (type === "open") this.openListeners.delete(listener as () => void);
    if (type === "message")
      this.messageListeners.delete(listener as (ev: WeComWebSocketMessageEvent) => void);
    if (type === "close")
      this.closeListeners.delete(listener as (ev: WeComWebSocketCloseEvent) => void);
    if (type === "error") this.errorListeners.delete(listener as (ev: unknown) => void);
  }

  triggerOpen(): void {
    this.readyState = 1;
    const snapshot = Array.from(this.openListeners);
    for (const listener of snapshot) {
      listener();
    }
  }

  triggerServerJson(
    payload: Record<string, unknown>,
    encoding: "string" | "uint8" | "arraybuffer" = "string",
  ): void {
    const raw = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(raw);
    const data: string | Uint8Array | ArrayBuffer =
      encoding === "uint8"
        ? bytes
        : encoding === "arraybuffer"
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : raw;
    const snapshot = Array.from(this.messageListeners);
    for (const listener of snapshot) {
      listener({ data });
    }
  }

  triggerRawData(data: string): void {
    const snapshot = Array.from(this.messageListeners);
    for (const listener of snapshot) {
      listener({ data });
    }
  }

  triggerError(err: unknown): void {
    const snapshot = Array.from(this.errorListeners);
    for (const listener of snapshot) {
      listener(err);
    }
  }
}

function createSilentLogger(): ConnectorLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("Stage 3: WeComAibotWsClient long connection & Receiver integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes with aibot_subscribe, sends 30s ping heartbeats, delivers inbound callbacks, and sends outbound frames", async () => {
    vi.useFakeTimers();
    const sockets: MockWebSocket[] = [];
    const createWebSocket = vi.fn((_url: string) => {
      const ws = new MockWebSocket();
      ws.onSendFrame = (frame, sock) => {
        const headers = frame["headers"] as { req_id: string };
        sock.triggerServerJson(
          {
            headers: { req_id: headers.req_id },
            errcode: 0,
            errmsg: "ok",
          },
          "uint8",
        );
      };
      sockets.push(ws);
      queueMicrotask(() => ws.triggerOpen());
      return ws;
    });

    const received: Array<{
      context: ConnectorContext<"wecom">;
      params: WeComReceiveParams;
      meta: InboundDeliveryMeta | undefined;
    }> = [];
    const gen = createDefaultContextIdGenerator();
    const receiverCtx: ConnectorReceiverContext<
      typeof import("../src/types").wecomReceiveSchema,
      "wecom"
    > = {
      allocateContextId: () => gen.generate("wecom"),
      contextIdGenerator: gen,
      logger: createSilentLogger(),
      onReceive: async (context, params, meta) => {
        received.push({ context, params: params as WeComReceiveParams, meta });
        return { sessionId: "sess_ws_1" };
      },
    };

    const receiver = new WeComReceiver({ connectorName: "wecom" });
    await receiver.init(receiverCtx);

    const eventsSeen: string[] = [];
    const wsClient = new WeComAibotWsClient({
      connectorName: "wecom",
      config: {
        botId: "aibot_001",
        secret: "ws_secret_001",
        heartbeatIntervalMs: 30_000,
        createWebSocket,
      },
      logger: createSilentLogger(),
      onMessageCallback: async (frame) => {
        await receiver.ingestWsMessageCallback(frame);
      },
      onEventCallback: (frame) => {
        eventsSeen.push(frame.cmd);
      },
    });

    // Coalesces concurrent start() calls & idempotent start() when already connected
    await Promise.all([wsClient.start(), wsClient.start()]);
    await wsClient.start();
    expect(wsClient.isConnected()).toBe(true);
    expect(sockets[0]?.sentFrames[0]).toMatchObject({
      cmd: "aibot_subscribe",
      body: { bot_id: "aibot_001", secret: "ws_secret_001" },
    });

    // Advance 30s -> sends ping frame
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]?.sentFrames.some((f) => f["cmd"] === "ping")).toBe(true);

    // Non-JSON / array frames & error events are tolerated gracefully
    sockets[0]?.triggerRawData("{not-json");
    sockets[0]?.triggerRawData("[1,2,3]");
    sockets[0]?.triggerError(new Error("transient warning"));

    // Server pushes `aibot_msg_callback` via ArrayBuffer
    sockets[0]?.triggerServerJson(
      {
        cmd: "aibot_msg_callback",
        headers: { req_id: "inbound_req_77" },
        body: {
          msgid: "ws_msg_77",
          aibotid: "aibot_001",
          chattype: "single",
          from: { userid: "wangwu" },
          msgtype: "voice",
          voice: { content: "帮我总结今天的日报" },
        },
      },
      "arraybuffer",
    );
    // Self-sent WS message (`userid === aibotid`) and event frame
    sockets[0]?.triggerServerJson({
      cmd: "aibot_msg_callback",
      headers: { req_id: "inbound_self" },
      body: {
        msgid: "ws_self",
        aibotid: "aibot_001",
        chattype: "single",
        from: { userid: "aibot_001" },
        msgtype: "text",
        text: { content: "echo" },
      },
    });
    sockets[0]?.triggerServerJson({
      cmd: "aibot_event_callback",
      headers: { req_id: "ev_enter" },
      body: {
        msgid: "ev_1",
        aibotid: "aibot_001",
        msgtype: "event",
        event: { eventtype: "enter_chat" },
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(received).toHaveLength(1);
    expect(eventsSeen).toEqual(["aibot_event_callback"]);
    expect(received[0]?.context.contextId).toBe("aibot:p2p:wangwu");
    expect(received[0]?.params).toMatchObject({
      source: "aibot-ws",
      messageId: "ws_msg_77",
      msgType: "voice",
      senderId: "wangwu",
      text: "帮我总结今天的日报",
      reqId: "inbound_req_77",
    });

    // Outbound proactive & callback respond frames over WebSocket
    const proactiveAck = await wsClient.sendProactiveMarkdown({
      chatId: "wangwu",
      chatType: 1,
      content: "**日报已生成**",
    });
    expect(proactiveAck.reqId).toBeTruthy();

    const respondAck = await wsClient.respondMarkdown({
      reqId: "inbound_req_77",
      content: "收到语音指令",
    });
    expect(respondAck.reqId).toBe("inbound_req_77");

    await wsClient.stop();
    expect(wsClient.isConnected()).toBe(false);
    await expect(
      wsClient.sendProactiveMarkdown({ chatId: "wangwu", chatType: 1, content: "after stop" }),
    ).rejects.toThrow(ConnectorTransportError);
  });

  it("reconnects on unexpected drop, halts reconnect on disconnected_event kick, and handles timeouts/abort/errors", async () => {
    vi.useFakeTimers();

    // Validation checks
    expect(() => new WeComAibotWsClient({ config: { botId: "", secret: "s" } })).toThrow(
      ConnectorValidationError,
    );
    expect(
      () =>
        new WeComAibotWsClient({
          config: { botId: "b", secret: "s", wsUrl: "https://not-ws" },
        }),
    ).toThrow(ConnectorValidationError);

    const sockets: MockWebSocket[] = [];
    const createWebSocket = vi.fn(() => {
      const ws = new MockWebSocket();
      ws.onSendFrame = (frame, sock) => {
        const headers = frame["headers"] as { req_id: string };
        if (frame["cmd"] === "aibot_send_msg") {
          const body = frame["body"] as { chatid: string };
          if (body.chatid === "biz_err") {
            sock.triggerServerJson({
              headers: { req_id: headers.req_id },
              errcode: 93000,
              errmsg: "rate limited",
            });
            return;
          }
          if (body.chatid === "no_ack") {
            return;
          }
        }
        sock.triggerServerJson({
          headers: { req_id: headers.req_id },
          errcode: 0,
          errmsg: "ok",
        });
      };
      sockets.push(ws);
      queueMicrotask(() => ws.triggerOpen());
      return ws;
    });

    const wsClient = new WeComAibotWsClient({
      connectorName: "wecom",
      config: {
        botId: "aibot_002",
        secret: "sec",
        requestTimeoutMs: 200,
        reconnectInitialDelayMs: 500,
        createWebSocket,
      },
      logger: createSilentLogger(),
    });

    await wsClient.start();
    expect(sockets).toHaveLength(1);

    // Non-zero business error code rejects with ConnectorTransportError
    await expect(
      wsClient.sendProactiveMarkdown({ chatId: "biz_err", chatType: 1, content: "x" }),
    ).rejects.toThrow(/93000/);

    // Pre-aborted signal & mid-flight abort & request timeout & send throw
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      wsClient.sendProactiveMarkdown(
        { chatId: "no_ack", chatType: 1, content: "x" },
        { signal: preAborted.signal },
      ),
    ).rejects.toThrow(/aborted/);

    const midAbort = new AbortController();
    const midPromise = wsClient.sendProactiveMarkdown(
      { chatId: "no_ack", chatType: 1, content: "x" },
      { signal: midAbort.signal },
    );
    midAbort.abort();
    await expect(midPromise).rejects.toThrow(/aborted/);

    const timeoutPromise = wsClient.sendProactiveMarkdown({
      chatId: "no_ack",
      chatType: 1,
      content: "x",
    });
    const timeoutExpectation = expect(timeoutPromise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(250);
    await timeoutExpectation;

    sockets[0]!.throwOnSend = true;
    await expect(
      wsClient.sendProactiveMarkdown({ chatId: "ok", chatType: 1, content: "x" }),
    ).rejects.toThrow(/socket write failed/);
    sockets[0]!.throwOnSend = false;

    // Unexpected network drop -> schedules reconnect after 500ms
    sockets[0]?.close(1006, "abnormal closure");
    expect(wsClient.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(550);
    expect(sockets).toHaveLength(2);
    expect(wsClient.isConnected()).toBe(true);

    // Server sends `disconnected_event` (kicked by newer instance) -> must NOT auto-reconnect!
    sockets[1]?.triggerServerJson({
      cmd: "aibot_event_callback",
      headers: { req_id: "ev_kick" },
      body: {
        msgid: "m_kick",
        aibotid: "aibot_002",
        msgtype: "event",
        event: { eventtype: "disconnected_event" },
      },
    });
    sockets[1]?.close(1000, "kicked");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(2);
    await wsClient.stop();

    // Auth rejection during `aibot_subscribe` throws ConnectorAuthError
    const authFailWsClient = new WeComAibotWsClient({
      connectorName: "wecom",
      config: {
        botId: "aibot_bad",
        secret: "wrong_secret",
        createWebSocket: () => {
          const ws = new MockWebSocket();
          ws.onSendFrame = (frame, sock) => {
            const headers = frame["headers"] as { req_id: string };
            sock.triggerServerJson({
              headers: { req_id: headers.req_id },
              errcode: 40001,
              errmsg: "invalid secret",
            });
          };
          queueMicrotask(() => ws.triggerOpen());
          return ws;
        },
      },
      logger: createSilentLogger(),
    });
    await expect(authFailWsClient.start()).rejects.toThrow(ConnectorAuthError);

    // Socket closes before open handshake
    const prematureCloseClient = new WeComAibotWsClient({
      connectorName: "wecom",
      config: {
        botId: "aibot_close",
        secret: "sec",
        autoReconnect: false,
        createWebSocket: () => {
          const ws = new MockWebSocket();
          queueMicrotask(() => ws.close(1006, "closed early"));
          return ws;
        },
      },
      logger: createSilentLogger(),
    });
    await expect(prematureCloseClient.start()).rejects.toThrow(/closed before handshake/);
  });
});
