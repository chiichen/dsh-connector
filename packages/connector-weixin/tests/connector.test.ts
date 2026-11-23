import { describe, expect, it, vi } from "vitest";
import {
  ConnectorTargetRequiredError,
  ConnectorValidationError,
  createConnectorContext,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import {
  computeWeixinSignature,
  createWeixinConnector,
  encryptWeixinPlaintext,
  type WeixinConnector,
  type WeixinReceiveParams,
  type WeixinStreamingAdapter,
} from "../src";

const TEST_TOKEN = "wx_callback_token";
const TEST_APP_ID = "wxba5fad812f8e6fb9";
const TEST_APP_SECRET = "wx_secret_xyz";
const TEST_ENCODING_AES_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_BOT_GH_ID = "gh_97417a04a28d";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createMockLogger(): ConnectorLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTestReceiverContext<TName extends string = "weixin">(_connectorName: TName) {
  const received: Array<{
    context: ConnectorContext<TName>;
    params: WeixinReceiveParams;
    meta?: InboundDeliveryMeta;
  }> = [];
  const logger = createMockLogger();
  let seq = 0;

  const ctx: ConnectorReceiverContext<typeof import("../src").weixinReceiveSchema, TName> = {
    allocateContextId: () => {
      seq += 1;
      return `alloc-${seq}` as ConnectorContext<TName>["contextId"];
    },
    contextIdGenerator: {
      generate: () => {
        seq += 1;
        return `gen-${seq}` as ConnectorContext<TName>["contextId"];
      },
    },
    onReceive: async (context, params, meta) => {
      const parsedParams = params as WeixinReceiveParams;
      received.push({ context, params: parsedParams, meta });
      return { sessionId: `sess-${received.length}`, deduplicated: false };
    },
    logger,
  };

  return { ctx, received, logger };
}

function buildWebhookReq(options: {
  method?: string;
  query?: Record<string, string>;
  body?: string;
}): ConnectorWebhookRequest {
  const query = new URLSearchParams(options.query ?? {});
  return {
    method: options.method ?? "POST",
    pathname: "/webhooks/weixin",
    subPath: "/",
    query,
    headers: { "content-type": "text/xml" },
    rawBody: new TextEncoder().encode(options.body ?? ""),
  };
}

describe("Stage 3: WeixinConnector end-to-end non-streaming inbound/outbound & streaming extension seam", () => {
  describe("Official Account mode — Webhook verification, decryption, dedup, loop filter, and outbound send", () => {
    it("verifies GET echostr signature and rejects invalid or missing parameters", async () => {
      const connector = createWeixinConnector({
        appId: TEST_APP_ID,
        appSecret: TEST_APP_SECRET,
        token: TEST_TOKEN,
      });
      const receiver = connector.getReceiver();

      const timestamp = "1714037059";
      const nonce = "486452656";
      const echostr = "echo_challenge_987654";
      const validSig = computeWeixinSignature([TEST_TOKEN, timestamp, nonce]);

      const okRes = await receiver.handleWebhook!(
        buildWebhookReq({
          method: "GET",
          query: { signature: validSig, timestamp, nonce, echostr },
        }),
      );
      expect(okRes.status).toBe(200);
      expect(okRes.body).toBe(echostr);

      const badSigRes = await receiver.handleWebhook!(
        buildWebhookReq({
          method: "GET",
          query: {
            signature: "0000000000000000000000000000000000000000",
            timestamp,
            nonce,
            echostr,
          },
        }),
      );
      expect(badSigRes.status).toBe(401);

      const missingRes = await receiver.handleWebhook!(
        buildWebhookReq({
          method: "GET",
          query: { signature: validSig, timestamp },
        }),
      );
      expect(missingRes.status).toBe(400);

      const methodRes = await receiver.handleWebhook!(buildWebhookReq({ method: "DELETE" }));
      expect(methodRes.status).toBe(405);
    });

    it("receives plaintext and AES-256-CBC encrypted XML/JSON messages, deduplicates, filters self-messages, and extracts context markers", async () => {
      const connector = createWeixinConnector({
        appId: TEST_APP_ID,
        appSecret: TEST_APP_SECRET,
        token: TEST_TOKEN,
        encodingAesKey: TEST_ENCODING_AES_KEY,
        accountId: TEST_BOT_GH_ID,
        allowedSenderIds: ["oUserAllowed", TEST_BOT_GH_ID],
      });
      const { ctx, received } = createTestReceiverContext("weixin");
      await connector.getReceiver().init?.(ctx);

      const timestamp = "1714112445";
      const nonce = "415670741";
      const plainSig = computeWeixinSignature([TEST_TOKEN, timestamp, nonce]);

      // 1. Plaintext XML text message
      const xmlBody = `<xml>
        <ToUserName><![CDATA[${TEST_BOT_GH_ID}]]></ToUserName>
        <FromUserName><![CDATA[oUserAllowed]]></FromUserName>
        <CreateTime>${timestamp}</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[第一条明文消息]]></Content>
        <MsgId>10001</MsgId>
      </xml>`;

      const res1 = await connector.getReceiver().handleWebhook!(
        buildWebhookReq({
          method: "POST",
          query: { signature: plainSig, timestamp, nonce },
          body: xmlBody,
        }),
      );
      expect(res1.status).toBe(200);
      expect(res1.body).toBe("success");
      expect(received).toHaveLength(1);
      expect(received[0]?.context.contextId).toBe("p2p:oUserAllowed");
      expect(received[0]?.params.text).toBe("第一条明文消息");
      expect(received[0]?.meta?.idempotencyKey).toBe("10001");

      // 2. Duplicate MsgId 10001 should be ignored
      await connector.getReceiver().handleWebhook!(
        buildWebhookReq({
          method: "POST",
          query: { signature: plainSig, timestamp, nonce },
          body: xmlBody,
        }),
      );
      expect(received).toHaveLength(1);

      // 3. Self-message from bot's own accountId should be filtered out (anti-loop)
      const selfXml = `<xml>
        <ToUserName><![CDATA[oUserAllowed]]></ToUserName>
        <FromUserName><![CDATA[${TEST_BOT_GH_ID}]]></FromUserName>
        <CreateTime>${timestamp}</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[echo loop]]></Content>
        <MsgId>10002</MsgId>
      </xml>`;
      await connector.getReceiver().handleWebhook!(
        buildWebhookReq({
          method: "POST",
          query: { signature: plainSig, timestamp, nonce },
          body: selfXml,
        }),
      );
      expect(received).toHaveLength(1);

      // 4. Disallowed sender should be filtered out
      const strangerXml = `<xml>
        <ToUserName><![CDATA[${TEST_BOT_GH_ID}]]></ToUserName>
        <FromUserName><![CDATA[oStranger]]></FromUserName>
        <CreateTime>${timestamp}</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[hello]]></Content>
        <MsgId>10003</MsgId>
      </xml>`;
      await connector.getReceiver().handleWebhook!(
        buildWebhookReq({
          method: "POST",
          query: { signature: plainSig, timestamp, nonce },
          body: strangerXml,
        }),
      );
      expect(received).toHaveLength(1);

      // 5. Safe-mode AES-256-CBC encrypted callback with context marker & voice recognition
      const markedText = prependContextMarker("语音识别内容", "custom-ticket-42", "bracket");
      const innerVoiceXml = `<xml>
        <ToUserName><![CDATA[${TEST_BOT_GH_ID}]]></ToUserName>
        <FromUserName><![CDATA[oUserAllowed]]></FromUserName>
        <CreateTime>${timestamp}</CreateTime>
        <MsgType><![CDATA[voice]]></MsgType>
        <Recognition><![CDATA[${markedText}]]></Recognition>
        <MsgId>10004</MsgId>
      </xml>`;
      const cipherText = encryptWeixinPlaintext({
        encodingAesKey: TEST_ENCODING_AES_KEY,
        plaintext: innerVoiceXml,
        appId: TEST_APP_ID,
      });
      const msgSig = computeWeixinSignature([TEST_TOKEN, timestamp, nonce, cipherText]);
      const outerEncryptedXml = `<xml>
        <ToUserName><![CDATA[${TEST_BOT_GH_ID}]]></ToUserName>
        <Encrypt><![CDATA[${cipherText}]]></Encrypt>
      </xml>`;

      const encRes = await connector.getReceiver().handleWebhook!(
        buildWebhookReq({
          method: "POST",
          query: {
            timestamp,
            nonce,
            encrypt_type: "aes",
            msg_signature: msgSig,
          },
          body: outerEncryptedXml,
        }),
      );
      expect(encRes.status).toBe(200);
      expect(received).toHaveLength(2);
      expect(received[1]?.context.contextId).toBe("custom-ticket-42");
      expect(received[1]?.params.msgType).toBe("voice");
      expect(received[1]?.params.text).toBe("语音识别内容");

      // 6. Non-message event (e.g. subscribe event) returns 200 "success" without triggering onReceive
      const eventXml = `<xml>
        <ToUserName><![CDATA[${TEST_BOT_GH_ID}]]></ToUserName>
        <FromUserName><![CDATA[oUserAllowed]]></FromUserName>
        <CreateTime>${timestamp}</CreateTime>
        <MsgType><![CDATA[event]]></MsgType>
        <Event><![CDATA[subscribe]]></Event>
      </xml>`;
      const evtRes = await connector.getReceiver().handleWebhook!(
        buildWebhookReq({
          method: "POST",
          query: { signature: plainSig, timestamp, nonce },
          body: eventXml,
        }),
      );
      expect(evtRes.status).toBe(200);
      expect(evtRes.body).toBe("success");
      expect(received).toHaveLength(2);
    });

    it("sends outbound multi-chunk text via message/custom/send, respects 3-tier target resolution, and preserves streaming extension slot", async () => {
      const sentPayloads: Array<Record<string, unknown>> = [];
      let msgSeq = 500;
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/cgi-bin/stable_token") {
          return jsonResponse({ access_token: "stable_at_1", expires_in: 7200 });
        }
        if (url.pathname === "/cgi-bin/message/custom/send") {
          msgSeq += 1;
          sentPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse({ errcode: 0, errmsg: "ok", msgid: msgSeq });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok" });
      });

      const streamingAdapter: WeixinStreamingAdapter = {
        startStream: async (target) => ({
          streamId: "s-1",
          target,
          startedAt: Date.now(),
          chunkSeq: 0,
          messageIds: [],
          typingActive: false,
        }),
        updateStream: async () => undefined,
        completeStream: async () => undefined,
        abortStream: async () => undefined,
      };

      const connector = createWeixinConnector({
        appId: TEST_APP_ID,
        appSecret: TEST_APP_SECRET,
        token: TEST_TOKEN,
        maxMessageChars: 30,
        maxMessageBytes: 100,
        contextMarkerStyle: "bracket",
        streamingAdapter,
        fetchFn,
      });

      expect(connector.getStreamingAdapter()).toBe(streamingAdapter);

      // Bare UUID context without explicit openId must throw ConnectorTargetRequiredError
      const uuidCtx = createConnectorContext(connector, "550e8400-e29b-41d4-a716-446655440000");
      await expect(connector.getSender().send(uuidCtx, { text: "missing target" })).rejects.toThrow(
        ConnectorTargetRequiredError,
      );

      // Structured p2p:<openId> context sends multi-chunk reply cleanly
      const p2pCtx = createConnectorContext(connector, "p2p:oRecipient01");
      const result = await connector.getSender().send(p2pCtx, {
        text: "第一行内容比较长需要切分\n第二行继续发送完整闭环测试",
      });

      expect(result.chunkCount).toBe(2);
      expect(result.openId).toBe("oRecipient01");
      expect(result.messageId).toBe("501");
      expect(result.messageIds).toEqual(["501", "502"]);
      expect(result.mode).toBe("official-account");
      expect(sentPayloads).toHaveLength(2);
      const firstTextObj = sentPayloads[0]!["text"] as Record<string, unknown>;
      expect(String(firstTextObj["content"])).toContain("[#ctx:p2p:oRecipient01]");
    });
  });

  describe("iLink Bot mode — HTTPS long-polling start/stop, ordering, bot filtering, and context_token caching", () => {
    it("polls getUpdates, orders by seq, filters bot messages, caches context_token, and sends outbound reply", async () => {
      const updatesBufHistory: string[] = [];
      const sentBodies: Array<Record<string, unknown>> = [];
      let pollCount = 0;

      const connectorHolder: { instance?: WeixinConnector<"weixin"> } = {};

      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/notifystart") || url.pathname.endsWith("/notifystop")) {
          return jsonResponse({ ret: 0 });
        }
        if (url.pathname.endsWith("/sendmessage")) {
          sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse({ ret: 0 });
        }
        if (url.pathname.endsWith("/getupdates")) {
          pollCount += 1;
          if (pollCount === 1) {
            return jsonResponse({
              ret: 0,
              get_updates_buf: "buf_after_batch_1",
              msgs: [
                // Out-of-order seq=2 with quote reference
                {
                  message_id: "ilink_m2",
                  from_user_id: "wx_user_a",
                  message_type: 1,
                  seq: 2,
                  create_time_ms: 1714112450000,
                  context_token: "ctx_tok_latest",
                  item_list: [
                    {
                      type: 1,
                      text_item: { text: "第二条跟进问题" },
                      ref_msg: {
                        message_item: {
                          msg_id: "ilink_m0",
                          type: 1,
                          text_item: { text: "之前引用的上下文" },
                        },
                      },
                    },
                  ],
                },
                // Bot self message (message_type = 2) -> must be ignored!
                {
                  message_id: "ilink_bot_echo",
                  from_user_id: "wx_user_a",
                  message_type: 2,
                  seq: 1,
                  item_list: [{ type: 1, text_item: { text: "bot own reply" } }],
                },
                // Earlier seq=1 user message
                {
                  message_id: "ilink_m1",
                  from_user_id: "wx_user_a",
                  message_type: 1,
                  seq: 1,
                  create_time_ms: 1714112440000,
                  context_token: "ctx_tok_older",
                  item_list: [{ type: 1, text_item: { text: "第一条用户提问" } }],
                },
              ],
            });
          }

          // Block second poll until connector.stop() aborts the signal
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
            queueMicrotask(() => {
              void connectorHolder.instance?.stop();
            });
          });
        }
        return jsonResponse({ ret: 0 });
      });

      const connector = createWeixinConnector({
        mode: "ilink",
        botToken: "ilink_bot_secret",
        onUpdatesBufChange: (buf) => {
          updatesBufHistory.push(buf);
        },
        fetchFn,
      });
      connectorHolder.instance = connector;

      const { ctx, received } = createTestReceiverContext("weixin");
      await connector.getReceiver().init?.(ctx);
      await connector.start();

      // Wait briefly for poll iteration 1 -> stop() in iteration 2 to settle
      await vi.waitFor(() => {
        expect(received).toHaveLength(2);
      });

      // Messages should have been processed in seq order: ilink_m1 then ilink_m2!
      expect(received[0]?.params.messageId).toBe("ilink_m1");
      expect(received[0]?.params.text).toBe("第一条用户提问");
      expect(received[1]?.params.messageId).toBe("ilink_m2");
      expect(received[1]?.params.quotedText).toBe("之前引用的上下文");
      expect(updatesBufHistory).toEqual(["buf_after_batch_1"]);

      // formatInbound includes quoted text block when present
      const formatted = connector.getReceiver().formatInbound!(
        received[1]!.params,
        received[1]!.context,
      );
      expect(typeof formatted === "object" ? formatted.text : formatted).toContain(
        "> 之前引用的上下文",
      );

      // Outbound send to p2p:wx_user_a automatically reuses the latest cached context_token!
      const sendRes = await connector.getSender().send(received[1]!.context, {
        text: "收到，已处理完毕！",
      });
      expect(sendRes.mode).toBe("ilink");
      expect(sendRes.contextToken).toBe("ctx_tok_latest");
      const sentMsgObj = sentBodies[0]?.["msg"] as Record<string, unknown>;
      expect(sentMsgObj["to_user_id"]).toBe("wx_user_a");
      expect(sentMsgObj["context_token"]).toBe("ctx_tok_latest");

      await connector.stop();
    });

    it("validates connector options on construction", () => {
      expect(() =>
        createWeixinConnector({
          appId: "",
          token: TEST_TOKEN,
        }),
      ).toThrow(ConnectorValidationError);

      expect(() =>
        createWeixinConnector({
          mode: "ilink",
          botToken: "   ",
        }),
      ).toThrow(ConnectorValidationError);
    });
  });
});
