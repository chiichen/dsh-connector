import { describe, expect, it, vi } from "vitest";
import {
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  type ConnectorContext,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
} from "@dsh-connector/core";
import {
  CARDKIT_MAX_INT32_SEQUENCE,
  DEFAULT_FEISHU_CONNECTOR_NAME,
  FEISHU_NONCE_HEADER,
  FEISHU_SIGNATURE_HEADER,
  FEISHU_TIMESTAMP_HEADER,
  FeishuWsFragmentAssembler,
  buildStreamingCardJsonV2,
  computeFeishuEventSignature,
  createFeishuConnector,
  decodePbbp2Frame,
  encodePbbp2Frame,
  encryptFeishuPayload,
  nextCardKitSequence,
  type FeishuInboundMessage,
  type FeishuPbbp2Frame,
  type FeishuStreamHandle,
  type FeishuStreamingAdapter,
  type FeishuWebSocketLike,
} from "../src/index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function buildWebhookReq(options: {
  method?: string;
  bodyObj?: unknown;
  rawBodyText?: string;
  headers?: Record<string, string>;
}): ConnectorWebhookRequest {
  const text = options.rawBodyText ?? JSON.stringify(options.bodyObj ?? {});
  return {
    method: options.method ?? "POST",
    pathname: "/webhooks/connectors/feishu",
    subPath: "",
    query: new URLSearchParams(),
    headers: options.headers ?? {},
    rawBody: new TextEncoder().encode(text),
  };
}

function createSignedEncryptedWebhookReq(
  payload: unknown,
  encryptKey: string,
  timestamp = "1700000100",
  nonce = "nonce-xyz",
): ConnectorWebhookRequest {
  const encrypted = encryptFeishuPayload(JSON.stringify(payload), encryptKey);
  const rawBodyText = JSON.stringify({ encrypt: encrypted });
  const rawBody = new TextEncoder().encode(rawBodyText);
  const signature = computeFeishuEventSignature(timestamp, nonce, encryptKey, rawBody);
  return {
    method: "POST",
    pathname: "/webhooks/connectors/feishu",
    subPath: "",
    query: new URLSearchParams(),
    headers: {
      [FEISHU_TIMESTAMP_HEADER]: timestamp,
      [FEISHU_NONCE_HEADER]: nonce,
      [FEISHU_SIGNATURE_HEADER]: signature,
    },
    rawBody,
  };
}

function createMockReceiverContext() {
  const idGen = createDefaultContextIdGenerator();
  const received: Array<{
    context: ConnectorContext<"feishu">;
    params: FeishuInboundMessage;
    idempotencyKey: string | undefined;
  }> = [];

  const ctx: ConnectorReceiverContext<
    ReturnType<typeof createFeishuConnector>["getReceiver"] extends () => infer R
      ? R extends { schema: infer S }
        ? S
        : never
      : never,
    "feishu"
  > = {
    allocateContextId: () => idGen.generate(DEFAULT_FEISHU_CONNECTOR_NAME),
    contextIdGenerator: idGen,
    onReceive: async (context, params, meta) => {
      received.push({
        context,
        params: params as FeishuInboundMessage,
        idempotencyKey: meta?.idempotencyKey,
      });
      return { sessionId: `session-${received.length}`, deduplicated: false };
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

class MockWebSocket implements FeishuWebSocketLike {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  readonly url: string;
  readonly sentFrames: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: Uint8Array): void {
    this.sentFrames.push(new Uint8Array(data));
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: 1000 });
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  emitBinaryMessage(bytes: Uint8Array): void {
    this.emit("message", {
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  emitError(message = "ws error"): void {
    this.emit("error", { error: new Error(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("Stage 3: Feishu Webhook v2.0, WebSocket long connection, @mention/loop filtering, and streaming seam", () => {
  describe("Webhook v2.0 url_verification, encryption, and signature security", () => {
    it("handles plaintext and encrypted url_verification challenges and rejects invalid tokens", async () => {
      const connector = createFeishuConnector({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        verificationToken: "verify_tok_1",
      });
      const { ctx } = createMockReceiverContext();
      const receiver = connector.getReceiver();
      await receiver.init?.(ctx);

      const okRes = await receiver.handleWebhook!(
        buildWebhookReq({
          bodyObj: {
            type: "url_verification",
            token: "verify_tok_1",
            challenge: "challenge_abc_999",
          },
        }),
      );
      expect(okRes.status).toBe(200);
      expect(JSON.parse(String(okRes.body))).toEqual({ challenge: "challenge_abc_999" });

      const badTokRes = await receiver.handleWebhook!(
        buildWebhookReq({
          bodyObj: {
            type: "url_verification",
            token: "wrong_tok",
            challenge: "challenge_abc_999",
          },
        }),
      );
      expect(badTokRes.status).toBe(401);

      // Encrypted url_verification without X-Lark-Signature (per official Feishu docs)
      const encryptedConnector = createFeishuConnector({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        encryptKey: "enc_secret_key",
        verificationToken: "verify_tok_2",
      });
      const encReceiver = encryptedConnector.getReceiver();
      await encReceiver.init?.(ctx);

      const encChallenge = encryptFeishuPayload(
        JSON.stringify({
          type: "url_verification",
          token: "verify_tok_2",
          challenge: "enc_challenge_777",
        }),
        "enc_secret_key",
      );
      const encOkRes = await encReceiver.handleWebhook!(
        buildWebhookReq({ bodyObj: { encrypt: encChallenge } }),
      );
      expect(encOkRes.status).toBe(200);
      expect(JSON.parse(String(encOkRes.body))).toEqual({ challenge: "enc_challenge_777" });
    });

    it("enforces X-Lark-Signature and encrypted envelope on event webhooks when encryptKey is configured", async () => {
      const encryptKey = "prod_encrypt_key";
      const connector = createFeishuConnector({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        encryptKey,
        verificationToken: "v_tok",
      });
      const { ctx, received } = createMockReceiverContext();
      const receiver = connector.getReceiver();
      await receiver.init?.(ctx);

      const validEvent = {
        schema: "2.0",
        header: {
          event_id: "ev_1001",
          event_type: "im.message.receive_v1",
          token: "v_tok",
          create_time: "1700000100000",
        },
        event: {
          sender: {
            sender_type: "user",
            sender_id: { open_id: "ou_user_alice" },
          },
          message: {
            message_id: "om_msg_1001",
            chat_id: "oc_p2p_alice",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "Hello via encrypted webhook!" }),
          },
        },
      };

      // Valid signed + encrypted event -> 200 & triggers onReceive
      const validReq = createSignedEncryptedWebhookReq(validEvent, encryptKey);
      const okRes = await receiver.handleWebhook!(validReq);
      expect(okRes.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.context.contextId).toBe("p2p:ou_user_alice");
      expect(received[0]?.params.text).toBe("Hello via encrypted webhook!");
      expect(received[0]?.idempotencyKey).toBe("om_msg_1001");

      // Tampered signature -> 401
      const badSigReq: ConnectorWebhookRequest = {
        ...validReq,
        headers: { ...validReq.headers, [FEISHU_SIGNATURE_HEADER]: "0".repeat(64) },
      };
      expect((await receiver.handleWebhook!(badSigReq)).status).toBe(401);

      // Plaintext bypass attempt when encryptKey is configured -> 401
      expect((await receiver.handleWebhook!(buildWebhookReq({ bodyObj: validEvent }))).status).toBe(
        401,
      );

      // Non-POST -> 405, invalid JSON -> 400
      expect((await receiver.handleWebhook!(buildWebhookReq({ method: "GET" }))).status).toBe(405);
      expect(
        (await receiver.handleWebhook!(buildWebhookReq({ rawBodyText: "{bad-json" }))).status,
      ).toBe(400);
    });
  });

  describe("Bot self-message filtering, p2p/group @mention gating, post/card parsing, and parent context marker resolution", () => {
    it("filters bot self-messages, enforces group @bot mention gating, and extracts post/card text", async () => {
      const connector = createFeishuConnector({
        appId: "cli_bot_app_id",
        appSecret: "sec_123",
        botOpenId: "ou_bot_self",
        allowedOpenIds: ["ou_allowed_1", "ou_allowed_2"],
      });
      const { ctx, received } = createMockReceiverContext();
      const receiver = connector.getReceiver();
      await receiver.init?.(ctx);

      const postEvent = (eventOverride: Record<string, unknown>) =>
        receiver.handleWebhook!(
          buildWebhookReq({
            bodyObj: {
              schema: "2.0",
              header: {
                event_id: `ev_${Math.random()}`,
                event_type: "im.message.receive_v1",
              },
              event: eventOverride,
            },
          }),
        );

      // 1. Bot self-message (sender_type: "app") -> ignored
      await postEvent({
        sender: { sender_type: "app", sender_id: { open_id: "ou_allowed_1" } },
        message: {
          message_id: "om_bot_1",
          chat_id: "oc_p2p_1",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"I am a bot"}',
        },
      });
      expect(received).toHaveLength(0);

      // 2. Bot self-message by open_id match -> ignored
      await postEvent({
        sender: { sender_type: "user", sender_id: { open_id: "ou_bot_self" } },
        message: {
          message_id: "om_bot_2",
          chat_id: "oc_p2p_1",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"Echo"}',
        },
      });
      expect(received).toHaveLength(0);

      // 3. Disallowed sender -> ignored
      await postEvent({
        sender: { sender_type: "user", sender_id: { open_id: "ou_stranger" } },
        message: {
          message_id: "om_stranger",
          chat_id: "oc_p2p_2",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"Hi"}',
        },
      });
      expect(received).toHaveLength(0);

      // 4. Group message WITHOUT @bot (mentions another human only) -> ignored
      await postEvent({
        sender: { sender_type: "user", sender_id: { open_id: "ou_allowed_1" } },
        message: {
          message_id: "om_grp_unmentioned",
          chat_id: "oc_grp_1",
          chat_type: "group",
          message_type: "text",
          content: '{"text":"@_user_1 check this"}',
          mentions: [{ key: "@_user_1", id: { open_id: "ou_other_human" }, name: "Bob" }],
        },
      });
      expect(received).toHaveLength(0);

      // 5. Group message with @_all only -> ignored by default
      await postEvent({
        sender: { sender_type: "user", sender_id: { open_id: "ou_allowed_1" } },
        message: {
          message_id: "om_grp_at_all",
          chat_id: "oc_grp_1",
          chat_type: "group",
          message_type: "text",
          content: '{"text":"@_all announcement"}',
          mentions: [{ key: "@_all", id: { open_id: "" }, name: "All" }],
        },
      });
      expect(received).toHaveLength(0);

      // 6. Group topic message mentioning @bot AND @Bob -> accepted, strips @bot key, preserves @Bob!
      await postEvent({
        sender: { sender_type: "user", sender_id: { open_id: "ou_allowed_1" } },
        message: {
          message_id: "om_grp_mentioned",
          root_id: "om_topic_root",
          thread_id: "omt_topic_1",
          chat_id: "oc_grp_1",
          chat_type: "group",
          message_type: "text",
          content: '{"text":"@_user_1 please review with @_user_2"}',
          mentions: [
            { key: "@_user_1", id: { open_id: "ou_bot_self" }, name: "DSHBot" },
            { key: "@_user_2", id: { open_id: "ou_bob" }, name: "Bob" },
          ],
        },
      });
      expect(received).toHaveLength(1);
      expect(received[0]?.context.contextId).toBe("group:oc_grp_1:topic:om_topic_root");
      expect(received[0]?.params.text).toBe("please review with @Bob");
      expect(received[0]?.params.mentionedBot).toBe(true);

      // 7. Rich text 'post' & 'interactive' card inbound messages in p2p
      await postEvent({
        sender: { sender_type: "user", sender_id: { open_id: "ou_allowed_2" } },
        message: {
          message_id: "om_post_1",
          chat_id: "oc_p2p_2",
          chat_type: "p2p",
          message_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "Deploy Report",
              content: [[{ tag: "text", text: "All pods healthy." }]],
            },
          }),
        },
      });
      expect(received).toHaveLength(2);
      expect(received[1]?.params.text).toBe("Deploy Report\nAll pods healthy.");

      const formattedPrompt = receiver.formatInbound?.(received[1]!.params, received[1]!.context);
      expect(
        typeof formattedPrompt === "object" ? formattedPrompt.text : formattedPrompt,
      ).toContain("All pods healthy.");
    });

    it("correlates replies to outbound-first messages by fetching parent_id message marker", async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
          return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-tok", expire: 7200 });
        }
        if (url.endsWith("/open-apis/im/v1/messages/om_proactive_bot_msg")) {
          return jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              items: [
                {
                  message_id: "om_proactive_bot_msg",
                  msg_type: "text",
                  chat_id: "oc_p2p_user",
                  body: {
                    content: JSON.stringify({
                      text: "[#ctx:550e8400-e29b-41d4-a716-446655440000]\nBuild failed, retry?",
                    }),
                  },
                },
              ],
            },
          });
        }
        return jsonResponse({ code: 99991672, msg: "missing scope" }, 403);
      });

      const connector = createFeishuConnector({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        fetchFn: fetchMock,
      });
      const { ctx, received } = createMockReceiverContext();
      const receiver = connector.getReceiver();
      await receiver.init?.(ctx);

      // User replies to om_proactive_bot_msg -> parent lookup extracts UUID contextId!
      await receiver.handleWebhook!(
        buildWebhookReq({
          bodyObj: {
            schema: "2.0",
            header: { event_id: "ev_reply_1", event_type: "im.message.receive_v1" },
            event: {
              sender: { sender_type: "user", sender_id: { open_id: "ou_user_1" } },
              message: {
                message_id: "om_user_reply_1",
                parent_id: "om_proactive_bot_msg",
                chat_id: "oc_p2p_user",
                chat_type: "p2p",
                message_type: "text",
                content: '{"text":"Yes, please retry!"}',
              },
            },
          },
        }),
      );

      expect(received).toHaveLength(1);
      expect(received[0]?.context.contextId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(received[0]?.params.text).toBe("Yes, please retry!");

      // When parent lookup fails (e.g. missing im:message:readonly scope), gracefully falls back to p2p:ou_user_1
      await receiver.handleWebhook!(
        buildWebhookReq({
          bodyObj: {
            schema: "2.0",
            header: { event_id: "ev_reply_2", event_type: "im.message.receive_v1" },
            event: {
              sender: { sender_type: "user", sender_id: { open_id: "ou_user_1" } },
              message: {
                message_id: "om_user_reply_2",
                parent_id: "om_unreadable_parent",
                chat_id: "oc_p2p_user",
                chat_type: "p2p",
                message_type: "text",
                content: '{"text":"Fallback works!"}',
              },
            },
          },
        }),
      );
      expect(received).toHaveLength(2);
      expect(received[1]?.context.contextId).toBe("p2p:ou_user_1");
    });
  });

  describe("WebSocket long-connection protocol (pbbp2 binary codec, fragmentation, and client lifecycle)", () => {
    it("encodes, decodes, and reassembles fragmented pbbp2 binary frames", () => {
      const frame: FeishuPbbp2Frame = {
        seqId: 101,
        logId: 202,
        service: 77,
        method: 1,
        headers: [
          { key: "type", value: "event" },
          { key: "message_id", value: "msg_frag_1" },
        ],
        payloadEncoding: "utf8",
        payloadType: "application/json",
        payload: new TextEncoder().encode('{"hello":"feishu"}'),
        logIdNew: "trace_new_1",
      };

      const encoded = encodePbbp2Frame(frame);
      const decoded = decodePbbp2Frame(encoded);
      expect(decoded.seqId).toBe(101);
      expect(decoded.logId).toBe(202);
      expect(decoded.service).toBe(77);
      expect(decoded.method).toBe(1);
      expect(decoded.headers).toEqual(frame.headers);
      expect(decoded.payloadEncoding).toBe("utf8");
      expect(decoded.payloadType).toBe("application/json");
      expect(new TextDecoder().decode(decoded.payload)).toBe('{"hello":"feishu"}');
      expect(decoded.logIdNew).toBe("trace_new_1");

      const assembler = new FeishuWsFragmentAssembler();
      const fullBytes = new TextEncoder().encode('{"part1":"abc","part2":"def"}');
      const half = Math.floor(fullBytes.length / 2);

      expect(
        assembler.push({
          messageId: "m1",
          sum: 2,
          seq: 1,
          chunk: fullBytes.subarray(half),
        }),
      ).toBeUndefined();

      const merged = assembler.push({
        messageId: "m1",
        sum: 2,
        seq: 0,
        chunk: fullBytes.subarray(0, half),
      });
      expect(merged).toBeDefined();
      expect(JSON.parse(new TextDecoder().decode(merged!))).toEqual({
        part1: "abc",
        part2: "def",
      });
    });

    it("connects via POST /callback/ws/endpoint, handles ping/pong and fragmented event frames, and sends ack frames", async () => {
      const createdSockets: MockWebSocket[] = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/callback/ws/endpoint")) {
          return jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              URL: "wss://msg-frontier.feishu.cn/ws/v2?device_id=dev_1&service_id=88",
              ClientConfig: {
                PingInterval: 60,
                ReconnectCount: 2,
                ReconnectInterval: 10,
                ReconnectNonce: 0,
              },
            },
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const connector = createFeishuConnector({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        mode: "websocket",
        wsAutoReconnect: false,
        fetchFn: fetchMock,
        createWebSocket: (url) => {
          const sock = new MockWebSocket(url);
          createdSockets.push(sock);
          queueMicrotask(() => sock.emitOpen());
          return sock;
        },
      });

      const { ctx, received } = createMockReceiverContext();
      await connector.getReceiver().init?.(ctx);
      await connector.start();

      expect(createdSockets).toHaveLength(1);
      const sock = createdSockets[0]!;
      expect(sock.url).toContain("service_id=88");

      // Initial ping frame sent upon open
      expect(sock.sentFrames.length).toBeGreaterThanOrEqual(1);
      const pingFrame = decodePbbp2Frame(sock.sentFrames[0]!);
      expect(pingFrame.method).toBe(0);
      expect(pingFrame.service).toBe(88);
      expect(pingFrame.headers).toContainEqual({ key: "type", value: "ping" });

      // Server sends pong control frame
      sock.emitBinaryMessage(
        encodePbbp2Frame({
          seqId: 1,
          logId: 1,
          service: 88,
          method: 0,
          headers: [{ key: "type", value: "pong" }],
          payload: new TextEncoder().encode(
            JSON.stringify({
              PingInterval: 120,
              ReconnectCount: 3,
              ReconnectInterval: 15,
              ReconnectNonce: 5,
            }),
          ),
        }),
      );

      // Server pushes 2-part fragmented im.message.receive_v1 event frame
      const eventBytes = new TextEncoder().encode(
        JSON.stringify({
          schema: "2.0",
          header: {
            event_id: "ev_ws_1",
            event_type: "im.message.receive_v1",
          },
          event: {
            sender: { sender_type: "user", sender_id: { open_id: "ou_ws_user" } },
            message: {
              message_id: "om_ws_msg_1",
              chat_id: "oc_ws_p2p",
              chat_type: "p2p",
              message_type: "text",
              content: '{"text":"Hello over WebSocket long connection!"}',
            },
          },
        }),
      );
      const mid = Math.floor(eventBytes.length / 2);

      sock.emitBinaryMessage(
        encodePbbp2Frame({
          seqId: 10,
          logId: 20,
          service: 88,
          method: 1,
          headers: [
            { key: "type", value: "event" },
            { key: "message_id", value: "ws_pkt_1" },
            { key: "sum", value: "2" },
            { key: "seq", value: "0" },
          ],
          payload: eventBytes.subarray(0, mid),
        }),
      );
      sock.emitBinaryMessage(
        encodePbbp2Frame({
          seqId: 10,
          logId: 20,
          service: 88,
          method: 1,
          headers: [
            { key: "type", value: "event" },
            { key: "message_id", value: "ws_pkt_1" },
            { key: "sum", value: "2" },
            { key: "seq", value: "1" },
          ],
          payload: eventBytes.subarray(mid),
        }),
      );

      // Allow async event handler & ack frame write to complete
      await vi.waitFor(() => {
        expect(received).toHaveLength(1);
        expect(sock.sentFrames.length).toBeGreaterThanOrEqual(2);
      });

      expect(received[0]?.context.contextId).toBe("p2p:ou_ws_user");
      expect(received[0]?.params.text).toBe("Hello over WebSocket long connection!");

      const ackFrame = decodePbbp2Frame(sock.sentFrames[sock.sentFrames.length - 1]!);
      expect(ackFrame.seqId).toBe(10);
      expect(ackFrame.headers.some((h) => h.key === "biz_rt")).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(ackFrame.payload))).toEqual({ code: 200 });

      await connector.stop();
      expect(sock.readyState).toBe(MockWebSocket.CLOSED);
    });
  });

  describe("Reserved Streaming Extension Seam (CardKit v1 & im/v1/messages PATCH)", () => {
    it("exposes strongly-typed streaming extension slots without affecting non-streaming operation", async () => {
      const defaultConnector = createFeishuConnector({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
      });
      expect(defaultConnector.getStreamingAdapter()).toBeUndefined();

      expect(nextCardKitSequence(0)).toBe(1);
      expect(nextCardKitSequence(41)).toBe(42);
      expect(() => nextCardKitSequence(CARDKIT_MAX_INT32_SEQUENCE)).toThrow(
        ConnectorValidationError,
      );
      expect(() => nextCardKitSequence(-1)).toThrow(ConnectorValidationError);

      const cardJsonStr = buildStreamingCardJsonV2({
        initialContent: "Thinking...",
        title: "Assistant",
        elementId: "md_stream",
      });
      const parsedCard = JSON.parse(cardJsonStr) as Record<string, unknown>;
      expect(parsedCard["schema"]).toBe("2.0");

      const mockAdapter: FeishuStreamingAdapter<"feishu"> = {
        strategy: "cardkit-v1",
        async startStream(_ctx, input): Promise<FeishuStreamHandle> {
          return {
            streamId: "stream_1",
            strategy: "cardkit-v1",
            messageId: "om_card_msg_1",
            cardId: "card_ent_1",
            elementId: input.elementId ?? "markdown_stream_1",
            sequence: 1,
          };
        },
        async updateStream(handle): Promise<FeishuStreamHandle> {
          return { ...handle, sequence: nextCardKitSequence(handle.sequence) };
        },
        async completeStream(handle): Promise<FeishuStreamHandle> {
          return { ...handle, sequence: nextCardKitSequence(handle.sequence) };
        },
        async abortStream(): Promise<void> {},
      };

      const streamingReadyConnector = createFeishuConnector({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        streaming: {
          adapter: mockAdapter,
          preferredStrategy: "cardkit-v1",
        },
      });

      const adapter = streamingReadyConnector.getStreamingAdapter();
      expect(adapter).toBe(mockAdapter);

      const ctx = createConnectorContext("feishu", "p2p:ou_user_1");
      const h1 = await adapter!.startStream(ctx, {
        target: { mode: "send", receiveIdType: "open_id", receiveId: "ou_user_1" },
        initialText: "Step 1",
      });
      const h2 = await adapter!.updateStream(h1, { content: "Step 1 + Step 2" });
      const h3 = await adapter!.completeStream(h2, { finalContent: "Done" });
      expect(h3.sequence).toBe(3);
    });
  });
});
