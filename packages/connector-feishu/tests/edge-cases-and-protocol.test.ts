import { describe, expect, it, vi } from "vitest";
import {
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  type ConnectorContextId,
  type ConnectorLogger,
  type ConnectorWebhookRequest,
} from "@dsh-connector/core";
import {
  FeishuApiClient,
  FeishuWsFragmentAssembler,
  FeishuWsLongConnectionClient,
  applyOutboundContextMarker,
  buildFeishuConversationContextId,
  createFeishuConnector,
  decodePbbp2Frame,
  encodePbbp2Frame,
  extractTextFromFetchedMessage,
  parseFeishuContextTarget,
  parseFeishuMessageReceiveEvent,
  resolveFeishuApiBaseUrl,
  resolveFeishuSendTarget,
  type FeishuWebSocketLike,
} from "../src/index";

const silentLogger: ConnectorLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeWebhookReq(
  rawBody: Uint8Array,
  options?: {
    method?: string;
    headers?: Record<string, string | readonly string[] | undefined>;
  },
): ConnectorWebhookRequest {
  return {
    method: options?.method ?? "POST",
    pathname: "/webhooks/connectors/feishu",
    subPath: "",
    query: new URLSearchParams(),
    headers: options?.headers ?? {},
    rawBody,
  };
}

class ProgrammableSocket implements FeishuWebSocketLike {
  readyState = 0;
  binaryType = "arraybuffer";
  readonly sentFrames: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: Uint8Array): void {
    this.sentFrames.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }
}

describe("message-parser edge cases (interactive cards, post tags, mentions, allowlist)", () => {
  it("extracts interactive card text from json_card, div fields, and columns", () => {
    const cardPayload = {
      json_card: JSON.stringify({
        header: {
          title: { tag: "plain_text", content: "Alert Card" },
        },
        body: {
          elements: [
            {
              tag: "div",
              text: { tag: "lark_md", content: "Service CPU > 90%" },
              fields: [{ text: { tag: "plain_text", content: "Region: cn-north" } }],
            },
            {
              tag: "column_set",
              columns: [{ elements: [{ tag: "markdown", content: "Action needed" }] }],
            },
          ],
        },
      }),
    };

    const outcome = parseFeishuMessageReceiveEvent({
      header: { event_id: "ev_card_1", tenant_key: "tk_1", create_time: "1710000100000" },
      event: {
        sender: {
          sender_type: "user",
          sender_id: { open_id: "ou_alice", user_id: "u_alice", union_id: "on_alice" },
        },
        message: {
          message_id: "om_card_1",
          chat_id: "oc_dm_1",
          chat_type: "p2p",
          message_type: "interactive",
          content: JSON.stringify(cardPayload),
        },
      },
    });

    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) {
      expect(outcome.message.text).toContain("Alert Card");
      expect(outcome.message.text).toContain("Service CPU > 90%");
      expect(outcome.message.text).toContain("Region: cn-north");
      expect(outcome.message.text).toContain("Action needed");
      expect(outcome.message.tenantKey).toBe("tk_1");
      expect(outcome.message.senderUnionId).toBe("on_alice");
    }
  });

  it("extracts direct post blocks with <at> human mentions and links", () => {
    const outcome = parseFeishuMessageReceiveEvent(
      {
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } },
          message: {
            message_id: "om_post_1",
            chat_id: "oc_grp_1",
            chat_type: "group",
            message_type: "post",
            mentions: [{ key: "@_user_1", id: "ou_bot", name: "HelperBot" }],
            content: JSON.stringify({
              title: "Release Plan",
              content: [
                [
                  { tag: "at", user_id: "ou_bob", user_name: "Bob" },
                  { tag: "text", text: " check " },
                  { tag: "a", text: "https://open.feishu.cn" },
                ],
              ],
            }),
          },
        },
      },
      { botOpenId: "ou_bot" },
    );

    expect(outcome).toEqual({
      accepted: true,
      message: expect.objectContaining({
        text: "Release Plan\n@Bob check https://open.feishu.cn",
        mentionedBot: true,
      }),
    });

    expect(
      extractTextFromFetchedMessage({
        msg_type: "interactive",
        body: { content: JSON.stringify({ title: "CardTitle", elements: [] }) },
      }),
    ).toBe("CardTitle");
  });

  it("handles botName matching, @_all policy, groupMentionPolicy='all', allowlist, and legacy app_id loop guard", () => {
    // 1. Legacy app_id self-message guard
    expect(
      parseFeishuMessageReceiveEvent(
        {
          event: {
            sender: { id: "cli_self", id_type: "app_id", sender_type: "user" },
            message: {
              message_id: "om_1",
              chat_id: "oc_1",
              chat_type: "p2p",
              message_type: "text",
              content: '{"text":"loop"}',
            },
          },
        },
        { appId: "cli_self" },
      ),
    ).toEqual({ accepted: false, reason: "bot_self_message" });

    // 2. Sender allowlist rejection & wildcard acceptance
    const baseEvent = {
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_stranger" } },
        message: {
          message_id: "om_2",
          chat_id: "oc_2",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"hi"}',
        },
      },
    };
    expect(parseFeishuMessageReceiveEvent(baseEvent, { allowedOpenIds: ["ou_admin"] })).toEqual({
      accepted: false,
      reason: "sender_not_allowed",
    });
    expect(parseFeishuMessageReceiveEvent(baseEvent, { allowedOpenIds: ["*"] }).accepted).toBe(
      true,
    );

    // 3. @_all rejected by default in group, accepted when allowAtAllInGroup=true
    const atAllGroupEvent = {
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } },
        message: {
          message_id: "om_3",
          chat_id: "oc_grp",
          chat_type: "group",
          message_type: "text",
          mentions: [{ key: "@_all", name: "所有人" }],
          content: '{"text":"@_all standup time"}',
        },
      },
    };
    expect(parseFeishuMessageReceiveEvent(atAllGroupEvent, { botName: "MyBot" })).toEqual({
      accepted: false,
      reason: "group_not_mentioned",
    });
    const atAllAccepted = parseFeishuMessageReceiveEvent(atAllGroupEvent, {
      botName: "MyBot",
      allowAtAllInGroup: true,
    });
    expect(atAllAccepted.accepted).toBe(true);
    if (atAllAccepted.accepted) {
      expect(atAllAccepted.message.text).toBe("standup time");
    }

    // 4. botName fallback mention match + groupMentionPolicy: "all"
    const botNameGroup = parseFeishuMessageReceiveEvent(
      {
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } },
          message: {
            message_id: "om_4",
            chat_id: "oc_grp",
            chat_type: "group",
            message_type: "text",
            mentions: [
              { key: "@_user_1", name: "MyBot" },
              { key: "@_user_2", id: { open_id: "ou_anon" } },
            ],
            content: '{"text":"@_user_1 @_user_2 ping"}',
          },
        },
      },
      { botName: "MyBot" },
    );
    expect(botNameGroup.accepted).toBe(true);
    if (botNameGroup.accepted) {
      expect(botNameGroup.message.text).toBe("ping");
    }

    // 5. Invalid payloads & unsupported message types
    expect(parseFeishuMessageReceiveEvent({})).toEqual({
      accepted: false,
      reason: "invalid_event_payload",
    });
    expect(parseFeishuMessageReceiveEvent({ event: {} })).toEqual({
      accepted: false,
      reason: "invalid_event_payload",
    });
    expect(
      parseFeishuMessageReceiveEvent({
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
          message: {
            message_id: "om_1",
            chat_id: "oc_1",
            chat_type: "unknown",
            message_type: "text",
          },
        },
      }),
    ).toEqual({ accepted: false, reason: "invalid_event_payload" });
    expect(
      parseFeishuMessageReceiveEvent({
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
          message: {
            message_id: "om_img",
            chat_id: "oc_1",
            chat_type: "p2p",
            message_type: "image",
            content: "not-json",
          },
        },
      }),
    ).toEqual({ accepted: false, reason: "empty_or_unsupported_message" });
  });
});

describe("pbbp2 binary wire codec and fragment assembler edge cases", () => {
  it("skips unknown varint, 64-bit, length-delimited, and 32-bit protobuf fields and rejects malformed frames", () => {
    const valid = encodePbbp2Frame({
      seqId: 7,
      logId: 8,
      service: 9,
      method: 1,
      headers: [{ key: "type", value: "event" }],
      payloadEncoding: "utf-8",
      payloadType: "application/json",
      payload: new TextEncoder().encode('{"ok":true}'),
      logIdNew: "log_new_1",
    });

    // Append unknown fields:
    // field 20 varint (tag = (20<<3)|0 = 160 -> 0xa0, 0x01; val = 0x2a)
    // field 21 64-bit (tag = (21<<3)|1 = 169 -> 0xa9, 0x01; 8 bytes)
    // field 22 len-delimited (tag = (22<<3)|2 = 178 -> 0xb2, 0x01; len=2, 0xaa, 0xbb)
    // field 23 32-bit (tag = (23<<3)|5 = 189 -> 0xbd, 0x01; 4 bytes)
    const extra = Uint8Array.from([
      0xa0, 0x01, 0x2a, 0xa9, 0x01, 1, 2, 3, 4, 5, 6, 7, 8, 0xb2, 0x01, 2, 0xaa, 0xbb, 0xbd, 0x01,
      9, 10, 11, 12,
    ]);
    const combined = new Uint8Array(valid.byteLength + extra.byteLength);
    combined.set(valid, 0);
    combined.set(extra, valid.byteLength);

    const decoded = decodePbbp2Frame(combined);
    expect(decoded.seqId).toBe(7);
    expect(decoded.logIdNew).toBe("log_new_1");

    // Truncated varint
    expect(() => decodePbbp2Frame(Uint8Array.from([0x80]))).toThrow(ConnectorTransportError);
    // Varint overflow (>= 70 bits)
    expect(() =>
      decodePbbp2Frame(
        Uint8Array.from([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]),
      ),
    ).toThrow(ConnectorTransportError);
    // Out-of-bounds length-delimited field
    expect(() => decodePbbp2Frame(Uint8Array.from([0x42, 0x10, 0x01]))).toThrow(
      ConnectorTransportError,
    );
    // Truncated 64-bit field (tag = (21<<3)|1)
    expect(() => decodePbbp2Frame(Uint8Array.from([0xa9, 0x01, 1, 2]))).toThrow(
      ConnectorTransportError,
    );
    // Truncated 32-bit field (tag = (23<<3)|5)
    expect(() => decodePbbp2Frame(Uint8Array.from([0xbd, 0x01, 1]))).toThrow(
      ConnectorTransportError,
    );
    // Unsupported wire type 3 (start group: tag = (24<<3)|3 = 195 -> 0xc3, 0x01)
    expect(() => decodePbbp2Frame(Uint8Array.from([0xc3, 0x01]))).toThrow(ConnectorTransportError);
  });

  it("validates fragment metadata, detects sum mismatch, and evicts expired fragments", () => {
    let clock = 1_000;
    const assembler = new FeishuWsFragmentAssembler({ ttlMs: 500, now: () => clock });

    expect(() =>
      assembler.push({ messageId: "", sum: 2, seq: 0, chunk: Uint8Array.from([1]) }),
    ).toThrow(ConnectorValidationError);
    expect(() =>
      assembler.push({ messageId: "m1", sum: 2, seq: 2, chunk: Uint8Array.from([1]) }),
    ).toThrow(ConnectorValidationError);

    expect(
      assembler.push({ messageId: "m_mismatch", sum: 2, seq: 0, chunk: Uint8Array.from([1]) }),
    ).toBeUndefined();
    expect(() =>
      assembler.push({ messageId: "m_mismatch", sum: 3, seq: 1, chunk: Uint8Array.from([2]) }),
    ).toThrow(ConnectorValidationError);

    // Expire partial fragment via TTL
    expect(
      assembler.push({ messageId: "m_stale", sum: 2, seq: 0, chunk: Uint8Array.from([9]) }),
    ).toBeUndefined();
    clock += 1_000;
    expect(
      assembler.push({ messageId: "m_single", sum: 1, seq: 0, chunk: Uint8Array.from([7]) }),
    ).toEqual(Uint8Array.from([7]));
    assembler.clear();
  });
});

describe("WebSocket client, context addressing, and webhook edge cases", () => {
  it("handles WebSocket handshake error/timeout, pong config updates, bad frames, and reconnect exhaustion", async () => {
    const apiClient = new FeishuApiClient({
      appId: "cli_ws_edge",
      appSecret: "sec",
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: "wss://msg-frontier.feishu.cn/ws/v2?service_id=77",
              ClientConfig: {
                PingInterval: 60,
                ReconnectInterval: 0.005,
                ReconnectNonce: 0,
                ReconnectCount: 1,
              },
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    // 1. Handshake timeout
    const timeoutClient = new FeishuWsLongConnectionClient({
      apiClient,
      handshakeTimeoutMs: 15,
      autoReconnect: false,
      onEventEnvelope: async () => {},
      createWebSocket: () => new ProgrammableSocket(),
    });
    await expect(timeoutClient.start()).rejects.toThrow(ConnectorTransportError);

    // 2. Handshake immediate error
    const errorClient = new FeishuWsLongConnectionClient({
      apiClient,
      handshakeTimeoutMs: 200,
      autoReconnect: false,
      onEventEnvelope: async () => {},
      createWebSocket: () => {
        const sock = new ProgrammableSocket();
        queueMicrotask(() => sock.emit("error", new Error("boom")));
        return sock;
      },
    });
    await expect(errorClient.start()).rejects.toThrow(ConnectorTransportError);

    // 3. Pong config update, malformed frame, ArrayBuffer event returning 500 ack on handler error, and reconnect loop
    const sockets: ProgrammableSocket[] = [];
    let shouldFailConnect = false;
    const activeClient = new FeishuWsLongConnectionClient({
      apiClient,
      handshakeTimeoutMs: 200,
      autoReconnect: true,
      logger: silentLogger,
      onEventEnvelope: async () => {
        throw new Error("handler failure");
      },
      createWebSocket: () => {
        const sock = new ProgrammableSocket();
        sockets.push(sock);
        queueMicrotask(() => {
          if (shouldFailConnect) {
            sock.emit("error", new Error("reconnect fail"));
          } else {
            sock.open();
          }
        });
        return sock;
      },
    });

    await activeClient.start();
    // Idempotent second start() while already open
    await activeClient.start();
    const s0 = sockets[0]!;

    // Pong with valid ClientConfig JSON + Pong with invalid JSON
    const pongValid = encodePbbp2Frame({
      seqId: 1,
      logId: 1,
      service: 77,
      method: 0,
      headers: [{ key: "type", value: "pong" }],
      payload: new TextEncoder().encode(JSON.stringify({ PingInterval: 90, ReconnectCount: 1 })),
    });
    s0.emit("message", { data: pongValid.buffer });

    const pongInvalid = encodePbbp2Frame({
      seqId: 2,
      logId: 2,
      service: 77,
      method: 0,
      headers: [{ key: "type", value: "pong" }],
      payload: new TextEncoder().encode("{bad-json"),
    });
    s0.emit("message", { data: new DataView(pongInvalid.buffer) });

    // Malformed pbbp2 bytes + invalid fragment sum="0"
    s0.emit("message", { data: Uint8Array.from([0x80]) });
    const invalidFragFrame = encodePbbp2Frame({
      seqId: 54,
      logId: 65,
      service: 77,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "ev_bad_frag" },
        { key: "sum", value: "0" },
        { key: "seq", value: "0" },
      ],
      payload: new Uint8Array([123, 125]),
    });
    s0.emit("message", { data: invalidFragFrame });

    // Event frame whose handler throws -> expects ack { code: 500 }
    const failingEventFrame = encodePbbp2Frame({
      seqId: 55,
      logId: 66,
      service: 77,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "ev_500" },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
      ],
      payload: new TextEncoder().encode(JSON.stringify({ schema: "2.0" })),
    });
    s0.emit("message", { data: failingEventFrame });
    await new Promise((r) => setTimeout(r, 15));

    const ack500 = decodePbbp2Frame(s0.sentFrames.at(-1)!);
    expect(JSON.parse(new TextDecoder().decode(ack500.payload))).toEqual({ code: 500 });

    // Trigger socket error + unexpected close -> reconnect fails -> hits ReconnectCount=1 limit
    s0.emit("error", new Error("transient"));
    shouldFailConnect = true;
    s0.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets.length).toBe(2);

    activeClient.stop();
  });

  it("covers resolveBotInfoOnStart, context/domain validation branches, and webhook error responses", async () => {
    // Domain & context edge cases
    expect(() => resolveFeishuApiBaseUrl("   ")).toThrow(ConnectorValidationError);
    expect(() => resolveFeishuApiBaseUrl("not a url")).toThrow(ConnectorValidationError);
    expect(() => resolveFeishuApiBaseUrl("ftp://open.feishu.cn")).toThrow(ConnectorValidationError);
    expect(() => buildFeishuConversationContextId({ chatType: "p2p" })).toThrow(
      ConnectorValidationError,
    );
    expect(() => buildFeishuConversationContextId({ chatType: "group" })).toThrow(
      ConnectorValidationError,
    );

    const threadCtxId = buildFeishuConversationContextId({
      chatType: "group",
      chatId: "oc_thread_grp",
      threadId: "omt_99",
    });
    expect(threadCtxId).toBe("group:oc_thread_grp:thread:omt_99");
    expect(parseFeishuContextTarget(threadCtxId)).toEqual({
      mode: "send",
      receiveIdType: "chat_id",
      receiveId: "oc_thread_grp",
    });

    const p2pChatCtx = buildFeishuConversationContextId({
      chatType: "p2p",
      chatId: "oc_dm_fallback",
    });
    expect(parseFeishuContextTarget(p2pChatCtx)).toEqual({
      mode: "send",
      receiveIdType: "chat_id",
      receiveId: "oc_dm_fallback",
    });

    const p2pUserCtx = buildFeishuConversationContextId({
      chatType: "p2p",
      senderUserId: "u_emp_42",
    });
    expect(parseFeishuContextTarget(p2pUserCtx)).toEqual({
      mode: "send",
      receiveIdType: "user_id",
      receiveId: "u_emp_42",
    });

    const genericCtx = createConnectorContext("feishu", "group:oc_grp_1" as ConnectorContextId);
    expect(resolveFeishuSendTarget(genericCtx, { text: "hi", chatId: "oc_override" })).toEqual({
      mode: "send",
      receiveIdType: "chat_id",
      receiveId: "oc_override",
    });
    expect(resolveFeishuSendTarget(genericCtx, { text: "hi", userId: "u_1" })).toEqual({
      mode: "send",
      receiveIdType: "user_id",
      receiveId: "u_1",
    });
    expect(resolveFeishuSendTarget(genericCtx, { text: "hi", unionId: "on_1" })).toEqual({
      mode: "send",
      receiveIdType: "union_id",
      receiveId: "on_1",
    });
    expect(resolveFeishuSendTarget(genericCtx, { text: "hi", email: "a@b.com" })).toEqual({
      mode: "send",
      receiveIdType: "email",
      receiveId: "a@b.com",
    });
    expect(applyOutboundContextMarker("hello", genericCtx, "always")).toBe(
      "[#ctx:group:oc_grp_1]\nhello",
    );
    expect(applyOutboundContextMarker("hello", genericCtx, "never")).toBe("hello");

    // resolveBotInfoOnStart + webhook status codes (405, 400, 401, unsupported event, parent fetch error)
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }), {
          status: 200,
        });
      }
      if (url.includes("/bot/v3/info")) {
        return new Response(
          JSON.stringify({ code: 0, bot: { open_id: "ou_resolved_bot", app_name: "ResolvedBot" } }),
          { status: 200 },
        );
      }
      return new Response("Forbidden", { status: 403 });
    });

    const connector = createFeishuConnector({
      appId: "cli_1",
      appSecret: "sec_1",
      verificationToken: "vt_secret",
      resolveBotInfoOnStart: true,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const generator = createDefaultContextIdGenerator();
    const receiver = connector.getReceiver();
    await receiver.init?.({
      contextIdGenerator: generator,
      allocateContextId: () => generator.generate("feishu"),
      logger: silentLogger,
      onReceive: async () => ({ sessionId: "sess_ok" }),
    });

    await connector.start();

    // 405 on GET
    expect(
      (await receiver.handleWebhook!(makeWebhookReq(new Uint8Array(0), { method: "GET" }))).status,
    ).toBe(405);

    // 400 on invalid JSON & non-object JSON
    expect(
      (await receiver.handleWebhook!(makeWebhookReq(new TextEncoder().encode("{bad")))).status,
    ).toBe(400);
    expect(
      (await receiver.handleWebhook!(makeWebhookReq(new TextEncoder().encode("[1,2,3]")))).status,
    ).toBe(400);

    // 401 when encrypted body arrives without encryptKey configured
    expect(
      (
        await receiver.handleWebhook!(
          makeWebhookReq(new TextEncoder().encode(JSON.stringify({ encrypt: "abc" }))),
        )
      ).status,
    ).toBe(401);

    // 401 on wrong verification token
    expect(
      (
        await receiver.handleWebhook!(
          makeWebhookReq(
            new TextEncoder().encode(
              JSON.stringify({ type: "url_verification", token: "wrong", challenge: "c" }),
            ),
          ),
        )
      ).status,
    ).toBe(401);

    // 200 ignored on unsupported event type
    const ignoredRes = await receiver.handleWebhook!(
      makeWebhookReq(
        new TextEncoder().encode(
          JSON.stringify({
            schema: "2.0",
            header: { event_type: "im.chat.member.bot.added_v1", token: "vt_secret" },
            event: {},
          }),
        ),
        { headers: { "x-lark-request-timestamp": ["1"] } },
      ),
    );
    expect(ignoredRes.status).toBe(200);
    expect(JSON.parse(String(ignoredRes.body ?? "{}"))).toEqual({
      ok: true,
      accepted: false,
      reason: "unsupported_event_type",
    });

    // Group message mentioning ou_resolved_bot with parent_id whose lookup fails (403) -> falls back gracefully!
    const fallbackRes = await receiver.handleWebhook!(
      makeWebhookReq(
        new TextEncoder().encode(
          JSON.stringify({
            schema: "2.0",
            header: { event_type: "im.message.receive_v1", token: "vt_secret" },
            event: {
              sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
              message: {
                message_id: "om_msg_9",
                parent_id: "om_forbidden_parent",
                chat_id: "oc_grp_9",
                chat_type: "group",
                message_type: "text",
                mentions: [
                  { key: "@_user_1", id: { open_id: "ou_resolved_bot" }, name: "ResolvedBot" },
                ],
                content: '{"text":"@_user_1 status?"}',
              },
            },
          }),
        ),
      ),
    );
    expect(fallbackRes.status).toBe(200);
    expect(JSON.parse(String(fallbackRes.body ?? "{}"))).toEqual({
      ok: true,
      accepted: true,
      sessionId: "sess_ok",
    });

    // 401 on wrong v2.0 event Verification Token
    expect(
      (
        await receiver.handleWebhook!(
          makeWebhookReq(
            new TextEncoder().encode(
              JSON.stringify({
                schema: "2.0",
                header: { event_type: "im.message.receive_v1", token: "bad_token" },
                event: {},
              }),
            ),
          ),
        )
      ).status,
    ).toBe(401);

    // Marker-only text becomes empty after stripping -> accepted: false
    const markerOnlyRes = await receiver.handleWebhook!(
      makeWebhookReq(
        new TextEncoder().encode(
          JSON.stringify({
            schema: "2.0",
            header: { event_type: "im.message.receive_v1", token: "vt_secret" },
            event: {
              sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
              message: {
                message_id: "om_marker_only",
                chat_id: "oc_dm_9",
                chat_type: "p2p",
                message_type: "text",
                content: '{"text":"[#ctx:abc-123]"}',
              },
            },
          }),
        ),
      ),
    );
    expect(JSON.parse(String(markerOnlyRes.body ?? "{}"))).toEqual({
      ok: true,
      accepted: false,
      reason: "empty_or_unsupported_message",
    });

    // 500 when downstream onReceive throws unexpectedly
    await receiver.init?.({
      contextIdGenerator: generator,
      allocateContextId: () => generator.generate("feishu"),
      logger: silentLogger,
      onReceive: async () => {
        throw new Error("downstream boom");
      },
    });
    const err500Res = await receiver.handleWebhook!(
      makeWebhookReq(
        new TextEncoder().encode(
          JSON.stringify({
            schema: "2.0",
            header: { event_type: "im.message.receive_v1", token: "vt_secret" },
            event: {
              sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
              message: {
                message_id: "om_err_500",
                chat_id: "oc_dm_9",
                chat_type: "p2p",
                message_type: "text",
                content: '{"text":"trigger 500"}',
              },
            },
          }),
        ),
      ),
    );
    expect(err500Res.status).toBe(500);

    await connector.stop();
  });
});
