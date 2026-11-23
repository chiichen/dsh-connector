import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
} from "@dsh-connector/core";
import {
  computeDingTalkSignature,
  DingTalkAccessTokenManager,
  DingTalkSender,
  normalizeDingTalkSessionWebhook,
  SessionWebhookCache,
  verifyDingTalkWebhookSignature,
} from "../src";
import { requestDingTalkJson } from "../src/http";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Stage 2: DingTalk OAuth2 accessToken, Outgoing signature verification, and Sender", () => {
  describe("Outgoing webhook signature & token verification", () => {
    it("computes HMAC-SHA256 Base64 signature matching official DingTalk spec", () => {
      const timestamp = "1577262236757";
      const secret = "this is a secret";
      const expected = createHmac("sha256", secret)
        .update(`${timestamp}\n${secret}`, "utf8")
        .digest("base64");

      expect(computeDingTalkSignature(timestamp, secret)).toBe(expected);
    });

    it("verifies valid timestamp + sign headers and rejects skewed or tampered requests", () => {
      const nowMs = 1_700_000_000_000;
      const secret = "ding-secret-key";
      const ts = String(nowMs - 30_000);
      const validSign = computeDingTalkSignature(ts, secret);

      expect(
        verifyDingTalkWebhookSignature(
          { TIMESTAMP: [ts], Sign: validSign },
          { signingSecret: secret, nowMs },
        ),
      ).toEqual({ ok: true });

      expect(
        verifyDingTalkWebhookSignature(
          { timestamp: String(nowMs - 3_600_001), sign: validSign },
          { signingSecret: secret, nowMs },
        ),
      ).toEqual({ ok: false, reason: "timestamp_expired" });

      expect(
        verifyDingTalkWebhookSignature(
          { timestamp: "not-a-number", sign: validSign },
          { signingSecret: secret, nowMs },
        ),
      ).toEqual({ ok: false, reason: "missing_or_invalid_timestamp" });

      expect(
        verifyDingTalkWebhookSignature({ timestamp: ts }, { signingSecret: secret, nowMs }),
      ).toEqual({ ok: false, reason: "missing_sign" });

      expect(
        verifyDingTalkWebhookSignature(
          { timestamp: ts, sign: "wrong-len" },
          { signingSecret: secret, nowMs },
        ),
      ).toEqual({ ok: false, reason: "invalid_sign" });

      const sameLenWrongSign = computeDingTalkSignature(ts, "another-secret-key");
      expect(
        verifyDingTalkWebhookSignature(
          { timestamp: ts, sign: sameLenWrongSign },
          { signingSecret: secret, nowMs },
        ),
      ).toEqual({ ok: false, reason: "invalid_sign" });
    });

    it("supports custom robot Outgoing token header verification and rejects unconfigured verifier", () => {
      expect(
        verifyDingTalkWebhookSignature(
          { token: "custom-outgoing-token" },
          { outgoingToken: "custom-outgoing-token", nowMs: 1_700_000_000_000 },
        ),
      ).toEqual({ ok: true });

      expect(
        verifyDingTalkWebhookSignature(
          { token: "wrong-token" },
          { outgoingToken: "custom-outgoing-token", nowMs: 1_700_000_000_000 },
        ),
      ).toEqual({ ok: false, reason: "invalid_token" });

      expect(
        verifyDingTalkWebhookSignature(
          {},
          { outgoingToken: "custom-outgoing-token", nowMs: 1_700_000_000_000 },
        ),
      ).toEqual({ ok: false, reason: "invalid_token" });

      expect(
        verifyDingTalkWebhookSignature(
          { token: "bad" },
          {
            signingSecret: "sec",
            outgoingToken: "custom-outgoing-token",
            nowMs: 1_700_000_000_000,
          },
        ),
      ).toEqual({ ok: false, reason: "invalid_token" });

      expect(verifyDingTalkWebhookSignature({}, { nowMs: 1_700_000_000_000 })).toEqual({
        ok: false,
        reason: "verifier_not_configured",
      });
    });
  });

  describe("DingTalkAccessTokenManager", () => {
    it("fetches, caches, deduplicates in-flight requests, and refreshes before expiry", async () => {
      let currentNow = 1_000_000;
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ accessToken: "tok-1", expireIn: 7200 }))
        .mockResolvedValueOnce(jsonResponse({ accessToken: "tok-2", expireIn: 7200 }));

      const manager = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "ding-app-key",
        clientSecret: "ding-app-secret",
        fetchFn: fetchMock,
        now: () => currentNow,
      });

      const [t1, t2] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()]);
      expect(t1).toBe("tok-1");
      expect(t2).toBe("tok-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [reqUrl, reqInit] = fetchMock.mock.calls[0]!;
      expect(String(reqUrl)).toBe("https://api.dingtalk.com/v1.0/oauth2/accessToken");
      expect(reqInit?.method).toBe("POST");
      expect(JSON.parse(String(reqInit?.body))).toEqual({
        appKey: "ding-app-key",
        appSecret: "ding-app-secret",
      });

      currentNow += (7200 - 61) * 1000;
      expect(await manager.getAccessToken()).toBe("tok-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      currentNow += 2_000;
      expect(await manager.getAccessToken()).toBe("tok-2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("maps invalid credentials to ConnectorAuthError and server/network failures to ConnectorTransportError", async () => {
      const authFailFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ code: "invalidClientIdOrSecret", message: "bad secret" }, 400),
        );
      const authManager = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "bad",
        clientSecret: "bad",
        fetchFn: authFailFetch,
      });
      await expect(authManager.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);

      const rateLimitFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ code: "rateLimit" }, 429));
      const rlManager = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "ding",
        clientSecret: "sec",
        fetchFn: rateLimitFetch,
      });
      await expect(rlManager.getAccessToken()).rejects.toMatchObject({
        name: "ConnectorTransportError",
        statusCode: 429,
        retryable: true,
      });

      const emptyTokenFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ accessToken: "" }, 200));
      const emptyManager = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "ding",
        clientSecret: "sec",
        fetchFn: emptyTokenFetch,
      });
      await expect(emptyManager.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);
    });
  });

  describe("SessionWebhook validation and cache", () => {
    it("accepts only HTTPS dingtalk.com sessionWebhook URLs and evicts expired/overflow entries", () => {
      expect(
        normalizeDingTalkSessionWebhook(
          "https://oapi.dingtalk.com/robot/sendBySession?session=abc#frag",
        ),
      ).toBe("https://oapi.dingtalk.com/robot/sendBySession?session=abc");

      expect(() =>
        normalizeDingTalkSessionWebhook("http://oapi.dingtalk.com/robot/sendBySession?session=abc"),
      ).toThrow(ConnectorValidationError);
      expect(() =>
        normalizeDingTalkSessionWebhook("https://evil.example.com/robot/sendBySession"),
      ).toThrow(ConnectorValidationError);
      expect(() =>
        normalizeDingTalkSessionWebhook("https://user:pass@oapi.dingtalk.com/robot/sendBySession"),
      ).toThrow(ConnectorValidationError);
      expect(() =>
        normalizeDingTalkSessionWebhook("https://oapi.dingtalk.com:8443/robot/sendBySession"),
      ).toThrow(ConnectorValidationError);

      let now = 1_000;
      const cache = new SessionWebhookCache({ now: () => now, maxEntries: 2 });
      cache.set("p2p:u1", "https://oapi.dingtalk.com/robot/sendBySession?session=1", 5_000);
      cache.set("p2p:u2", "https://oapi.dingtalk.com/robot/sendBySession?session=2", 5_000);
      cache.set("p2p:u3", "https://oapi.dingtalk.com/robot/sendBySession?session=3", 5_000);

      expect(cache.get("p2p:u1")).toBeUndefined();
      expect(cache.get("p2p:u2")?.sessionWebhook).toContain("session=2");

      now = 6_000;
      expect(cache.get("p2p:u2")).toBeUndefined();
    });
  });

  describe("DingTalkSender 3-tier target resolution & OpenAPI / sessionWebhook delivery", () => {
    it("sends 1:1 proactive message via v1.0/robot/oToMessages/batchSend from p2p contextId or explicit userId", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ accessToken: "tok-oto", expireIn: 7200 }))
        .mockResolvedValueOnce(
          jsonResponse({
            processQueryKey: "pqk-oto-1",
            invalidStaffIdList: [],
            flowControlledStaffIdList: [],
          }),
        );

      const tokenManager = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "ding-bot",
        clientSecret: "ding-sec",
        fetchFn: fetchMock,
      });

      const sender = new DingTalkSender({
        connectorName: "dingtalk",
        robotCode: "ding-bot",
        tokenManager,
        fetchFn: fetchMock,
        contextMarker: "bracket",
      });

      const ctx = createConnectorContext("dingtalk", "p2p:staff-42");
      const res = await sender.send(ctx, { text: "Hello single user" });

      expect(res.channel).toBe("oToMessages");
      expect(res.messageId).toBe("pqk-oto-1");
      expect(res.externalId).toBe("pqk-oto-1");
      expect(res.target).toEqual({
        kind: "user",
        userIds: ["staff-42"],
        robotCode: "ding-bot",
      });

      const [sendUrl, sendInit] = fetchMock.mock.calls[1]!;
      expect(String(sendUrl)).toBe("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
      const sendHeaders = sendInit?.headers as Record<string, string> | undefined;
      expect(sendHeaders?.["x-acs-dingtalk-access-token"]).toBe("tok-oto");
      const parsedBody = JSON.parse(String(sendInit?.body)) as Record<string, unknown>;
      expect(parsedBody["robotCode"]).toBe("ding-bot");
      expect(parsedBody["userIds"]).toEqual(["staff-42"]);
      expect(parsedBody["msgKey"]).toBe("sampleText");
      expect(JSON.parse(String(parsedBody["msgParam"]))).toEqual({
        content: "[#ctx:p2p:staff-42]\nHello single user",
      });
    });

    it("sends group proactive markdown message via v1.0/robot/groupMessages/send and retries once on 401", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ accessToken: "stale-token", expireIn: 7200 }))
        .mockResolvedValueOnce(jsonResponse({ code: "InvalidAuthentication" }, 401))
        .mockResolvedValueOnce(jsonResponse({ accessToken: "fresh-token", expireIn: 7200 }))
        .mockResolvedValueOnce(jsonResponse({ processQueryKey: "pqk-group-99" }));

      const tokenManager = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "ding-bot",
        clientSecret: "ding-sec",
        fetchFn: fetchMock,
      });

      const sender = new DingTalkSender({
        connectorName: "dingtalk",
        robotCode: "ding-bot",
        coolAppCode: "COOLAPP-DEFAULT",
        tokenManager,
        fetchFn: fetchMock,
      });

      const ctx = createConnectorContext("dingtalk", "group:cidGroupAbc==");
      const res = await sender.send(ctx, {
        text: "## Deploy Done\nVersion 1.2.0",
        format: "markdown",
      });

      expect(res.channel).toBe("groupMessages");
      expect(res.messageId).toBe("pqk-group-99");
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const [groupUrl, groupInit] = fetchMock.mock.calls[3]!;
      expect(String(groupUrl)).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/send");
      const groupHeaders = groupInit?.headers as Record<string, string> | undefined;
      expect(groupHeaders?.["x-acs-dingtalk-access-token"]).toBe("fresh-token");
      const body = JSON.parse(String(groupInit?.body)) as Record<string, unknown>;
      expect(body["openConversationId"]).toBe("cidGroupAbc==");
      expect(body["coolAppCode"]).toBe("COOLAPP-DEFAULT");
      expect(body["msgKey"]).toBe("sampleMarkdown");
      expect(JSON.parse(String(body["msgParam"]))).toEqual({
        title: "Deploy Done",
        text: "## Deploy Done\nVersion 1.2.0",
      });
    });

    it("replies via sessionWebhook (explicit or cached) with @mentions and rejects errcode !== 0", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok" }))
        .mockResolvedValueOnce(jsonResponse({ errcode: 310000, errmsg: "sign not match" }));

      const webhookCache = new SessionWebhookCache({ now: () => 1_000 });
      webhookCache.set(
        "p2p-id:$:LWCP_v1:$encUser",
        "https://oapi.dingtalk.com/robot/sendBySession?session=enc123",
        60_000,
      );

      const sender = new DingTalkSender({
        connectorName: "dingtalk",
        webhookCache,
        fetchFn: fetchMock,
      });

      const encCtx = createConnectorContext("dingtalk", "p2p-id:$:LWCP_v1:$encUser");
      const okRes = await sender.send(encCtx, {
        text: "Hi external user",
        atUserIds: ["staff-1"],
      });
      expect(okRes.channel).toBe("sessionWebhook");

      const [, firstInit] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(String(firstInit?.body))).toEqual({
        msgtype: "text",
        text: { content: "Hi external user" },
        at: { atUserIds: ["staff-1"] },
      });

      await expect(
        sender.send(createConnectorContext("dingtalk", "550e8400-e29b-41d4-a716-446655440000"), {
          text: "Webhook fail",
          sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=bad",
        }),
      ).rejects.toBeInstanceOf(ConnectorTransportError);
    });

    it("enforces 3-tier target rules: explicit params override contextId, conflicts fail, and pure UUID throws ConnectorTargetRequiredError", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ accessToken: "tok", expireIn: 7200 }))
        .mockResolvedValueOnce(jsonResponse({ processQueryKey: "pqk-override" }));

      const tokenManager = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "ding-bot",
        clientSecret: "ding-sec",
        fetchFn: fetchMock,
      });

      const sender = new DingTalkSender({
        connectorName: "dingtalk",
        robotCode: "ding-bot",
        tokenManager,
        fetchFn: fetchMock,
      });

      const uuidCtx = createConnectorContext("dingtalk", "550e8400-e29b-41d4-a716-446655440000");

      await expect(sender.send(uuidCtx, { text: "No target" })).rejects.toBeInstanceOf(
        ConnectorTargetRequiredError,
      );

      await expect(
        sender.send(uuidCtx, {
          text: "Ambiguous",
          userId: "u1",
          openConversationId: "cid1",
        }),
      ).rejects.toBeInstanceOf(ConnectorValidationError);

      const overrideRes = await sender.send(
        createConnectorContext("dingtalk", "group:cidDefault"),
        {
          text: "Explicit override",
          userIds: ["u1", "u2"],
        },
      );
      expect(overrideRes.channel).toBe("oToMessages");
      expect(overrideRes.target).toEqual({
        kind: "user",
        userIds: ["u1", "u2"],
        robotCode: "ding-bot",
      });

      fetchMock.mockResolvedValueOnce(jsonResponse({ processQueryKey: "pqk-exp-group" }));
      const expGroupRes = await sender.send(uuidCtx, {
        text: "Explicit group target",
        openConversationId: "cidExplicitGroup==",
        coolAppCode: "COOL-EXP",
      });
      expect(expGroupRes.channel).toBe("groupMessages");
      expect(expGroupRes.target).toEqual({
        kind: "group",
        openConversationId: "cidExplicitGroup==",
        robotCode: "ding-bot",
        coolAppCode: "COOL-EXP",
      });

      await expect(
        sender.send(uuidCtx, {
          text: "Whitespace userId",
          userId: "   ",
        }),
      ).rejects.toBeInstanceOf(ConnectorValidationError);

      fetchMock
        .mockResolvedValueOnce(jsonResponse({ code: "InvalidAuthentication" }, 401))
        .mockResolvedValueOnce(jsonResponse({ accessToken: "still-bad", expireIn: 7200 }))
        .mockResolvedValueOnce(jsonResponse({ code: "InvalidAuthentication" }, 401));
      await expect(
        sender.send(createConnectorContext("dingtalk", "p2p:u1"), {
          text: "Persistent 401",
        }),
      ).rejects.toBeInstanceOf(ConnectorAuthError);
    });

    it("covers HTTP transport edge cases, preferSessionWebhook, webhook-only fallback, and error mappings", async () => {
      expect(() => normalizeDingTalkSessionWebhook("not a valid url")).toThrow(
        ConnectorValidationError,
      );

      const cache = new SessionWebhookCache({ now: () => 10_000 });
      cache.set("p2p:u1", "https://oapi.dingtalk.com/robot/sendBySession?session=old", 20_000);
      cache.set("p2p:u1", "https://oapi.dingtalk.com/robot/sendBySession?session=new", 20_000);
      expect(cache.get("p2p:u1")?.sessionWebhook).toContain("session=new");
      cache.set("p2p:u1", "https://oapi.dingtalk.com/robot/sendBySession?session=expired", 5_000);
      expect(cache.get("p2p:u1")).toBeUndefined();

      const webhookOnlyFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok" }))
        .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok" }))
        .mockResolvedValueOnce(jsonResponse({ message: "bad gateway" }, 502));

      cache.set("p2p:u2", "https://oapi.dingtalk.com/robot/sendBySession?session=u2", 30_000);
      cache.set("group:cid2", "https://oapi.dingtalk.com/robot/sendBySession?session=g2", 30_000);

      const webhookOnlySender = new DingTalkSender({
        connectorName: "dingtalk",
        webhookCache: cache,
        fetchFn: webhookOnlyFetch,
        defaultFormat: "markdown",
      });

      const r1 = await webhookOnlySender.send(createConnectorContext("dingtalk", "p2p:u2"), {
        text: "###\n",
        title: "Custom Title",
        atMobiles: ["13900000000"],
        isAtAll: true,
      });
      expect(r1.channel).toBe("sessionWebhook");

      const r2 = await webhookOnlySender.send(createConnectorContext("dingtalk", "group:cid2"), {
        text: "###",
      });
      expect(r2.channel).toBe("sessionWebhook");

      await expect(
        webhookOnlySender.send(createConnectorContext("dingtalk", "group:cid2"), {
          text: "502 fail",
        }),
      ).rejects.toMatchObject({
        name: "ConnectorTransportError",
        statusCode: 502,
        retryable: true,
      });

      await expect(
        webhookOnlySender.send(createConnectorContext("dingtalk", "p2p-id:$:LWCP_v1:$missing"), {
          text: "No cached webhook",
        }),
      ).rejects.toBeInstanceOf(ConnectorTargetRequiredError);

      await expect(
        webhookOnlySender.send(createConnectorContext("dingtalk", "p2p:uncached"), {
          text: "Missing robotCode",
        }),
      ).rejects.toBeInstanceOf(ConnectorValidationError);

      const noTokenSender = new DingTalkSender({
        connectorName: "dingtalk",
        robotCode: "ding-bot",
        fetchFn: webhookOnlyFetch,
      });
      await expect(
        noTokenSender.send(createConnectorContext("dingtalk", "p2p:u9"), { text: "No token" }),
      ).rejects.toBeInstanceOf(ConnectorAuthError);

      const openApiEdgeFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ accessToken: "tok", expireIn: 7200 }))
        .mockResolvedValueOnce(jsonResponse({ errcode: 0 }, 200))
        .mockResolvedValueOnce(jsonResponse({ code: "Forbidden", message: "no perm" }, 403))
        .mockResolvedValueOnce(jsonResponse({ code: "InternalError" }, 500))
        .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
        .mockRejectedValueOnce(new TypeError("socket hang up"));

      const tm = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "ding-bot",
        clientSecret: "sec",
        fetchFn: openApiEdgeFetch,
      });
      cache.set("p2p:pref", "https://oapi.dingtalk.com/robot/sendBySession?session=pref", 30_000);
      const prefSender = new DingTalkSender({
        connectorName: "dingtalk",
        robotCode: "ding-bot",
        tokenManager: tm,
        webhookCache: cache,
        preferSessionWebhook: true,
        fetchFn: openApiEdgeFetch,
      });

      const prefRes = await prefSender.send(createConnectorContext("dingtalk", "p2p:pref"), {
        text: "Via preferred webhook with token",
      });
      expect(prefRes.channel).toBe("sessionWebhook");

      await expect(
        prefSender.send(createConnectorContext("dingtalk", "p2p:other"), { text: "403" }),
      ).rejects.toBeInstanceOf(ConnectorAuthError);

      await expect(
        prefSender.send(createConnectorContext("dingtalk", "p2p:other"), { text: "500" }),
      ).rejects.toMatchObject({ statusCode: 500, retryable: true });

      await expect(
        prefSender.send(createConnectorContext("dingtalk", "p2p:other"), { text: "bad json" }),
      ).rejects.toBeInstanceOf(ConnectorTransportError);

      await expect(
        prefSender.send(createConnectorContext("dingtalk", "p2p:other"), { text: "net err" }),
      ).rejects.toMatchObject({ retryable: true });

      const preAborted = new AbortController();
      preAborted.abort(new Error("caller pre-aborted"));
      await expect(
        prefSender.send(
          createConnectorContext("dingtalk", "p2p:other"),
          { text: "aborted" },
          { signal: preAborted.signal },
        ),
      ).rejects.toThrow("caller pre-aborted");

      const midAbort = new AbortController();
      const slowFetch = vi.fn<typeof fetch>((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });
      const timeoutSender = new DingTalkSender({
        connectorName: "dingtalk",
        webhookCache: cache,
        httpTimeoutMs: 15,
        fetchFn: slowFetch,
      });
      await expect(
        timeoutSender.send(createConnectorContext("dingtalk", "p2p:pref"), { text: "timeout" }),
      ).rejects.toMatchObject({ retryable: true });

      const midPromise = timeoutSender.send(
        createConnectorContext("dingtalk", "p2p:pref"),
        { text: "abort mid-flight" },
        { signal: midAbort.signal },
      );
      setTimeout(() => midAbort.abort(new Error("mid-flight cancel")), 2);
      await expect(midPromise).rejects.toThrow("mid-flight cancel");
    });

    it("covers array headers, token signal bypass, markdown oToMessages, and webhook fallback without tokenManager", async () => {
      const ts = "1700000000000";
      const sig = computeDingTalkSignature(ts, "arr-sec");
      expect(
        verifyDingTalkWebhookSignature(
          { timestamp: [ts], sign: [sig] },
          { signingSecret: "arr-sec", nowMs: 1_700_000_000_000 },
        ),
      ).toEqual({ ok: true });
      expect(
        verifyDingTalkWebhookSignature(
          { Token: ["tok-arr"], timestamp: ["bad"] },
          { outgoingToken: "tok-arr" },
        ),
      ).toEqual({ ok: true });
      expect(
        verifyDingTalkWebhookSignature(
          { Token: ["wrong"], timestamp: ["bad"] },
          { outgoingToken: "tok-arr" },
        ),
      ).toEqual({ ok: false, reason: "invalid_token" });

      const edgeTokenFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ accessToken: "sig-tok" })) // missing expireIn -> default 7200
        .mockResolvedValueOnce(jsonResponse({}, 502)) // 502 without detail
        .mockResolvedValueOnce(jsonResponse({ accessToken: "md-tok", expireIn: 7200 }))
        .mockResolvedValueOnce(
          jsonResponse({
            processQueryKey: "pqk-md",
            invalidStaffIdList: ["bad-u"],
            flowControlledStaffIdList: ["fc-u"],
          }),
        );

      const sigController = new AbortController();
      const tm = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "cli",
        clientSecret: "sec",
        fetchFn: edgeTokenFetch,
      });
      expect(await tm.getAccessToken(sigController.signal)).toBe("sig-tok");
      tm.invalidate();
      await expect(tm.getAccessToken(sigController.signal)).rejects.toBeInstanceOf(
        ConnectorTransportError,
      );

      const mdSender = new DingTalkSender({
        connectorName: "dingtalk",
        robotCode: "cli",
        tokenManager: tm,
        fetchFn: edgeTokenFetch,
      });
      const mdRes = await mdSender.send(
        createConnectorContext("dingtalk", "p2p:u-md"),
        { text: "   \n   ", format: "markdown" }, // whitespace-only lines -> fallback title
      );
      expect(mdRes.data?.invalidStaffIdList).toEqual(["bad-u"]);
      expect(mdRes.data?.flowControlledStaffIdList).toEqual(["fc-u"]);

      // Fallback to cached sessionWebhook for p2p: and group: when preferSessionWebhook=false and tokenManager=undefined
      const fbFetch = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => jsonResponse({ errcode: 0, errmsg: "ok" }));
      const fbCache = new SessionWebhookCache({ now: () => 1_000 });
      fbCache.set("p2p:u-fb", "https://oapi.dingtalk.com/robot/sendBySession?session=u", 20_000);
      fbCache.set(
        "group:cid-fb",
        "https://oapi.dingtalk.com/robot/sendBySession?session=g",
        20_000,
      );
      const fbSender = new DingTalkSender({
        connectorName: "dingtalk",
        webhookCache: fbCache,
        preferSessionWebhook: false,
        fetchFn: fbFetch,
      });
      expect(
        (await fbSender.send(createConnectorContext("dingtalk", "p2p:u-fb"), { text: "hi u" }))
          .channel,
      ).toBe("sessionWebhook");
      expect(
        (await fbSender.send(createConnectorContext("dingtalk", "group:cid-fb"), { text: "hi g" }))
          .channel,
      ).toBe("sessionWebhook");

      // requestDingTalkJson & SessionWebhookCache default options / non-Error abort / empty & 500 non-JSON bodies
      const defaultCache = new SessionWebhookCache();
      defaultCache.set(
        "p2p:default-clock",
        "https://oapi.dingtalk.com/robot/sendBySession?session=dc",
        Date.now() + 60_000,
      );
      expect(defaultCache.get("p2p:default-clock")).toBeDefined();

      const httpEdgeFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response("<html>500</html>", { status: 500 }));

      const emptyRes = await requestDingTalkJson({
        connectorName: "dingtalk",
        fetchFn: httpEdgeFetch,
        url: "https://api.dingtalk.com/v1.0/ping",
        method: "GET",
      });
      expect(emptyRes.data).toEqual({});

      const errHtmlRes = await requestDingTalkJson({
        connectorName: "dingtalk",
        fetchFn: httpEdgeFetch,
        url: "https://api.dingtalk.com/v1.0/ping",
        timeoutMs: 0,
      });
      expect(errHtmlRes.ok).toBe(false);

      const preStrAbort = new AbortController();
      preStrAbort.abort("string-pre-abort");
      await expect(
        requestDingTalkJson({
          connectorName: "dingtalk",
          fetchFn: httpEdgeFetch,
          url: "https://api.dingtalk.com/v1.0/ping",
          signal: preStrAbort.signal,
        }),
      ).rejects.toBeInstanceOf(ConnectorTransportError);

      const midStrAbort = new AbortController();
      const hangingFetch = vi.fn<typeof fetch>((_url, init) => {
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        });
      });
      const midStrPromise = requestDingTalkJson({
        connectorName: "dingtalk",
        fetchFn: hangingFetch,
        url: "https://api.dingtalk.com/v1.0/ping",
        signal: midStrAbort.signal,
      });
      setTimeout(() => midStrAbort.abort("string-mid-abort"), 2);
      await expect(midStrPromise).rejects.toBeInstanceOf(ConnectorTransportError);

      // Cover remaining auth.ts / http.ts / sender.ts branch arms (empty array header, default fetchFn, empty error bodies, non-string token, non-Error throw, missing processQueryKey)
      expect(
        verifyDingTalkWebhookSignature({ timestamp: [], sign: undefined }, { signingSecret: "s" }),
      ).toEqual({ ok: false, reason: "missing_or_invalid_timestamp" });

      const defaultFetchTm = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "cli",
        clientSecret: "sec",
      });
      expect(defaultFetchTm).toBeInstanceOf(DingTalkAccessTokenManager);

      const authDetailLessFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({}, 401)) // 401 without detail
        .mockResolvedValueOnce(jsonResponse({}, 200)) // 200 without accessToken property
        .mockRejectedValueOnce("raw-string-network-failure");

      const detailLessTm = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "cli",
        clientSecret: "sec",
        fetchFn: authDetailLessFetch,
      });
      await expect(detailLessTm.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);
      await expect(detailLessTm.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);
      await expect(
        requestDingTalkJson({
          connectorName: "dingtalk",
          fetchFn: authDetailLessFetch,
          url: "https://api.dingtalk.com/v1.0/ping",
        }),
      ).rejects.toThrow("raw-string-network-failure");

      const senderBranchFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ accessToken: "tok-b", expireIn: 7200 }))
        .mockResolvedValueOnce(jsonResponse({})) // oToMessages without processQueryKey
        .mockResolvedValueOnce(jsonResponse({})) // groupMessages without processQueryKey
        .mockResolvedValueOnce(jsonResponse({}, 403)) // OpenAPI 403 without detail
        .mockResolvedValueOnce(jsonResponse({}, 500)) // OpenAPI 500 without detail
        .mockResolvedValueOnce(jsonResponse({}, 500)); // sessionWebhook 500 without detail

      const branchTm = new DingTalkAccessTokenManager({
        connectorName: "dingtalk",
        clientId: "cli",
        clientSecret: "sec",
        fetchFn: senderBranchFetch,
      });
      const branchSender = new DingTalkSender({
        connectorName: "dingtalk",
        robotCode: "cli",
        tokenManager: branchTm,
        fetchFn: senderBranchFetch,
      });
      const otoNoKey = await branchSender.send(createConnectorContext("dingtalk", "p2p:u1"), {
        text: "oto no key",
      });
      expect(otoNoKey.externalId).toBeUndefined();

      const grpNoKey = await branchSender.send(createConnectorContext("dingtalk", "group:cid1"), {
        text: "grp no key",
      });
      expect(grpNoKey.externalId).toBeUndefined();

      await expect(
        branchSender.send(createConnectorContext("dingtalk", "p2p:u1"), { text: "403 empty" }),
      ).rejects.toBeInstanceOf(ConnectorAuthError);
      await expect(
        branchSender.send(createConnectorContext("dingtalk", "p2p:u1"), { text: "500 empty" }),
      ).rejects.toBeInstanceOf(ConnectorTransportError);
      await expect(
        branchSender.send(createConnectorContext("dingtalk", "ctx"), {
          text: "wh 500 empty",
          sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=s",
        }),
      ).rejects.toBeInstanceOf(ConnectorTransportError);
    });
  });
});
