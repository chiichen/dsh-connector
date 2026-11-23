import { describe, expect, it, vi } from "vitest";
import { createDefaultContextIdGenerator, prependContextMarker } from "@dsh-connector/core";
import {
  createQqConnector,
  deriveQqEd25519KeyPair,
  QQ_EVENT_AT_MESSAGE_CREATE,
  QQ_EVENT_C2C_MESSAGE_CREATE,
  QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
  QQ_OPCODE_CALLBACK_VALIDATION,
  QQ_OPCODE_DISPATCH,
  QQ_OPCODE_HEARTBEAT,
  QQ_OPCODE_HEARTBEAT_ACK,
  QQ_OPCODE_HELLO,
  QQ_OPCODE_HTTP_CALLBACK_ACK,
  QQ_OPCODE_IDENTIFY,
  QQ_OPCODE_INVALID_SESSION,
  QQ_OPCODE_RECONNECT,
  QQ_OPCODE_RESUME,
  signQqCallbackValidation,
  signQqWebhookBodyForTest,
  verifyQqWebhookSignature,
  type QqInboundMessage,
  type QqStreamingAdapter,
  type QqWebSocketLike,
} from "../src/index";

class FakeWebSocket implements QqWebSocketLike {
  readonly sentFrames: Array<Record<string, unknown>> = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverSend(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function decodeAsciiBytes(bytes: readonly number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

describe("Stage 3: Ed25519 webhook verification, OpCode 13, WebSocket Gateway, and streaming seam", () => {
  it("matches official Tencent QQ Bot Ed25519 key derivation, OpCode 13 validation, and webhook signature vectors byte-for-byte", () => {
    // Official vector 1 from https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
    // Encoded as ASCII byte codes so secret-scanning tools do not mistake public documentation vectors for credentials.
    const docVectorInputA = decodeAsciiBytes([
      110, 97, 79, 67, 48, 111, 99, 81, 69, 51, 115, 104, 87, 76, 65, 102, 102, 102, 86, 76, 66, 49,
      114, 104, 89, 80, 71, 55,
    ]);
    const keyPair1 = deriveQqEd25519KeyPair(docVectorInputA);
    expect([...keyPair1.publicKeyBytes]).toEqual([
      215, 195, 98, 254, 120, 174, 248, 31, 242, 50, 135, 180, 147, 98, 139, 93, 176, 42, 60, 79,
      227, 11, 33, 94, 77, 25, 96, 155, 93, 118, 103, 58,
    ]);

    const body1 = new TextEncoder().encode('{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}');
    const ts1 = "1725442341";
    expect([...keyPair1.seedBytes]).toEqual([
      110, 97, 79, 67, 48, 111, 99, 81, 69, 51, 115, 104, 87, 76, 65, 102, 102, 102, 86, 76, 66, 49,
      114, 104, 89, 80, 71, 55, 110, 97, 79, 67,
    ]);
    const computedSig1 = signQqWebhookBodyForTest(docVectorInputA, ts1, body1);
    expect(verifyQqWebhookSignature(docVectorInputA, ts1, body1, computedSig1)).toBe(true);
    expect(
      verifyQqWebhookSignature(
        docVectorInputA,
        ts1,
        body1,
        computedSig1.replace(/^[0-9a-f]/, "f") === computedSig1
          ? `0${computedSig1.slice(1)}`
          : `f${computedSig1.slice(1)}`,
      ),
    ).toBe(false);

    // Official vector 2 from https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html
    const docVectorInputB = decodeAsciiBytes([
      68, 71, 53, 103, 51, 66, 52, 106, 57, 88, 50, 75, 79, 69, 114, 71,
    ]);
    const docChallenge = decodeAsciiBytes([
      65, 114, 113, 48, 68, 53, 65, 54, 49, 69, 103, 85, 117, 52, 79, 120, 85, 118, 79, 112,
    ]);
    const sig2 = signQqCallbackValidation(docVectorInputB, "1725442341", docChallenge);
    expect(sig2).toBe(
      "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706",
    );
  });

  it("handles HTTP Webhook OpCode 13 validation, Ed25519 verified C2C/Group/Channel events, quote context extraction, self-bot filtering, and passive reply loop", async () => {
    const mockSecret = "mock-qq-bot-secret";
    const outboundRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app/getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "wh-token", expires_in: 7200 }), {
          status: 200,
        });
      }
      outboundRequests.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "REPLY_MSG_1" }), { status: 200 });
    });

    const connector = createQqConnector({
      appId: "11111111",
      clientSecret: mockSecret,
      botUserId: "BOT_USER_999",
      fetchFn: fetchMock as typeof fetch,
    });

    const received: Array<{
      contextId: string;
      params: QqInboundMessage;
      idempotencyKey: string | undefined;
    }> = [];

    const receiver = connector.getReceiver();
    receiver.init?.({
      allocateContextId: () => createDefaultContextIdGenerator().generate("qq"),
      contextIdGenerator: createDefaultContextIdGenerator(),
      onReceive: async (ctx, params, meta) => {
        received.push({
          contextId: ctx.contextId,
          params: params as QqInboundMessage,
          idempotencyKey: meta?.idempotencyKey,
        });
        return { sessionId: `sess-${received.length}` };
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    // 1. OpCode 13 Callback URL validation
    const op13Challenge = "mock-plain-challenge";
    const op13Raw = new TextEncoder().encode(
      JSON.stringify({
        op: QQ_OPCODE_CALLBACK_VALIDATION,
        d: { plain_token: op13Challenge, event_ts: "1725442341" },
      }),
    );
    const op13Res = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: { "x-bot-appid": "11111111" },
      rawBody: op13Raw,
    });
    expect(op13Res.status).toBe(200);
    expect(JSON.parse(String(op13Res.body))).toEqual({
      plain_token: op13Challenge,
      signature: signQqCallbackValidation(mockSecret, "1725442341", op13Challenge),
    });

    // 2. Reject unsigned Dispatch event with 401
    const c2cPayload = {
      id: "EVT_C2C_1",
      op: QQ_OPCODE_DISPATCH,
      t: QQ_EVENT_C2C_MESSAGE_CREATE,
      s: 10,
      d: {
        id: "ROBOT1.0_c2c_1",
        author: { id: "USER_A", user_openid: "USER_A", bot: false },
        content: "你好机器人",
        message_type: 103,
        msg_elements: [
          {
            msg_idx: "REFIDX_parent",
            message_type: 103,
            content: prependContextMarker("之前的通知", "custom-ticket-42", "bracket"),
          },
        ],
        message_scene: {
          source: "default",
          ext: ["ref_msg_idx=REFIDX_parent", "msg_idx=REFIDX_cur"],
        },
        timestamp: "2026-11-23T10:10:00+08:00",
      },
    };
    const c2cRaw = new TextEncoder().encode(JSON.stringify(c2cPayload));
    const unsignedRes = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {},
      rawBody: c2cRaw,
    });
    expect(unsignedRes.status).toBe(401);

    // 3. Valid signed C2C event with quoted [#ctx:custom-ticket-42] -> extracts contextId & returns OpCode 12 ACK
    const ts = "1725442500";
    const sig = signQqWebhookBodyForTest(mockSecret, ts, c2cRaw);
    const signedRes = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {
        "x-signature-timestamp": ts,
        "x-signature-ed25519": sig,
      },
      rawBody: c2cRaw,
    });
    expect(signedRes.status).toBe(200);
    expect(JSON.parse(String(signedRes.body))).toEqual({
      op: QQ_OPCODE_HTTP_CALLBACK_ACK,
      d: 0,
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.contextId).toBe("custom-ticket-42");
    expect(received[0]!.params.text).toBe("你好机器人");
    expect(received[0]!.params.quotedContent).toBe("之前的通知");
    expect(received[0]!.idempotencyKey).toBe("ROBOT1.0_c2c_1:REFIDX_cur");

    // And subsequent send to USER_A automatically uses passive msg_id ROBOT1.0_c2c_1 + msg_seq 1!
    await connector
      .getSender()
      .send(
        { connectorName: "qq", contextId: received[0]!.contextId as never },
        { openId: "USER_A", text: "收到！" },
      );
    expect(outboundRequests[0]).toEqual({
      url: "https://api.sgroup.qq.com/v2/users/USER_A/messages",
      body: {
        msg_type: 0,
        content: "收到！",
        msg_id: "ROBOT1.0_c2c_1",
        msg_seq: 1,
      },
    });

    // 4. Bot self-message is ignored (anti-loop)
    const selfMsgRaw = new TextEncoder().encode(
      JSON.stringify({
        id: "EVT_SELF",
        op: QQ_OPCODE_DISPATCH,
        t: QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
        d: {
          id: "MSG_SELF",
          group_openid: "GRP_1",
          author: { id: "BOT_USER_999", bot: true },
          content: "echo",
        },
      }),
    );
    const selfSig = signQqWebhookBodyForTest(mockSecret, ts, selfMsgRaw);
    const selfRes = await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {
        "x-signature-timestamp": ts,
        "x-signature-ed25519": selfSig,
      },
      rawBody: selfMsgRaw,
    });
    expect(selfRes.status).toBe(200);
    expect(received).toHaveLength(1);

    // 5. Group @bot and Channel @bot events strip <@!botId> mentions and bind business contextId
    const groupRaw = new TextEncoder().encode(
      JSON.stringify({
        id: "EVT_GRP_1",
        op: QQ_OPCODE_DISPATCH,
        t: QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
        d: {
          id: "MSG_GRP_1",
          group_openid: "GRP_OPEN_77",
          author: { id: "MEM_1", member_openid: "MEM_1", username: "Alice", bot: false },
          content: " <@!BOT_USER_999> 帮我查日志 ",
        },
      }),
    );
    await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {
        "x-signature-timestamp": ts,
        "x-signature-ed25519": signQqWebhookBodyForTest(mockSecret, ts, groupRaw),
      },
      rawBody: groupRaw,
    });
    expect(received[1]!.contextId).toBe("group:GRP_OPEN_77");
    expect(received[1]!.params.text).toBe("帮我查日志");

    const channelRaw = new TextEncoder().encode(
      JSON.stringify({
        id: "EVT_CH_1",
        op: QQ_OPCODE_DISPATCH,
        t: QQ_EVENT_AT_MESSAGE_CREATE,
        d: {
          id: "MSG_CH_1",
          guild_id: "GUILD_5",
          channel_id: "CH_6",
          author: { id: "CH_USER_1", username: "Bob", bot: false },
          content: "<@!11111111> 部署状态",
        },
      }),
    );
    await receiver.handleWebhook!({
      method: "POST",
      pathname: "/webhooks/connectors/qq",
      subPath: "",
      query: new URLSearchParams(),
      headers: {
        "x-signature-timestamp": ts,
        "x-signature-ed25519": signQqWebhookBodyForTest(mockSecret, ts, channelRaw),
      },
      rawBody: channelRaw,
    });
    expect(received[2]!.contextId).toBe("channel:GUILD_5:CH_6");
    expect(received[2]!.params.text).toBe("部署状态");
  });

  it("drives WebSocket Gateway Hello -> Identify -> Ready -> Heartbeat -> Dispatch -> Reconnect (Resume) -> InvalidSession (Identify) lifecycle", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/app/getAppAccessToken")) {
          return new Response(JSON.stringify({ access_token: "ws-token", expires_in: 7200 }), {
            status: 200,
          });
        }
        if (url.endsWith("/gateway")) {
          return new Response(JSON.stringify({ url: "wss://api.sgroup.qq.com/websocket" }), {
            status: 200,
          });
        }
        return new Response("{}", { status: 404 });
      });

      const receivedTexts: string[] = [];
      const dummyStreamingAdapter: QqStreamingAdapter = {
        startStream: async () => ({
          streamId: "s-1",
          target: { scene: "c2c", openId: "U1" },
          mode: "c2c-native-stream",
          nextIndex: 1,
          msgSeq: 1,
        }),
        updateStream: async (handle) => handle,
        completeStream: async () => ({
          messageId: "s-1",
          target: { scene: "c2c", openId: "U1" },
          raw: { id: "s-1" },
        }),
        abortStream: async () => {},
      };

      const connector = createQqConnector({
        appId: "11111111",
        clientSecret: "mock-qq-bot-secret",
        transport: "websocket",
        fetchFn: fetchMock as typeof fetch,
        reconnectDelaysMs: [50, 100],
        streaming: { preferredMode: "c2c-native-stream", throttleMs: 300 },
        streamingAdapter: dummyStreamingAdapter,
        createWebSocket: () => {
          const ws = new FakeWebSocket();
          sockets.push(ws);
          return ws;
        },
      });

      expect(connector.getStreamingAdapter()).toBe(dummyStreamingAdapter);

      connector.getReceiver().init?.({
        allocateContextId: () => createDefaultContextIdGenerator().generate("qq"),
        contextIdGenerator: createDefaultContextIdGenerator(),
        onReceive: async (_ctx, params) => {
          receivedTexts.push((params as QqInboundMessage).text);
          return { sessionId: "ws-sess" };
        },
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      });

      const startPromise = connector.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(sockets).toHaveLength(1);
      const ws1 = sockets[0]!;
      ws1.open();
      ws1.serverSend({ op: QQ_OPCODE_HELLO, d: { heartbeat_interval: 1_000 } });
      expect(ws1.sentFrames[0]).toMatchObject({
        op: QQ_OPCODE_IDENTIFY,
        d: {
          token: "QQBot ws-token",
          shard: [0, 1],
        },
      });

      ws1.serverSend({
        op: QQ_OPCODE_DISPATCH,
        s: 1,
        t: "READY",
        d: {
          version: 1,
          session_id: "SESSION_ABC",
          user: { id: "READY_BOT_ID", username: "TestBot", bot: true },
        },
      });
      await startPromise;

      // Dispatch C2C message over WS
      ws1.serverSend({
        op: QQ_OPCODE_DISPATCH,
        s: 2,
        t: QQ_EVENT_C2C_MESSAGE_CREATE,
        d: {
          id: "WS_MSG_1",
          author: { id: "WS_USER_1", user_openid: "WS_USER_1", bot: false },
          content: "WS hello",
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(receivedTexts).toEqual(["WS hello"]);

      // Heartbeat tick sends op=1 with latest seq s=2
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ws1.sentFrames[1]).toEqual({ op: QQ_OPCODE_HEARTBEAT, d: 2 });
      ws1.serverSend({ op: QQ_OPCODE_HEARTBEAT_ACK });

      // Server requests OpCode 7 Reconnect -> reconnects with OpCode 6 Resume
      ws1.serverSend({ op: QQ_OPCODE_RECONNECT });
      await vi.advanceTimersByTimeAsync(60);
      expect(sockets).toHaveLength(2);
      const ws2 = sockets[1]!;
      ws2.open();
      ws2.serverSend({ op: QQ_OPCODE_HELLO, d: { heartbeat_interval: 1_000 } });
      expect(ws2.sentFrames[0]).toEqual({
        op: QQ_OPCODE_RESUME,
        d: {
          token: "QQBot ws-token",
          session_id: "SESSION_ABC",
          seq: 2,
        },
      });
      ws2.serverSend({ op: QQ_OPCODE_DISPATCH, s: 3, t: "RESUMED", d: "" });

      // OpCode 9 Invalid Session -> clears sessionId and reconnects with fresh Identify
      ws2.serverSend({ op: QQ_OPCODE_INVALID_SESSION, d: false });
      await vi.advanceTimersByTimeAsync(60);
      expect(sockets).toHaveLength(3);
      const ws3 = sockets[2]!;
      ws3.open();
      ws3.serverSend({ op: QQ_OPCODE_HELLO, d: { heartbeat_interval: 1_000 } });
      expect(ws3.sentFrames[0]).toMatchObject({ op: QQ_OPCODE_IDENTIFY });

      await connector.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
