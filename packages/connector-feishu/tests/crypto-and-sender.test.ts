import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
} from "@dsh-connector/core";
import {
  DEFAULT_FEISHU_CONNECTOR_NAME,
  FeishuApiClient,
  computeFeishuEventSignature,
  createFeishuSender,
  decryptFeishuPayload,
  encryptFeishuPayload,
  verifyFeishuEventSignature,
  verifyFeishuVerificationToken,
} from "../src/index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("Stage 2: Feishu webhook crypto, tenant_access_token lifecycle, and REST outbound Sender", () => {
  describe("Webhook signature verification & AES-256-CBC decryption", () => {
    it("decrypts the official Feishu Open Platform test vector accurately", () => {
      // Official open.feishu.cn sample vector: key = "test key" -> "hello world"
      const decrypted = decryptFeishuPayload(
        "P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=",
        "test key",
      );
      expect(decrypted).toBe("hello world");
    });

    it("round-trips arbitrary UTF-8 JSON payloads with AES-256-CBC and rejects malformed ciphertexts", () => {
      const key = "feishu-encrypt-secret-2026";
      const original = JSON.stringify({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        text: "你好，飞书 🚀",
      });
      const iv = new Uint8Array(16).fill(7);
      const encrypted = encryptFeishuPayload(original, key, iv);
      expect(decryptFeishuPayload(encrypted, key)).toBe(original);

      // Wrong key fails decryption
      expect(() => decryptFeishuPayload(encrypted, "wrong-key")).toThrow(ConnectorAuthError);
      // Too short (< 32 bytes)
      expect(() => decryptFeishuPayload(Buffer.from("short").toString("base64"), key)).toThrow(
        ConnectorAuthError,
      );
      // Non-block-aligned ciphertext
      expect(() => decryptFeishuPayload(Buffer.alloc(33, 1).toString("base64"), key)).toThrow(
        ConnectorAuthError,
      );
      // Empty key validation
      expect(() => decryptFeishuPayload(encrypted, "")).toThrow(ConnectorValidationError);
    });

    it("computes and verifies X-Lark-Signature in constant time over raw request bytes", () => {
      const timestamp = "1700000000";
      const nonce = "nonce-abc-123";
      const encryptKey = "my-encrypt-key";
      const rawBody = new TextEncoder().encode('{"encrypt":"cipher-payload"}');

      const expectedSig = computeFeishuEventSignature(timestamp, nonce, encryptKey, rawBody);
      expect(expectedSig).toMatch(/^[0-9a-f]{64}$/);

      expect(
        verifyFeishuEventSignature({
          timestamp,
          nonce,
          encryptKey,
          rawBody,
          signature: expectedSig,
        }),
      ).toBe(true);

      expect(
        verifyFeishuEventSignature({
          timestamp,
          nonce,
          encryptKey,
          rawBody,
          signature: expectedSig.toUpperCase(),
        }),
      ).toBe(true);

      // Tampered body or wrong signature fails
      expect(
        verifyFeishuEventSignature({
          timestamp,
          nonce,
          encryptKey,
          rawBody: new TextEncoder().encode('{"encrypt":"tampered"}'),
          signature: expectedSig,
        }),
      ).toBe(false);

      expect(
        verifyFeishuEventSignature({
          timestamp: undefined,
          nonce,
          encryptKey,
          rawBody,
          signature: expectedSig,
        }),
      ).toBe(false);
    });

    it("verifies Verification Token in constant time", () => {
      expect(verifyFeishuVerificationToken("tok_secret_1", "tok_secret_1")).toBe(true);
      expect(verifyFeishuVerificationToken("tok_secret_1", "tok_secret_2")).toBe(false);
      expect(verifyFeishuVerificationToken(undefined, "tok_secret_1")).toBe(false);
      expect(verifyFeishuVerificationToken("short", "much_longer_token")).toBe(false);
    });
  });

  describe("FeishuApiClient tenant_access_token caching, single-flight refresh, and error mapping", () => {
    it("caches tenant_access_token, deduplicates concurrent fetches, and refreshes before expiry buffer", async () => {
      let currentTimeMs = 1_000_000;
      let tokenCounter = 0;

      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
          tokenCounter += 1;
          return jsonResponse({
            code: 0,
            msg: "ok",
            tenant_access_token: `t-token-${tokenCounter}`,
            expire: 7200,
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new FeishuApiClient({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        fetchFn: fetchMock,
        now: () => currentTimeMs,
        tokenRefreshBufferSeconds: 180,
      });

      // Concurrent calls share a single HTTP token fetch
      const [t1, t2, t3] = await Promise.all([
        client.getTenantAccessToken(),
        client.getTenantAccessToken(),
        client.getTenantAccessToken(),
      ]);
      expect(t1).toBe("t-token-1");
      expect(t2).toBe("t-token-1");
      expect(t3).toBe("t-token-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance 7000s (still > 180s remaining before 7200s) -> cached
      currentTimeMs += 7000 * 1000;
      expect(await client.getTenantAccessToken()).toBe("t-token-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance another 30s (170s remaining < 180s buffer) -> refreshes
      currentTimeMs += 30 * 1000;
      expect(await client.getTenantAccessToken()).toBe("t-token-2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws ConnectorAuthError when tenant_access_token acquisition fails", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ code: 10014, msg: "app secret invalid" }, 400),
      );
      const client = new FeishuApiClient({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "bad_secret",
        fetchFn: fetchMock,
      });

      await expect(client.getTenantAccessToken()).rejects.toThrow(ConnectorAuthError);
    });

    it("automatically refreshes token and retries once on expired tenant_access_token API error", async () => {
      let tokenIdx = 0;
      let sendAttempts = 0;

      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
          tokenIdx += 1;
          return jsonResponse({
            code: 0,
            msg: "ok",
            tenant_access_token: `t-fresh-${tokenIdx}`,
            expire: 7200,
          });
        }
        if (url.includes("/open-apis/im/v1/messages")) {
          sendAttempts += 1;
          const headers = (init?.headers ?? {}) as Record<string, string>;
          const auth = headers["Authorization"];
          if (sendAttempts === 1) {
            expect(auth).toBe("Bearer t-fresh-1");
            return jsonResponse({ code: 99991663, msg: "tenant_access_token expired" }, 401);
          }
          expect(auth).toBe("Bearer t-fresh-2");
          return jsonResponse({
            code: 0,
            msg: "success",
            data: { message_id: "om_retried_ok", chat_id: "oc_chat_1" },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new FeishuApiClient({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        fetchFn: fetchMock,
      });

      const data = await client.sendMessage({
        receiveIdType: "chat_id",
        receiveId: "oc_chat_1",
        msgType: "text",
        content: JSON.stringify({ text: "hello" }),
      });

      expect(data.message_id).toBe("om_retried_ok");
      expect(tokenIdx).toBe(2);
      expect(sendAttempts).toBe(2);
    });

    it("maps rate-limit (429 / 230020) and 5xx errors to retryable ConnectorTransportError", async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
          return jsonResponse({
            code: 0,
            msg: "ok",
            tenant_access_token: "t-ok",
            expire: 7200,
          });
        }
        return jsonResponse({ code: 230020, msg: "frequency limit" }, 400);
      });

      const client = new FeishuApiClient({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        fetchFn: fetchMock,
      });

      await expect(
        client.sendMessage({
          receiveIdType: "open_id",
          receiveId: "ou_1",
          msgType: "text",
          content: '{"text":"hi"}',
        }),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof ConnectorTransportError && err.retryable === true;
      });
    });

    it("fetches bot info, single message, and WebSocket endpoint config", async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
          return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-ok", expire: 7200 });
        }
        if (url.endsWith("/open-apis/bot/v3/info")) {
          return jsonResponse({
            code: 0,
            msg: "ok",
            bot: { open_id: "ou_bot_999", app_name: "DSH Bot", activate_status: 2 },
          });
        }
        if (url.endsWith("/open-apis/im/v1/messages/om_parent_1")) {
          return jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              items: [
                {
                  message_id: "om_parent_1",
                  msg_type: "text",
                  chat_id: "oc_chat_1",
                  body: { content: '{"text":"[#ctx:uuid-parent]\\nHello"}' },
                },
              ],
            },
          });
        }
        if (url.endsWith("/callback/ws/endpoint")) {
          return jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              URL: "wss://msg-frontier.feishu.cn/ws/v2?device_id=dev1&service_id=42",
              ClientConfig: {
                PingInterval: 90,
                ReconnectCount: 5,
                ReconnectInterval: 30,
                ReconnectNonce: 10,
              },
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new FeishuApiClient({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        fetchFn: fetchMock,
      });

      const botInfo = await client.getBotInfo();
      expect(botInfo).toEqual({
        openId: "ou_bot_999",
        appName: "DSH Bot",
        activateStatus: 2,
      });

      const msg = await client.getMessage("om_parent_1");
      expect(msg?.message_id).toBe("om_parent_1");
      expect(msg?.body?.content).toContain("[#ctx:uuid-parent]");

      const wsEndpoint = await client.pullWsEndpoint();
      expect(wsEndpoint.url).toContain("service_id=42");
      expect(wsEndpoint.clientConfig?.PingInterval).toBe(90);
    });

    it("validates client options and maps HTTP/JSON/endpoint edge errors cleanly", async () => {
      expect(() => new FeishuApiClient({ appId: "  ", appSecret: "sec" })).toThrow(
        ConnectorValidationError,
      );
      expect(() => new FeishuApiClient({ appId: "cli_1", appSecret: "  " })).toThrow(
        ConnectorValidationError,
      );
      expect(
        () => new FeishuApiClient({ appId: "cli_1", appSecret: "sec", requestTimeoutMs: 0 }),
      ).toThrow(ConnectorValidationError);

      // Network throw -> retryable ConnectorTransportError
      const netFailClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async () => {
          throw new Error("ECONNRESET");
        },
      });
      await expect(netFailClient.getTenantAccessToken()).rejects.toSatisfy(
        (err: unknown) => err instanceof ConnectorTransportError && err.retryable === true,
      );

      // 503 on token endpoint -> retryable ConnectorTransportError
      const serverBusyTokenClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async () => jsonResponse({ code: 500, msg: "busy" }, 503),
      });
      await expect(serverBusyTokenClient.getTenantAccessToken()).rejects.toSatisfy(
        (err: unknown) => err instanceof ConnectorTransportError && err.retryable === true,
      );

      // Invalid JSON response & JSON array response
      const invalidJsonClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async () => new Response("<html>502</html>", { status: 502 }),
      });
      await expect(invalidJsonClient.getTenantAccessToken()).rejects.toSatisfy(
        (err: unknown) => err instanceof ConnectorTransportError && err.retryable === true,
      );

      const arrayJsonClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async () => new Response("[1,2,3]", { status: 200 }),
      });
      await expect(arrayJsonClient.getTenantAccessToken()).rejects.toThrow(ConnectorTransportError);

      // pullWsEndpoint error cases & missing data
      const wsAuthFailClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async () => jsonResponse({ code: 10014, msg: "bad secret" }, 401),
      });
      await expect(wsAuthFailClient.pullWsEndpoint()).rejects.toThrow(ConnectorAuthError);

      const wsRetryableFailClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async () => jsonResponse({ code: 1_000_040_343, msg: "internal" }, 500),
      });
      await expect(wsRetryableFailClient.pullWsEndpoint()).rejects.toSatisfy(
        (err: unknown) => err instanceof ConnectorTransportError && err.retryable === true,
      );

      const wsEmptyUrlClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async () => jsonResponse({ code: 0, msg: "ok", data: { URL: "" } }, 200),
      });
      await expect(wsEmptyUrlClient.pullWsEndpoint()).rejects.toThrow(ConnectorTransportError);

      // Missing bot.open_id & missing data.message_id & persistent auth error
      const malformedApiClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async (input) => {
          const url = String(input);
          if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
            return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 });
          }
          if (url.endsWith("/open-apis/bot/v3/info")) {
            return jsonResponse({ code: 0, msg: "ok", bot: {} });
          }
          return jsonResponse({ code: 0, msg: "ok", data: {} });
        },
      });
      await expect(malformedApiClient.getBotInfo()).rejects.toThrow(ConnectorTransportError);
      await expect(
        malformedApiClient.sendMessage({
          receiveIdType: "chat_id",
          receiveId: "oc_1",
          msgType: "text",
          content: '{"text":"x"}',
        }),
      ).rejects.toThrow(ConnectorTransportError);

      const persistentTokenErrClient = new FeishuApiClient({
        appId: "cli_1",
        appSecret: "sec",
        fetchFn: async (input) => {
          const url = String(input);
          if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
            return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 });
          }
          return jsonResponse({ code: 99991663, msg: "expired" }, 401);
        },
      });
      await expect(persistentTokenErrClient.getBotInfo()).rejects.toThrow(ConnectorAuthError);
    });
  });

  describe("Outbound Feishu Sender (send & reply)", () => {
    it("sends plain text and markdown Card 2.0 messages, replies in thread, and preserves structured handle metadata", async () => {
      const capturedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
          return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-tok", expire: 7200 });
        }
        const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedRequests.push({ url, body: parsedBody });

        if (url.includes("/reply")) {
          return jsonResponse({
            code: 0,
            msg: "success",
            data: {
              message_id: "om_reply_200",
              root_id: "om_root_100",
              parent_id: "om_root_100",
              thread_id: "omt_thread_1",
              chat_id: "oc_group_1",
              msg_type: "interactive",
            },
          });
        }

        return jsonResponse({
          code: 0,
          msg: "success",
          data: {
            message_id: "om_sent_100",
            chat_id: "oc_p2p_1",
            msg_type: "text",
          },
        });
      });

      const client = new FeishuApiClient({
        appId: "cli_a1b2c3d4e5f60718",
        appSecret: "sec_123",
        fetchFn: fetchMock,
      });

      const sender = createFeishuSender({
        connectorName: DEFAULT_FEISHU_CONNECTOR_NAME,
        apiClient: client,
        contextMarker: "auto",
        defaultOutboundFormat: "text",
      });

      // 1. Send via inbound p2p context (no explicit target needed, clean text)
      const p2pCtx = createConnectorContext(DEFAULT_FEISHU_CONNECTOR_NAME, "p2p:ou_alice");
      const sendRes = await sender.send(p2pCtx, { text: "Hello Alice!" });

      expect(sendRes.messageId).toBe("om_sent_100");
      expect(sendRes.externalId).toBe("om_sent_100");
      expect(sendRes.chatId).toBe("oc_p2p_1");
      expect(sendRes.receiveId).toBe("ou_alice");
      expect(sendRes.receiveIdType).toBe("open_id");
      expect(capturedRequests[0]?.url).toBe(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
      );
      expect(capturedRequests[0]?.body).toEqual({
        receive_id: "ou_alice",
        msg_type: "text",
        content: JSON.stringify({ text: "Hello Alice!" }),
      });

      // 2. Reply in thread with markdown format
      const topicCtx = createConnectorContext(
        DEFAULT_FEISHU_CONNECTOR_NAME,
        "group:oc_group_1:topic:om_root_100",
      );
      const replyRes = await sender.send(topicCtx, {
        text: "**Markdown** summary",
        format: "markdown",
        uuid: "dedup-uuid-1",
      });

      expect(replyRes.messageId).toBe("om_reply_200");
      expect(replyRes.threadId).toBe("omt_thread_1");
      expect(replyRes.repliedToMessageId).toBe("om_root_100");
      expect(capturedRequests[1]?.url).toBe(
        "https://open.feishu.cn/open-apis/im/v1/messages/om_root_100/reply",
      );
      expect(capturedRequests[1]?.body["msg_type"]).toBe("interactive");
      expect(capturedRequests[1]?.body["reply_in_thread"]).toBe(true);
      expect(capturedRequests[1]?.body["uuid"]).toBe("dedup-uuid-1");
      const cardJson = JSON.parse(String(capturedRequests[1]?.body["content"])) as Record<
        string,
        unknown
      >;
      expect(cardJson["schema"]).toBe("2.0");

      // 3. Pure UUID context without target throws ConnectorTargetRequiredError
      const uuidCtx = createConnectorContext(
        DEFAULT_FEISHU_CONNECTOR_NAME,
        "550e8400-e29b-41d4-a716-446655440000",
      );
      await expect(sender.send(uuidCtx, { text: "Missing target" })).rejects.toThrow(
        ConnectorTargetRequiredError,
      );
    });
  });
});
