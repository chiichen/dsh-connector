import { describe, expect, it, vi } from "vitest";
import {
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
} from "@dsh-connector/core";
import {
  WeComConnector,
  WeComMsgCrypt,
  createWeComConnector,
  wecomReceiveSchema,
  wecomSendSchema,
  type WeComReceiveParams,
  type WeComStreamingAdapter,
  type WeComWebSocketCloseEvent,
  type WeComWebSocketLike,
  type WeComWebSocketMessageEvent,
} from "../src";

const TOKEN = "e2e_token_2026";
const ENCODING_AES_KEY = "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C";
const CORP_ID = "ww_e2e_corp";

function createSilentLogger(): ConnectorLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

class InMemoryWs implements WeComWebSocketLike {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = {
    open: new Set<() => void>(),
    message: new Set<(ev: WeComWebSocketMessageEvent) => void>(),
    close: new Set<(ev: WeComWebSocketCloseEvent) => void>(),
    error: new Set<(ev: unknown) => void>(),
  };

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    const headers = frame["headers"] as { req_id: string };
    queueMicrotask(() => {
      for (const fn of Array.from(this.listeners.message)) {
        fn({
          data: JSON.stringify({
            headers: { req_id: headers.req_id },
            errcode: 0,
            errmsg: "ok",
          }),
        });
      }
    });
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    for (const fn of Array.from(this.listeners.close)) {
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
    const set = this.listeners[type] as Set<(arg: unknown) => void>;
    const fn = listener as (arg: unknown) => void;
    if (options?.once === true) {
      const onceWrapper = (arg: unknown): void => {
        set.delete(onceWrapper);
        fn(arg);
      };
      set.add(onceWrapper);
    } else {
      set.add(fn);
    }
  }

  removeEventListener(type: string, listener: (...args: never[]) => void): void {
    if (type in this.listeners) {
      const set = this.listeners[type as keyof typeof this.listeners] as Set<unknown>;
      set.delete(listener);
    }
  }

  openNow(): void {
    this.readyState = 1;
    for (const fn of Array.from(this.listeners.open)) {
      fn();
    }
  }

  pushInbound(frame: Record<string, unknown>): void {
    for (const fn of Array.from(this.listeners.message)) {
      fn({ data: JSON.stringify(frame) });
    }
  }
}

describe("Stage 4: WeComConnector end-to-end closed loops & streaming seam", () => {
  it("completes Self-Built App inbound XML -> DSH session -> outbound REST reply closed loop", async () => {
    const fetchCalls: Array<{ url: string; body?: string }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      fetchCalls.push({
        url,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (url.includes("/cgi-bin/gettoken")) {
        return new Response(
          JSON.stringify({ errcode: 0, errmsg: "ok", access_token: "e2e_tok", expires_in: 7200 }),
        );
      }
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", msgid: "app_out_1" }));
    };

    const connector = createWeComConnector({
      name: "wecom-ops",
      app: { corpId: CORP_ID, corpSecret: "sec", agentId: 1000010 },
      callback: { token: TOKEN, encodingAesKey: ENCODING_AES_KEY },
      fetchFn,
      logger: createSilentLogger(),
    });

    expect(connector.name).toBe("wecom-ops");
    expect(connector.getStreamingAdapter()).toBeUndefined();
    expect(connector.getApiClient()).toBeDefined();
    expect(connector.getWsClient()).toBeUndefined();

    const inboundContexts: Array<ConnectorContext<"wecom-ops">> = [];
    const gen = createDefaultContextIdGenerator();
    const receiver = connector.getReceiver()!;
    const receiverCtx: ConnectorReceiverContext<typeof wecomReceiveSchema, "wecom-ops"> = {
      allocateContextId: () => gen.generate("wecom-ops"),
      contextIdGenerator: gen,
      logger: createSilentLogger(),
      onReceive: async (ctx) => {
        inboundContexts.push(ctx);
        return { sessionId: "sess_app_e2e" };
      },
    };
    await receiver.init!(receiverCtx);
    await connector.start();

    const crypt = new WeComMsgCrypt({
      token: TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: CORP_ID,
    });
    const xml = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[chen]]></FromUserName><CreateTime>1700009000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[查询集群健康状态]]></Content><MsgId>5001</MsgId><AgentID>1000010</AgentID></xml>`;
    const postBody = crypt.encryptReply({
      plaintext: xml,
      timestamp: "1700009000",
      nonce: "n1",
      format: "xml",
    });

    const whRes = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/wecom-ops",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new TextEncoder().encode(postBody),
    });
    expect(whRes.status).toBe(200);
    expect(inboundContexts).toHaveLength(1);
    expect(inboundContexts[0]?.contextId).toBe("app:p2p:chen");

    // Outbound reply using the exact inbound ConnectorContext without explicit target!
    const sendRes = await connector
      .getSender()
      .send(inboundContexts[0]!, wecomSendSchema.parse({ text: "所有节点健康" }));
    expect(sendRes.channel).toBe("app");
    expect(sendRes.target).toBe("chen");
    expect(sendRes.messageId).toBe("app_out_1");
    expect(fetchCalls).toHaveLength(2);
    await connector.stop();
  });

  it("completes Intelligent Bot HTTP Callback (response_url) and WebSocket closed loops", async () => {
    const postedUrls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      postedUrls.push(input instanceof URL ? input.toString() : String(input));
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }));
    };

    // 1. Intelligent Bot HTTP Callback mode (no WebSocket configured -> uses cached response_url)
    const httpBot = new WeComConnector({
      name: "wecom-aibot-http",
      callback: { token: TOKEN, encodingAesKey: ENCODING_AES_KEY },
      fetchFn,
    });
    const gen = createDefaultContextIdGenerator();
    let httpBoundCtx: ConnectorContext<"wecom-aibot-http"> | undefined;
    await httpBot.getReceiver()!.init!({
      allocateContextId: () => gen.generate("wecom-aibot-http"),
      contextIdGenerator: gen,
      logger: createSilentLogger(),
      onReceive: async (ctx) => {
        httpBoundCtx = ctx;
        return { sessionId: "sess_http_bot" };
      },
    });

    const aibotCrypt = new WeComMsgCrypt({
      token: TOKEN,
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: "",
    });
    const inboundJson = JSON.stringify({
      msgid: "m_http_1",
      aibotid: "bot_h1",
      chattype: "single",
      from: { userid: "alice" },
      response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?code=once_token",
      msgtype: "text",
      text: { content: "你好" },
    });
    await httpBot.getReceiver()!.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/wecom-aibot-http",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new TextEncoder().encode(
        aibotCrypt.encryptReply({
          plaintext: inboundJson,
          timestamp: "1700010000",
          nonce: "n2",
          format: "json",
        }),
      ),
    });

    expect(httpBoundCtx?.contextId).toBe("aibot:p2p:alice");
    const httpReply = await httpBot
      .getSender()
      .send(httpBoundCtx!, wecomSendSchema.parse({ text: "**你好 Alice**" }));
    expect(httpReply.channel).toBe("aibot");
    expect(postedUrls).toEqual([
      "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?code=once_token",
    ]);

    // Second send after single-use response_url is consumed falls back to wsClient, which is not configured on httpBot
    await expect(
      httpBot.getSender().send(httpBoundCtx!, wecomSendSchema.parse({ text: "second" })),
    ).rejects.toThrow(/not connected/);
    await expect(
      httpBot
        .getSender()
        .send(httpBoundCtx!, wecomSendSchema.parse({ text: "req", reqId: "r_none" })),
    ).rejects.toThrow(/not connected/);

    // 2. Intelligent Bot WebSocket Long Connection closed loop
    let activeWs: InMemoryWs | undefined;
    const wsBot = createWeComConnector({
      name: "wecom-aibot-ws",
      aibotWs: {
        botId: "bot_ws_1",
        secret: "sec_ws_1",
        createWebSocket: () => {
          activeWs = new InMemoryWs();
          queueMicrotask(() => activeWs?.openNow());
          return activeWs;
        },
      },
      logger: createSilentLogger(),
    });

    const wsReceived: Array<{
      ctx: ConnectorContext<"wecom-aibot-ws">;
      params: WeComReceiveParams;
    }> = [];
    await wsBot.getReceiver()!.init!({
      allocateContextId: () => gen.generate("wecom-aibot-ws"),
      contextIdGenerator: gen,
      logger: createSilentLogger(),
      onReceive: async (ctx, params) => {
        wsReceived.push({ ctx, params: params as WeComReceiveParams });
        return { sessionId: "sess_ws_bot" };
      },
    });

    await wsBot.start();
    expect(wsBot.getWsClient()?.isConnected()).toBe(true);

    activeWs!.pushInbound({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req_ws_e2e" },
      body: {
        msgid: "m_ws_e2e",
        aibotid: "bot_ws_1",
        chatid: "grp_dev",
        chattype: "group",
        from: { userid: "bob" },
        msgtype: "text",
        text: { content: "发布进度如何？" },
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(wsReceived).toHaveLength(1);
    expect(wsReceived[0]?.ctx.contextId).toBe("aibot:group:grp_dev");

    const wsReply = await wsBot
      .getSender()
      .send(wsReceived[0]!.ctx, wecomSendSchema.parse({ text: "已完成 100%" }));
    expect(wsReply.channel).toBe("aibot");
    expect(activeWs!.sent.at(-1)).toMatchObject({
      cmd: "aibot_send_msg",
      body: {
        chatid: "grp_dev",
        chat_type: 2,
        msgtype: "markdown",
        markdown: { content: "已完成 100%" },
      },
    });

    await wsBot.stop();
    expect(wsBot.getWsClient()?.isConnected()).toBe(false);
  });

  it("supports outbound-only webhook mode, validates connector name, and exposes streamingAdapter slot", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, errmsg: "ok" })));
    const dummyStreamAdapter: WeComStreamingAdapter = {
      startStream: async (target) => ({ streamId: "s", target, startedAt: 0, expiresAt: 1 }),
      updateStream: async () => {},
      completeStream: async () => {},
      abortStream: async () => {},
    };

    const webhookOnly = createWeComConnector({
      webhook: { apiBaseUrl: "https://qyapi.weixin.qq.com/" },
      fetchFn: fetchFn as unknown as typeof fetch,
      streaming: { enabled: false, adapter: dummyStreamAdapter },
    });

    expect(webhookOnly.name).toBe("wecom");
    expect(webhookOnly.getReceiver()).toBeUndefined();
    expect(webhookOnly.getStreamingAdapter()).toBe(dummyStreamAdapter);
    await webhookOnly.start();
    const res = await webhookOnly
      .getSender()
      .send(
        createConnectorContext("wecom", "webhook:room_key_99"),
        wecomSendSchema.parse({ text: "部署成功" }),
      );
    expect(res.channel).toBe("webhook");
    await webhookOnly.stop();

    expect(() => createWeComConnector({ name: "INVALID--NAME" })).toThrow(ConnectorValidationError);
  });
});
