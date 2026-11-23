import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
} from "@dsh-connector/core";
import {
  WeixinAccessTokenManager,
  WeixinApiClient,
  computeWeixinSignature,
  createWeixinConnector,
  decodeEncodingAesKey,
  decryptWeixinCiphertext,
  encryptWeixinPlaintext,
  formatWeixinP2pContextId,
  orderIlinkMessages,
  parseWeixinCallbackBody,
  splitWeixinText,
  weixinReceiveSchema,
  type WeixinReceiveParams,
} from "../src";

type ReceiveSchemaType = typeof weixinReceiveSchema;

const AES_KEY_43 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const APP_ID = "wxba5fad812f8e6fb9";
const TOKEN = "cb_token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function webhookReq(options: {
  method?: string;
  query?: Record<string, string>;
  body?: string;
}): ConnectorWebhookRequest {
  return {
    method: options.method ?? "POST",
    pathname: "/webhooks/weixin",
    subPath: "/",
    query: new URLSearchParams(options.query ?? {}),
    headers: {},
    rawBody: new TextEncoder().encode(options.body ?? ""),
  };
}

describe("Stage 4: Comprehensive edge-case coverage across crypto, xml, chunker, token, api-client, and connector", () => {
  describe("crypto & xml & chunker edge cases", () => {
    it("covers PKCS#7 padding corruption, truncated payloads, invalid random16Bytes, and exact 32-byte block boundary", () => {
      // Exact 32-byte multiple plaintext length triggers full 32-byte PKCS#7 block
      const exactPlaintext = "12345678901234"; // 16 + 4 + 14 + 18 = 52; let's also test 64: 16+4+26+18 = 64!
      const msg26 = "a".repeat(26);
      const c64 = encryptWeixinPlaintext({
        encodingAesKey: AES_KEY_43,
        plaintext: msg26,
        appId: APP_ID,
      });
      expect(
        decryptWeixinCiphertext({
          encodingAesKey: AES_KEY_43,
          cipherTextBase64: c64,
          expectedAppId: APP_ID,
        }).plaintext,
      ).toBe(msg26);
      expect(exactPlaintext.length).toBe(14);

      // Invalid random16Bytes length
      expect(() =>
        encryptWeixinPlaintext({
          encodingAesKey: AES_KEY_43,
          plaintext: "hi",
          appId: APP_ID,
          random16Bytes: new Uint8Array(8),
        }),
      ).toThrow(ConnectorValidationError);

      // Non-AES-block Base64 length (4 Base64 chars = 3 bytes, not multiple of 16)
      expect(() =>
        decryptWeixinCiphertext({
          encodingAesKey: AES_KEY_43,
          cipherTextBase64: "AAAA",
        }),
      ).toThrow(ConnectorValidationError);

      const aesKey = decodeEncodingAesKey(AES_KEY_43);
      const iv = aesKey.subarray(0, 16);

      // Corrupted PKCS#7 padding byte (padLen = 0)
      const cipherZeroPad = createCipheriv("aes-256-cbc", aesKey, iv);
      cipherZeroPad.setAutoPadding(false);
      const zeroPadB64 = Buffer.concat([
        cipherZeroPad.update(Buffer.alloc(32, 0)),
        cipherZeroPad.final(),
      ]).toString("base64");
      expect(() =>
        decryptWeixinCiphertext({
          encodingAesKey: AES_KEY_43,
          cipherTextBase64: zeroPadB64,
        }),
      ).toThrow(ConnectorValidationError);

      // Corrupted PKCS#7 mismatched trailing bytes
      const badPadBlock = Buffer.alloc(32, 5);
      badPadBlock[30] = 9;
      const cipherMismatchPad = createCipheriv("aes-256-cbc", aesKey, iv);
      cipherMismatchPad.setAutoPadding(false);
      const mismatchPadB64 = Buffer.concat([
        cipherMismatchPad.update(badPadBlock),
        cipherMismatchPad.final(),
      ]).toString("base64");
      expect(() =>
        decryptWeixinCiphertext({
          encodingAesKey: AES_KEY_43,
          cipherTextBase64: mismatchPadB64,
        }),
      ).toThrow(ConnectorValidationError);

      // Unpadded payload shorter than 20-byte header
      const shortBuf = Buffer.concat([Buffer.alloc(10, 1), Buffer.alloc(22, 22)]);
      const cipherShort = createCipheriv("aes-256-cbc", aesKey, iv);
      cipherShort.setAutoPadding(false);
      const shortB64 = Buffer.concat([cipherShort.update(shortBuf), cipherShort.final()]).toString(
        "base64",
      );
      expect(() =>
        decryptWeixinCiphertext({
          encodingAesKey: AES_KEY_43,
          cipherTextBase64: shortB64,
        }),
      ).toThrow(ConnectorValidationError);

      // Declared msg_len exceeds buffer bounds
      const overflowHeader = Buffer.alloc(24, 0);
      overflowHeader.writeUInt32BE(9999, 16);
      const overflowPadded = Buffer.concat([overflowHeader, Buffer.alloc(8, 8)]);
      const cipherOverflow = createCipheriv("aes-256-cbc", aesKey, iv);
      cipherOverflow.setAutoPadding(false);
      const overflowB64 = Buffer.concat([
        cipherOverflow.update(overflowPadded),
        cipherOverflow.final(),
      ]).toString("base64");
      expect(() =>
        decryptWeixinCiphertext({
          encodingAesKey: AES_KEY_43,
          cipherTextBase64: overflowB64,
        }),
      ).toThrow(ConnectorValidationError);
    });

    it("covers XML entity edge cases, JSON validation errors, and chunker validation/fence closing", () => {
      const xml = `<xml><Content>&quot;quoted&quot; &apos;single&apos; &#0; &#x110000;</Content></xml>`;
      expect(parseWeixinCallbackBody(xml)).toEqual({
        Content: `"quoted" 'single' &#0; &#x110000;`,
      });

      expect(() => parseWeixinCallbackBody("{bad json", "weixin")).toThrow(
        ConnectorValidationError,
      );
      expect(() => parseWeixinCallbackBody("[1,2,3]", "weixin")).toThrow(ConnectorValidationError);
      expect(parseWeixinCallbackBody('{"Flag":true,"Ignore":[1]}')).toEqual({ Flag: "true" });

      expect(() => splitWeixinText("abc", { maxChars: 10, maxUtf8Bytes: 2 })).toThrow(
        ConnectorValidationError,
      );
      expect(splitWeixinText("")).toEqual([""]);

      // Balanced code fence inside first chunk followed by trailing text
      const balancedMd = "```js\r\nconst a = 1;\r\n```\r\n" + "tail ".repeat(20);
      const parts = splitWeixinText(balancedMd, { maxChars: 50, maxUtf8Bytes: 0 });
      expect(parts.length).toBeGreaterThan(1);
    });
  });

  describe("WeixinAccessTokenManager & WeixinApiClient error branches", () => {
    it("handles static token, custom provider, missing credentials, abort, HTTP errors, invalid JSON, and non-auth errcode", async () => {
      const staticMgr = new WeixinAccessTokenManager({ accessToken: "static_tok" });
      expect(await staticMgr.getAccessToken()).toBe("static_tok");

      const emptyProviderMgr = new WeixinAccessTokenManager({
        connectorName: "weixin",
        accessTokenProvider: () => "   ",
      });
      await expect(emptyProviderMgr.getAccessToken()).rejects.toThrow(ConnectorAuthError);

      const customMgr = new WeixinAccessTokenManager({
        accessTokenProvider: async () => "provided_tok",
      });
      expect(await customMgr.getAccessToken()).toBe("provided_tok");

      const missingCredMgr = new WeixinAccessTokenManager({ appId: APP_ID });
      await expect(missingCredMgr.getAccessToken()).rejects.toThrow(ConnectorValidationError);

      // Pre-aborted signal
      const preAborted = new AbortController();
      preAborted.abort(new Error("user cancelled"));
      const abortMgr = new WeixinAccessTokenManager({
        appId: APP_ID,
        appSecret: "sec",
        fetchFn: vi.fn(),
      });
      await expect(abortMgr.getAccessToken({ signal: preAborted.signal })).rejects.toThrow(
        "user cancelled",
      );

      // Caller abort mid-flight + HTTP 500 + invalid JSON + non-object JSON + empty token + busy errcode -1
      const midAbort = new AbortController();
      const fetchSeq = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(
          (_url, init) =>
            new Promise((_res, rej) => {
              init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
              queueMicrotask(() => midAbort.abort(new Error("mid-flight abort")));
            }),
        )
        .mockResolvedValueOnce(new Response("err", { status: 502 }))
        .mockResolvedValueOnce(new Response("{not-json", { status: 200 }))
        .mockResolvedValueOnce(jsonResponse(["not-object"]))
        .mockResolvedValueOnce(jsonResponse({ access_token: "  " }))
        .mockResolvedValueOnce(jsonResponse({ errcode: -1, errmsg: "system busy" }));

      const errMgr = new WeixinAccessTokenManager({
        connectorName: "weixin",
        appId: APP_ID,
        appSecret: "sec",
        fetchFn: fetchSeq,
      });

      await expect(errMgr.getAccessToken({ signal: midAbort.signal })).rejects.toThrow(
        "mid-flight abort",
      );
      await expect(errMgr.getAccessToken()).rejects.toThrow(ConnectorTransportError);
      await expect(errMgr.getAccessToken()).rejects.toThrow(ConnectorTransportError);
      await expect(errMgr.getAccessToken()).rejects.toThrow(ConnectorTransportError);
      await expect(errMgr.getAccessToken()).rejects.toThrow(ConnectorTransportError);
      await expect(errMgr.getAccessToken()).rejects.toThrow(ConnectorTransportError);
    });

    it("covers WeixinApiClient error branches for both official-account and iLink modes", async () => {
      const noTokenClient = new WeixinApiClient({
        connectorName: "weixin",
        mode: "ilink",
      });
      await expect(
        noTokenClient.sendCustomTextMessage({ openId: "u1", content: "hi" }),
      ).rejects.toThrow(ConnectorValidationError);
      await expect(noTokenClient.ilinkNotifyStart()).rejects.toThrow(ConnectorValidationError);

      // Official API: non-token auth error (48001), rate limit (45009), HTTP 429, invalid JSON, array JSON, string msgid
      const fetchOfficial = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ errcode: 48001, errmsg: "api unauthorized" }))
        .mockResolvedValueOnce(
          jsonResponse({ errcode: 45009, errmsg: "reach max api daily quota" }),
        )
        .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
        .mockResolvedValueOnce(new Response("bad-json", { status: 200 }))
        .mockResolvedValueOnce(jsonResponse([1, 2]))
        .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok", msgid: "str_msg_id" }))
        .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok" }));

      const officialClient = new WeixinApiClient({
        connectorName: "weixin",
        mode: "official-account",
        tokenManager: new WeixinAccessTokenManager({ accessToken: "tok" }),
        fetchFn: fetchOfficial,
      });

      await expect(
        officialClient.sendCustomTextMessage({
          openId: "u1",
          content: "hi",
          businessId: "biz_1",
          aiMsgContext: { turn: 1 },
        }),
      ).rejects.toThrow(ConnectorAuthError);

      await expect(
        officialClient.sendCustomTextMessage({ openId: "u1", content: "hi" }),
      ).rejects.toThrow(ConnectorTransportError);
      await expect(
        officialClient.sendCustomTextMessage({ openId: "u1", content: "hi" }),
      ).rejects.toThrow(ConnectorTransportError);
      await expect(
        officialClient.sendCustomTextMessage({ openId: "u1", content: "hi" }),
      ).rejects.toThrow(ConnectorTransportError);
      await expect(
        officialClient.sendCustomTextMessage({ openId: "u1", content: "hi" }),
      ).rejects.toThrow(ConnectorTransportError);

      const okStrId = await officialClient.sendCustomTextMessage({ openId: "u1", content: "hi" });
      expect(okStrId.messageId).toBe("str_msg_id");

      await officialClient.sendCustomTyping({
        openId: "u1",
        command: "CancelTyping",
        businessId: "biz_1",
      });

      // iLink: stale token (-14), generic failure (-2), ilinkSendTyping, pre-aborted non-Error reason
      const fetchIlink = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ ret: -14 }))
        .mockResolvedValueOnce(jsonResponse({ ret: -2 }))
        .mockResolvedValueOnce(jsonResponse({ ret: 0 }));

      const ilinkClient = new WeixinApiClient({
        connectorName: "weixin",
        mode: "ilink",
        botToken: "bt_1",
        fetchFn: fetchIlink,
      });

      await expect(ilinkClient.ilinkNotifyStart()).rejects.toThrow(ConnectorAuthError);
      await expect(ilinkClient.ilinkGetUpdates({ getUpdatesBuf: "" })).rejects.toThrow(
        ConnectorTransportError,
      );
      expect(
        await ilinkClient.ilinkSendTyping({
          toUserId: "u1",
          typingTicket: "ticket_1",
          status: 1,
        }),
      ).toEqual({ ret: 0 });

      const abortedNonError = new AbortController();
      abortedNonError.abort("plain-reason");
      await expect(ilinkClient.ilinkNotifyStop({ signal: abortedNonError.signal })).rejects.toThrow(
        ConnectorTransportError,
      );
    });
  });

  describe("WeixinConnector webhook error paths, iLink retry/auth/stop branches, and orderIlinkMessages", () => {
    it("covers orderIlinkMessages with string timestamps and unorderable messages", () => {
      expect(orderIlinkMessages([{ message_id: "only_one" }])).toEqual([
        { message_id: "only_one" },
      ]);
      expect(orderIlinkMessages([{ message_id: "a" }, { message_id: "b" }])).toEqual([
        { message_id: "a" },
        { message_id: "b" },
      ]);
      expect(
        orderIlinkMessages([
          { message_id: "second", create_time_ms: "200" },
          { message_id: "first", create_time_ms: "100" },
        ]).map((m) => m.message_id),
      ).toEqual(["first", "second"]);
    });

    it("covers Official Account webhook error responses (400/401) and start/stop no-op", async () => {
      const noAesConnector = createWeixinConnector({
        appId: APP_ID,
        token: TOKEN,
        accessToken: "static_at",
      });
      await noAesConnector.start();
      await noAesConnector.stop();

      const receiver = noAesConnector.getReceiver();
      // Missing timestamp/nonce
      expect((await receiver.handleWebhook!(webhookReq({ query: {} }))).status).toBe(400);
      // Malformed XML
      expect(
        (
          await receiver.handleWebhook!(
            webhookReq({
              query: { timestamp: "1", nonce: "2" },
              body: "not-xml",
            }),
          )
        ).status,
      ).toBe(400);
      // Encrypted callback when encodingAesKey is not configured
      expect(
        (
          await receiver.handleWebhook!(
            webhookReq({
              query: { timestamp: "1", nonce: "2", encrypt_type: "aes" },
              body: "<xml><Encrypt><![CDATA[abc]]></Encrypt></xml>",
            }),
          )
        ).status,
      ).toBe(400);
      // Invalid plaintext signature
      expect(
        (
          await receiver.handleWebhook!(
            webhookReq({
              query: { timestamp: "1", nonce: "2", signature: "bad" },
              body: "<xml><MsgType>text</MsgType><Content>hi</Content></xml>",
            }),
          )
        ).status,
      ).toBe(401);

      const aesConnector = createWeixinConnector({
        appId: APP_ID,
        token: TOKEN,
        encodingAesKey: AES_KEY_43,
        accessToken: "static_at",
      });
      const aesReceiver = aesConnector.getReceiver();

      // Missing Encrypt field when encrypt_type=aes
      expect(
        (
          await aesReceiver.handleWebhook!(
            webhookReq({
              query: { timestamp: "1", nonce: "2", encrypt_type: "aes" },
              body: "<xml><ToUserName>gh</ToUserName></xml>",
            }),
          )
        ).status,
      ).toBe(400);

      // Invalid msg_signature
      expect(
        (
          await aesReceiver.handleWebhook!(
            webhookReq({
              query: {
                timestamp: "1",
                nonce: "2",
                encrypt_type: "aes",
                msg_signature: "bad",
              },
              body: "<xml><Encrypt><![CDATA[AAAA]]></Encrypt></xml>",
            }),
          )
        ).status,
      ).toBe(401);

      // Wrong AppID inside encrypted payload -> 401
      const wrongAppCipher = encryptWeixinPlaintext({
        encodingAesKey: AES_KEY_43,
        plaintext: "<xml><MsgType>text</MsgType><Content>hi</Content></xml>",
        appId: "wx_other_app",
      });
      const validMsgSig = computeWeixinSignature([TOKEN, "1", "2", wrongAppCipher]);
      expect(
        (
          await aesReceiver.handleWebhook!(
            webhookReq({
              query: {
                timestamp: "1",
                nonce: "2",
                encrypt_type: "aes",
                msg_signature: validMsgSig,
              },
              body: `<xml><Encrypt><![CDATA[${wrongAppCipher}]]></Encrypt></xml>`,
            }),
          )
        ).status,
      ).toBe(401);

      // Corrupted ciphertext with valid msg_signature -> 400
      const badCipher = "AAAA";
      const badCipherSig = computeWeixinSignature([TOKEN, "1", "2", badCipher]);
      expect(
        (
          await aesReceiver.handleWebhook!(
            webhookReq({
              query: {
                timestamp: "1",
                nonce: "2",
                encrypt_type: "aes",
                msg_signature: badCipherSig,
              },
              body: `<xml><Encrypt><![CDATA[${badCipher}]]></Encrypt></xml>`,
            }),
          )
        ).status,
      ).toBe(400);
    });

    it("covers iLink webhook 405, transient poll backoff, stale token exit, voice/quote marker, and notifyStop warning", async () => {
      const logger: ConnectorLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const received: Array<{ context: ConnectorContext<"weixin">; params: WeixinReceiveParams }> =
        [];
      let pollStep = 0;

      const fetchFn = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/notifystart")) {
          return jsonResponse({ ret: 0 });
        }
        if (url.pathname.endsWith("/notifystop")) {
          return jsonResponse({ ret: -1 });
        }
        if (url.pathname.endsWith("/getupdates")) {
          pollStep += 1;
          if (pollStep === 1) {
            // Transient failure -> triggers backoff
            throw new Error("transient network glitch");
          }
          if (pollStep === 2) {
            // Deliver voice message with context marker inside quoted message!
            return jsonResponse({
              ret: 0,
              get_updates_buf: "buf_2",
              msgs: [
                {
                  client_id: "voice_c1",
                  from_user_id: "u_voice",
                  to_user_id: "bot_self",
                  message_type: 1,
                  item_list: [
                    {
                      type: 3,
                      voice_item: { text: "语音回答" },
                      ref_msg: {
                        title: "[#ctx:ticket-from-quote]\n原工单标题",
                        message_item: { msg_id: 777 },
                      },
                    },
                  ],
                },
                // Bot user ID match -> ignored
                {
                  client_id: "self_c2",
                  from_user_id: "bot_self",
                  message_type: 1,
                  item_list: [{ type: 1, text_item: { text: "ignore me" } }],
                },
              ],
            });
          }
          // Poll 3: Stale token (-14) -> logs error and exits loop cleanly
          return jsonResponse({ ret: -14 });
        }
        return jsonResponse({ ret: 0 });
      });

      const connector = createWeixinConnector({
        mode: "ilink",
        botToken: "ilink_tok",
        botUserId: "bot_self",
        pollRetryBaseDelayMs: 5,
        pollRetryMaxDelayMs: 10,
        fetchFn,
      });

      // Webhook in ilink mode returns 405
      expect((await connector.getReceiver().handleWebhook!(webhookReq({}))).status).toBe(405);

      const receiverCtx: ConnectorReceiverContext<ReceiveSchemaType, "weixin"> = {
        allocateContextId: () => createConnectorContext(connector, "alloc").contextId,
        contextIdGenerator: {
          generate: () => createConnectorContext(connector, "gen").contextId,
        },
        onReceive: async (context, params) => {
          received.push({ context, params: params as WeixinReceiveParams });
          return { sessionId: "s1" };
        },
        logger,
      };

      await connector.getReceiver().init?.(receiverCtx);
      await connector.start();
      // Idempotent second start() call while running
      await connector.start();

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledTimes(1);
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(1);
      expect(received[0]?.context.contextId).toBe("ticket-from-quote");
      expect(received[0]?.params.msgType).toBe("voice");
      expect(received[0]?.params.quotedMessageId).toBe("777");
      expect(received[0]?.params.quotedText).toBe("原工单标题");

      // stop() handles notifyStop failure gracefully via logger.warn
      await connector.stop();
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("covers token timeout, uninitialized webhook dispatch, marker-only filtering, and iLink stop during backoff", async () => {
      // Token manager timeout branch
      const timeoutTokenMgr = new WeixinAccessTokenManager({
        appId: APP_ID,
        appSecret: "sec",
        timeoutMs: 10,
        fetchFn: (_url, init) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new Error("timed out")));
          }),
      });
      await expect(timeoutTokenMgr.getAccessToken()).rejects.toThrow("timed out");

      // Official webhook before init + empty sender + marker-only content
      const uninitConnector = createWeixinConnector({
        appId: APP_ID,
        token: TOKEN,
        accessToken: "at",
      });
      const validSig = computeWeixinSignature([TOKEN, "10", "20"]);
      expect(
        (
          await uninitConnector.getReceiver().handleWebhook!(
            webhookReq({
              query: { timestamp: "10", nonce: "20", signature: validSig },
              body: "<xml><FromUserName>u1</FromUserName><MsgType>text</MsgType><Content>hi</Content></xml>",
            }),
          )
        ).status,
      ).toBe(200);

      const logger: ConnectorLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      await uninitConnector.getReceiver().init?.({
        allocateContextId: () => createConnectorContext(uninitConnector, "a").contextId,
        contextIdGenerator: {
          generate: () => createConnectorContext(uninitConnector, "g").contextId,
        },
        onReceive: async () => ({ sessionId: "s" }),
        logger,
      });

      // Empty FromUserName & marker-only Content
      for (const xml of [
        "<xml><MsgType>text</MsgType><Content>hi</Content></xml>",
        "<xml><FromUserName>u1</FromUserName><MsgType>text</MsgType><Content>[#ctx:only-marker]</Content><MsgId>m_only</MsgId></xml>",
      ]) {
        expect(
          (
            await uninitConnector.getReceiver().handleWebhook!(
              webhookReq({
                query: { timestamp: "10", nonce: "20", signature: validSig },
                body: xml,
              }),
            )
          ).status,
        ).toBe(200);
      }

      // iLink edge items (missing sender, disallowed sender, missing id, duplicate id, non-text item, marker-only text) + stop() during backoff
      let step = 0;
      const ilinkHolder: { stopNow?: () => Promise<void> } = {};
      const ilinkConnector = createWeixinConnector({
        mode: "ilink",
        botToken: "bt",
        allowedSenderIds: ["allowed_u"],
        pollRetryBaseDelayMs: 5_000,
        pollRetryMaxDelayMs: 5_000,
        fetchFn: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/getupdates")) {
            step += 1;
            if (step === 1) {
              return jsonResponse({
                ret: 0,
                msgs: [
                  { message_type: 1, item_list: [{ type: 1, text_item: { text: "no sender" } }] },
                  {
                    from_user_id: "blocked_u",
                    message_id: "b1",
                    message_type: 1,
                    item_list: [{ type: 1, text_item: { text: "blocked" } }],
                  },
                  {
                    from_user_id: "allowed_u",
                    message_type: 1,
                    item_list: [{ type: 1, text_item: { text: "missing id" } }],
                  },
                  {
                    from_user_id: "allowed_u",
                    message_id: "img_1",
                    message_type: 1,
                    context_token: "ct_1",
                    item_list: [{ type: 2 }],
                  },
                  {
                    from_user_id: "allowed_u",
                    message_id: "img_1",
                    message_type: 1,
                    item_list: [{ type: 1, text_item: { text: "dup" } }],
                  },
                  {
                    from_user_id: "allowed_u",
                    message_id: "marker_1",
                    message_type: 1,
                    context_token: "ct_2",
                    item_list: [{ type: 1, text_item: { text: "[#ctx:m1]" } }],
                  },
                ],
              });
            }
            // Step 2: throw error to enter 5000ms abortableDelay, then trigger stop()!
            queueMicrotask(() => {
              void ilinkHolder.stopNow?.();
            });
            throw new Error("trigger long backoff then abort");
          }
          return jsonResponse({ ret: 0 });
        },
      });
      ilinkHolder.stopNow = () => ilinkConnector.stop();

      await ilinkConnector.getReceiver().init?.({
        allocateContextId: () => createConnectorContext(ilinkConnector, "a").contextId,
        contextIdGenerator: {
          generate: () => createConnectorContext(ilinkConnector, "g").contextId,
        },
        onReceive: async () => ({ sessionId: "s" }),
        logger,
      });
      await ilinkConnector.start();
      await vi.waitFor(() => {
        expect(step).toBe(2);
      });
      await ilinkConnector.stop();
    });

    it("covers HTTP retryable status codes, token error classification, nested code fences, and formatInbound / quote behaviors", async () => {
      expect(() => formatWeixinP2pContextId("   ", "wx-custom")).toThrow(ConnectorValidationError);
      expect(() => splitWeixinText("hello", { maxChars: 2 })).toThrow(ConnectorValidationError);

      const nestedFenceText = ["````ts", "```nested", "`".repeat(3), "x".repeat(30), "````"].join(
        "\n",
      );
      const nestedChunks = splitWeixinText(nestedFenceText, { maxChars: 24, maxUtf8Bytes: 0 });
      expect(nestedChunks.length).toBeGreaterThan(1);

      const tmNetErr = new WeixinAccessTokenManager({
        appId: APP_ID,
        appSecret: "sec",
        fetchFn: async () => {
          throw new Error("socket hang up");
        },
      });
      await expect(tmNetErr.getAccessToken()).rejects.toThrow(
        "Network error while requesting Weixin access_token.",
      );

      const tokenPayloads: unknown[] = [
        { errcode: -1 },
        { errcode: 45009, errmsg: "freq out of limit" },
        { errcode: 50001 },
        { errcode: 0 },
        { access_token: "tok_fallback_ttl" },
      ];
      let tpIdx = 0;
      const tmBranches = new WeixinAccessTokenManager({
        appId: APP_ID,
        appSecret: "sec",
        fetchFn: async () => jsonResponse(tokenPayloads[tpIdx++]!),
      });
      await expect(tmBranches.getAccessToken()).rejects.toMatchObject({ retryable: true });
      await expect(tmBranches.getAccessToken()).rejects.toMatchObject({ retryable: true });
      await expect(tmBranches.getAccessToken()).rejects.toMatchObject({ retryable: false });
      await expect(tmBranches.getAccessToken()).rejects.toThrow("empty access_token");
      await expect(tmBranches.getAccessToken()).resolves.toBe("tok_fallback_ttl");

      let officialCall = 0;
      const officialClient = new WeixinApiClient({
        connectorName: "wx",
        mode: "official-account",
        tokenManager: new WeixinAccessTokenManager({ accessToken: "static_tok" }),
        fetchFn: async () => {
          officialCall += 1;
          if (officialCall === 1) {
            return jsonResponse({ msgid: 987654 });
          }
          if (officialCall === 2) {
            return jsonResponse({ errcode: 45009 });
          }
          if (officialCall === 3) {
            return jsonResponse({}, 429);
          }
          if (officialCall === 4) {
            return jsonResponse({}, 500);
          }
          return jsonResponse({}, 400);
        },
      });

      const numericRes = await officialClient.sendCustomTextMessage({
        openId: "u1",
        content: "hello",
      });
      expect(numericRes.messageId).toBe("987654");
      await expect(
        officialClient.sendCustomTextMessage({ openId: "u1", content: "rate" }),
      ).rejects.toMatchObject({ retryable: true });
      await expect(
        officialClient.sendCustomTextMessage({ openId: "u1", content: "429" }),
      ).rejects.toMatchObject({ retryable: true, statusCode: 429 });
      await expect(
        officialClient.sendCustomTextMessage({ openId: "u1", content: "500" }),
      ).rejects.toMatchObject({ retryable: true, statusCode: 500 });
      await expect(
        officialClient.sendCustomTextMessage({ openId: "u1", content: "400" }),
      ).rejects.toMatchObject({ retryable: false, statusCode: 400 });

      const unordered = [
        { seq: "not-a-number", message_id: "1" },
        { seq: "2", message_id: "2" },
      ];
      expect(orderIlinkMessages(unordered)).toEqual(unordered);

      const receivedOfficial: WeixinReceiveParams[] = [];
      const officialConnector = createWeixinConnector({
        appId: APP_ID,
        token: TOKEN,
        encodingAesKey: AES_KEY_43,
        accessToken: "static_at",
        kfAccount: "kf@acct",
        businessId: "biz_01",
        aiMsgContext: { is_ai_msg: 1 },
        fetchFn: async () => jsonResponse({ errcode: 0, msgid: "m_out" }),
      });

      const fmtCtx = createConnectorContext(officialConnector, "p2p:u1");
      expect(
        officialConnector.getReceiver().formatInbound!(
          {
            mode: "official-account",
            messageId: "m1",
            senderId: "u1",
            msgType: "text",
            text: "plain",
          },
          fmtCtx,
        ),
      ).toEqual({ title: "[Weixin] u1", text: "plain" });
      expect(
        officialConnector.getReceiver().formatInbound!(
          {
            mode: "ilink",
            messageId: "m2",
            senderId: "u1",
            msgType: "text",
            text: "reply",
            quotedText: "line1\nline2",
          },
          fmtCtx,
        ),
      ).toEqual({ title: "[Weixin] u1", text: "> line1\n> line2\n\nreply" });

      await officialConnector.getReceiver().init?.({
        allocateContextId: () => createConnectorContext(officialConnector, "a").contextId,
        contextIdGenerator: {
          generate: () => createConnectorContext(officialConnector, "g").contextId,
        },
        onReceive: async (_ctx, params) => {
          receivedOfficial.push(params as WeixinReceiveParams);
          return { sessionId: "s1" };
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const innerXml = [
        "<xml>",
        "<FromUserName>user_enc</FromUserName>",
        "<CreateTime>not_numeric</CreateTime>",
        "<MsgType>text</MsgType>",
        "<Content>hello metadata</Content>",
        "<MsgDataId>data_99</MsgDataId>",
        "<Idx>1</Idx>",
        "</xml>",
      ].join("");
      const cipher = encryptWeixinPlaintext({
        encodingAesKey: AES_KEY_43,
        plaintext: innerXml,
        appId: APP_ID,
      });
      const msgSig = computeWeixinSignature([TOKEN, "invalid_ts", "n1", cipher]);
      const resp = await officialConnector.getReceiver().handleWebhook!(
        webhookReq({
          query: { timestamp: "invalid_ts", nonce: "n1", msg_signature: msgSig },
          body: `<xml><Encrypt><![CDATA[${cipher}]]></Encrypt></xml>`,
        }),
      );
      expect(resp.status).toBe(200);
      expect(receivedOfficial).toHaveLength(1);
      expect(receivedOfficial[0]).toEqual({
        mode: "official-account",
        messageId: "user_enc:not_numeric",
        senderId: "user_enc",
        msgType: "text",
        text: "hello metadata",
        msgDataId: "data_99",
        idx: "1",
      });
    });
  });
});
