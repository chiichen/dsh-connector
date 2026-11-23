import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import {
  buildEncryptedWeixinReply,
  computeWeixinSignature,
  decodeEncodingAesKey,
  decryptWeixinCiphertext,
  encryptWeixinPlaintext,
  verifyWeixinMsgSignature,
  verifyWeixinSignature,
} from "../src/crypto";
import { parseWeixinCallbackBody } from "../src/xml";
import { WeixinAccessTokenManager } from "../src/token-manager";
import { WeixinApiClient } from "../src/api-client";

const OFFICIAL_DOC_TOKEN = "AAAAA";
const OFFICIAL_DOC_ENCODING_AES_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OFFICIAL_DOC_APP_ID = "wxba5fad812f8e6fb9";
const OFFICIAL_DOC_CIPHERTEXT =
  "+qdx1OKCy+5JPCBFWw70tm0fJGb2Jmeia4FCB7kao+/Q5c/ohsOzQHi8khUOb05JCpj0JB4RvQMkUyus8TPxLKJGQqcvZqzDpVzazhZv6JsXUnnR8XGT740XgXZUXQ7vJVnAG+tE8NUd4yFyjPy7GgiaviNrlCTj+l5kdfMuFUPpRSrfMZuMcp3Fn2Pede2IuQrKEYwKSqFIZoNqJ4M8EajAsjLY2km32IIjdf8YL/P50F7mStwntrA2cPDrM1kb6mOcfBgRtWygb3VIYnSeOBrebufAlr7F9mFUPAJGj04=";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Stage 2: WeChat official signature, AES-256-CBC encryption, XML/JSON parser, token manager, and API client", () => {
  describe("WeChat SHA1 signature & WXBizMsgCrypt AES-256-CBC (official documentation vectors)", () => {
    it("matches official WeChat plaintext signature vector", () => {
      const sig = computeWeixinSignature([OFFICIAL_DOC_TOKEN, "1714037059", "486452656"]);
      expect(sig).toBe("899cf89e464efb63f54ddac96b0a0a235f53aa78");
      expect(
        verifyWeixinSignature(
          OFFICIAL_DOC_TOKEN,
          "1714037059",
          "486452656",
          "899cf89e464efb63f54ddac96b0a0a235f53aa78",
        ),
      ).toBe(true);
      expect(
        verifyWeixinSignature(
          OFFICIAL_DOC_TOKEN,
          "1714037059",
          "486452656",
          "0000000000000000000000000000000000000000",
        ),
      ).toBe(false);
      expect(verifyWeixinSignature(OFFICIAL_DOC_TOKEN, "1714037059", "486452656", "short")).toBe(
        false,
      );
    });

    it("matches official WeChat safe-mode msg_signature and AES-256-CBC decryption vector", () => {
      expect(
        verifyWeixinMsgSignature(
          OFFICIAL_DOC_TOKEN,
          "1714112445",
          "415670741",
          OFFICIAL_DOC_CIPHERTEXT,
          "046e02f8204d34f8ba5fa3b1db94908f3df2e9b3",
        ),
      ).toBe(true);

      const decrypted = decryptWeixinCiphertext({
        encodingAesKey: OFFICIAL_DOC_ENCODING_AES_KEY,
        cipherTextBase64: OFFICIAL_DOC_CIPHERTEXT,
        expectedAppId: OFFICIAL_DOC_APP_ID,
      });

      expect(decrypted.appId).toBe(OFFICIAL_DOC_APP_ID);
      expect(JSON.parse(decrypted.plaintext)).toEqual({
        ToUserName: "gh_97417a04a28d",
        FromUserName: "o9AgO5Kd5ggOC-bXrbNODIiE3bGY",
        CreateTime: 1714112445,
        MsgType: "event",
        Event: "debug_demo",
        debug_str: "hello world",
      });
    });

    it("matches official WeChat safe-mode encryption and reply envelope vector byte-for-byte", () => {
      const random16 = Buffer.from("707722b803182950", "utf8");
      const encrypted = encryptWeixinPlaintext({
        encodingAesKey: OFFICIAL_DOC_ENCODING_AES_KEY,
        plaintext: '{"demo_resp":"good luck"}',
        appId: OFFICIAL_DOC_APP_ID,
        random16Bytes: random16,
      });
      expect(encrypted).toBe(
        "ELGduP2YcVatjqIS+eZbp80MNLoAUWvzzyJxgGzxZO/5sAvd070Bs6qrLARC9nVHm48Y4hyRbtzve1L32tmxSQ==",
      );

      const jsonEnvelope = buildEncryptedWeixinReply({
        token: OFFICIAL_DOC_TOKEN,
        encodingAesKey: OFFICIAL_DOC_ENCODING_AES_KEY,
        appId: OFFICIAL_DOC_APP_ID,
        plaintext: '{"demo_resp":"good luck"}',
        timestamp: 1713424427,
        nonce: "415670741",
        format: "json",
        random16Bytes: random16,
      });
      expect(JSON.parse(jsonEnvelope)).toEqual({
        Encrypt:
          "ELGduP2YcVatjqIS+eZbp80MNLoAUWvzzyJxgGzxZO/5sAvd070Bs6qrLARC9nVHm48Y4hyRbtzve1L32tmxSQ==",
        MsgSignature: "1b9339964ed2e271e7c7b6ff2b0ef902fc94dea1",
        TimeStamp: 1713424427,
        Nonce: "415670741",
      });

      const xmlEnvelope = buildEncryptedWeixinReply({
        token: OFFICIAL_DOC_TOKEN,
        encodingAesKey: OFFICIAL_DOC_ENCODING_AES_KEY,
        appId: OFFICIAL_DOC_APP_ID,
        plaintext: "<xml><Content><![CDATA[hi]]></Content></xml>",
        timestamp: "1713424427",
        nonce: "415670741",
        format: "xml",
      });
      expect(xmlEnvelope).toContain("<Encrypt><![CDATA[");
      expect(xmlEnvelope).toContain("<MsgSignature><![CDATA[");
    });

    it("rejects invalid EncodingAESKey, tampered ciphertext, or mismatched AppID", () => {
      expect(() => decodeEncodingAesKey("too-short")).toThrow(ConnectorValidationError);
      expect(() =>
        decryptWeixinCiphertext({
          encodingAesKey: OFFICIAL_DOC_ENCODING_AES_KEY,
          cipherTextBase64: OFFICIAL_DOC_CIPHERTEXT,
          expectedAppId: "wx_wrong_app_id",
        }),
      ).toThrow(ConnectorAuthError);
      expect(() =>
        decryptWeixinCiphertext({
          encodingAesKey: OFFICIAL_DOC_ENCODING_AES_KEY,
          cipherTextBase64: "not-base64!!!",
        }),
      ).toThrow(ConnectorValidationError);
    });
  });

  describe("parseWeixinCallbackBody (XML & JSON)", () => {
    it("parses standard WeChat XML text message with CDATA and numeric tags", () => {
      const xml = `<xml>
        <ToUserName><![CDATA[gh_97417a04a28d]]></ToUserName>
        <FromUserName><![CDATA[o9AgO5Kd5ggOC-bXrbNODIiE3bGY]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[你好 <world> & friends]]></Content>
        <MsgId>1234567890123456</MsgId>
      </xml>`;
      const parsed = parseWeixinCallbackBody(xml);
      expect(parsed).toEqual({
        ToUserName: "gh_97417a04a28d",
        FromUserName: "o9AgO5Kd5ggOC-bXrbNODIiE3bGY",
        CreateTime: "1348831860",
        MsgType: "text",
        Content: "你好 <world> & friends",
        MsgId: "1234567890123456",
      });
    });

    it("decodes XML character entities in non-CDATA tags and parses JSON callback bodies", () => {
      const xmlEntities = `<xml><MsgType>text</MsgType><Content>A &amp; B &lt;C&gt; &#65; &#x42;</Content></xml>`;
      expect(parseWeixinCallbackBody(xmlEntities)).toEqual({
        MsgType: "text",
        Content: "A & B <C> A B",
      });

      const jsonBody = JSON.stringify({
        ToUserName: "gh_97417a04a28d",
        FromUserName: "oOpenId",
        CreateTime: 1714112445,
        MsgType: "text",
        Content: "json hello",
        MsgId: 99887766,
      });
      expect(parseWeixinCallbackBody(jsonBody)).toEqual({
        ToUserName: "gh_97417a04a28d",
        FromUserName: "oOpenId",
        CreateTime: "1714112445",
        MsgType: "text",
        Content: "json hello",
        MsgId: "99887766",
      });

      expect(() => parseWeixinCallbackBody("   ")).toThrow(ConnectorValidationError);
      expect(() => parseWeixinCallbackBody("plain-invalid-body")).toThrow(ConnectorValidationError);
    });
  });

  describe("WeixinAccessTokenManager", () => {
    it("fetches, caches, coalesces concurrent requests, and force-refreshes via POST /cgi-bin/stable_token", async () => {
      let callCount = 0;
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        callCount += 1;
        expect(String(input)).toBe("https://api.weixin.qq.com/cgi-bin/stable_token");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body["grant_type"]).toBe("client_credential");
        expect(body["appid"]).toBe("wx_app");
        expect(body["secret"]).toBe("sec_123");
        return jsonResponse({
          access_token: `tok_${callCount}_${body["force_refresh"] === true ? "forced" : "normal"}`,
          expires_in: 7200,
        });
      });

      const manager = new WeixinAccessTokenManager({
        appId: "wx_app",
        appSecret: "sec_123",
        fetchFn,
      });

      const [t1, t2] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()]);
      expect(t1).toBe("tok_1_normal");
      expect(t2).toBe("tok_1_normal");
      expect(fetchFn).toHaveBeenCalledTimes(1);

      const t3 = await manager.getAccessToken({ forceRefresh: true });
      expect(t3).toBe("tok_2_forced");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("supports classic GET /cgi-bin/token strategy and maps credential errors to ConnectorAuthError", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ access_token: "classic_tok", expires_in: 7200 }))
        .mockResolvedValueOnce(jsonResponse({ errcode: 40125, errmsg: "invalid appsecret" }));

      const classicMgr = new WeixinAccessTokenManager({
        appId: "wx_app",
        appSecret: "sec_ok",
        tokenStrategy: "classic",
        fetchFn,
      });
      const tok = await classicMgr.getAccessToken();
      expect(tok).toBe("classic_tok");
      const firstUrl = new URL(String(fetchFn.mock.calls[0]?.[0]));
      expect(firstUrl.pathname).toBe("/cgi-bin/token");
      expect(firstUrl.searchParams.get("grant_type")).toBe("client_credential");

      classicMgr.invalidate();
      await expect(classicMgr.getAccessToken()).rejects.toThrow(ConnectorAuthError);
    });
  });

  describe("WeixinApiClient", () => {
    it("sends customer service text via POST /cgi-bin/message/custom/send and retries once on errcode 40001", async () => {
      let tokenVer = 0;
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/cgi-bin/stable_token") {
          tokenVer += 1;
          return jsonResponse({ access_token: `at_${tokenVer}`, expires_in: 7200 });
        }
        if (url.pathname === "/cgi-bin/message/custom/send") {
          const token = url.searchParams.get("access_token");
          if (token === "at_1") {
            return jsonResponse({ errcode: 40001, errmsg: "invalid credential" });
          }
          const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(payload).toEqual({
            touser: "oUserOpenId",
            msgtype: "text",
            text: { content: "你好世界" },
            customservice: { kf_account: "kf1@gh_test" },
          });
          return jsonResponse({ errcode: 0, errmsg: "ok", msgid: 88990011 });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok" });
      });

      const tokenManager = new WeixinAccessTokenManager({
        appId: "wx_app",
        appSecret: "sec",
        fetchFn,
      });
      const client = new WeixinApiClient({
        connectorName: "weixin",
        mode: "official-account",
        tokenManager,
        fetchFn,
      });

      const res = await client.sendCustomTextMessage({
        openId: "oUserOpenId",
        content: "你好世界",
        kfAccount: "kf1@gh_test",
      });
      expect(res.messageId).toBe("88990011");
      expect(tokenVer).toBe(2);

      await client.sendCustomTyping({
        openId: "oUserOpenId",
        command: "Typing",
      });
    });

    it("supports iLink sendTextMessage, getUpdates timeout handling, and retryable transport errors", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ ret: 0 }))
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockImplementationOnce(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("Timed out", "AbortError"));
              });
            }),
        );

      const client = new WeixinApiClient({
        connectorName: "weixin",
        mode: "ilink",
        botToken: "ilink_tok_123",
        fetchFn,
      });

      const sendRes = await client.ilinkSendTextMessage({
        toUserId: "wxid_user_1",
        text: "Hello from iLink",
        contextToken: "ctx_tok_1",
      });
      expect(sendRes.messageId.startsWith("dsh-weixin-")).toBe(true);

      await expect(
        client.ilinkSendTextMessage({
          toUserId: "wxid_user_1",
          text: "Fail network",
        }),
      ).rejects.toThrow(ConnectorTransportError);

      // Long-poll timeout returns empty msgs cleanly without throwing
      const updates = await client.ilinkGetUpdates({
        getUpdatesBuf: "cursor_1",
        timeoutMs: 15,
      });
      expect(updates).toEqual({
        msgs: [],
        getUpdatesBuf: "cursor_1",
      });
    });
  });
});
