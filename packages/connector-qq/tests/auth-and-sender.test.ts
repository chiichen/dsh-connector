import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  createConnectorContext,
} from "@dsh-connector/core";
import { QqAccessTokenManager, QqMessageSender, QqPassiveReplyTracker } from "../src/index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Stage 2: QQ dynamic access_token and outbound message sender", () => {
  it("fetches access_token from bots.qq.com/app/getAppAccessToken, caches with single-flight deduplication, and refreshes within 60s expiry buffer", async () => {
    let nowMs = 1_000_000;
    let callCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      expect(String(input)).toBe("https://bots.qq.com/app/getAppAccessToken");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        appId: "10203040",
        clientSecret: "secret-xyz",
      });
      return jsonResponse({
        access_token: `tok-${callCount}`,
        expires_in: "7200",
      });
    });

    const tokenManager = new QqAccessTokenManager({
      appId: "10203040",
      clientSecret: "secret-xyz",
      fetchFn: fetchMock as typeof fetch,
      now: () => nowMs,
    });

    // Single-flight concurrent requests share 1 HTTP fetch
    const [h1, h2] = await Promise.all([
      tokenManager.getAuthorizationHeader(),
      tokenManager.getAuthorizationHeader(),
    ]);
    expect(h1).toBe("QQBot tok-1");
    expect(h2).toBe("QQBot tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still valid before (7200 - 60) seconds
    nowMs += (7_200 - 61) * 1_000;
    expect(await tokenManager.getAccessToken()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Within 60s lead buffer -> refreshes token
    nowMs += 2_000;
    expect(await tokenManager.getAccessToken()).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies HTTP 200 business error codes (100007/100016 auth vs 100001 rate limit) on getAppAccessToken", async () => {
    const authFailManager = new QqAccessTokenManager({
      appId: "bad-app",
      clientSecret: "bad-secret",
      fetchFn: (async () =>
        jsonResponse({ code: 100016, message: "invalid appid or secret" }, 200)) as typeof fetch,
    });
    await expect(authFailManager.getAccessToken()).rejects.toBeInstanceOf(ConnectorAuthError);

    const rateLimitManager = new QqAccessTokenManager({
      appId: "app",
      clientSecret: "secret",
      fetchFn: (async () =>
        jsonResponse({ code: 100001, message: "Too many requests" }, 200)) as typeof fetch,
    });
    await expect(rateLimitManager.getAccessToken()).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorTransportError && err.retryable === true,
    );
  });

  it("sends C2C, group, and channel messages with passive msg_id + incrementing msg_seq and bracket context markers", async () => {
    const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "live-token", expires_in: 7200 });
      }
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, auth: headers.get("authorization"), body });
      return jsonResponse({
        id: `OUT_${requests.length}`,
        timestamp: "2026-11-23T10:05:00+08:00",
        ext_info: { ref_idx: `REFIDX_${requests.length}` },
      });
    });

    const tokenManager = new QqAccessTokenManager({
      appId: "10203040",
      clientSecret: "secret-xyz",
      fetchFn: fetchMock as typeof fetch,
    });
    const tracker = new QqPassiveReplyTracker();
    const sender = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      passiveTracker: tracker,
      fetchFn: fetchMock as typeof fetch,
    });

    // Record inbound C2C message -> passive replies auto-attach msg_id and increment msg_seq (1, 2, ...)
    tracker.recordInbound({ scene: "c2c", openId: "U_OPEN_1" }, "IN_C2C_MSG_1", 1_000);
    const c2cCtx = createConnectorContext("qq", "c2c:U_OPEN_1");

    const r1 = await sender.send(c2cCtx, { text: "First reply" }, { nowMs: 2_000 });
    const r2 = await sender.send(
      c2cCtx,
      { text: "Second reply", includeContextMarker: true },
      { nowMs: 3_000 },
    );

    expect(requests[0]).toEqual({
      url: "https://api.sgroup.qq.com/v2/users/U_OPEN_1/messages",
      auth: "QQBot live-token",
      body: {
        msg_type: 0,
        content: "First reply",
        msg_id: "IN_C2C_MSG_1",
        msg_seq: 1,
      },
    });
    expect(requests[1]).toEqual({
      url: "https://api.sgroup.qq.com/v2/users/U_OPEN_1/messages",
      auth: "QQBot live-token",
      body: {
        msg_type: 0,
        content: "[#ctx:c2c:U_OPEN_1]\nSecond reply",
        msg_id: "IN_C2C_MSG_1",
        msg_seq: 2,
      },
    });
    expect(r1.messageId).toBe("OUT_1");
    expect(r1.passiveMsgId).toBe("IN_C2C_MSG_1");
    expect(r1.msgSeq).toBe(1);
    expect(r1.refIdx).toBe("REFIDX_1");
    expect(r2.msgSeq).toBe(2);

    // Group send with explicit replyToMessageId
    const groupCtx = createConnectorContext("qq", "group:G_OPEN_9");
    const rGroup = await sender.send(groupCtx, {
      text: "**Hello Group**",
      format: "markdown",
      replyToMessageId: "IN_GRP_MSG_9",
    });
    expect(requests[2]).toEqual({
      url: "https://api.sgroup.qq.com/v2/groups/G_OPEN_9/messages",
      auth: "QQBot live-token",
      body: {
        msg_type: 2,
        markdown: { content: "**Hello Group**" },
        msg_id: "IN_GRP_MSG_9",
        msg_seq: 1,
      },
    });
    expect(rGroup.target).toEqual({ scene: "group", groupOpenId: "G_OPEN_9" });

    // Channel send (/channels/{channel_id}/messages)
    tracker.recordInbound({ scene: "channel", channelId: "CH_88" }, "IN_CH_MSG_8", 1_000);
    const chCtx = createConnectorContext("qq", "channel:GUILD_1:CH_88");
    const rCh = await sender.send(chCtx, { text: "Hello Channel" }, { nowMs: 2_000 });
    expect(requests[3]).toEqual({
      url: "https://api.sgroup.qq.com/channels/CH_88/messages",
      auth: "QQBot live-token",
      body: {
        content: "Hello Channel",
        msg_id: "IN_CH_MSG_8",
      },
    });
    expect(rCh.messageId).toBe("OUT_4");
  });

  it("falls back to plain text on Markdown rejection (40034090), retries once on 401 token expiry, and accepts channel audit (304023)", async () => {
    let tokenSeq = 0;
    let sendAttempt = 0;
    const seenBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app/getAppAccessToken")) {
        tokenSeq += 1;
        return jsonResponse({ access_token: `tok-${tokenSeq}`, expires_in: 7200 });
      }
      sendAttempt += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seenBodies.push(body);

      if (sendAttempt === 1) {
        // First send gets 401 -> invalidates token and retries
        return jsonResponse({ message: "Unauthorized" }, 401);
      }
      if (sendAttempt === 2) {
        // Markdown rejected with 40034090 -> falls back to plain text with incremented msg_seq
        return jsonResponse({ code: 40034090, message: "markdown not allowed" }, 400);
      }
      if (sendAttempt === 3) {
        return jsonResponse({ id: "FALLBACK_OK" }, 200);
      }
      // 4th attempt: channel message waiting for audit (304023)
      return jsonResponse(
        {
          code: 304023,
          message: "push message is waiting for audit now",
          data: { message_audit: { audit_id: "AUDIT_999" } },
        },
        200,
      );
    });

    const tokenManager = new QqAccessTokenManager({
      appId: "10203040",
      clientSecret: "secret-xyz",
      fetchFn: fetchMock as typeof fetch,
    });
    const sender = new QqMessageSender({
      connectorName: "qq",
      tokenManager,
      passiveTracker: new QqPassiveReplyTracker(),
      fetchFn: fetchMock as typeof fetch,
    });

    const ctx = createConnectorContext("qq", "c2c:U_1");
    const res = await sender.send(ctx, {
      text: "# Title",
      format: "markdown",
      replyToMessageId: "M_1",
    });
    expect(res.messageId).toBe("FALLBACK_OK");
    expect(tokenSeq).toBe(2);
    expect(seenBodies[0]).toMatchObject({ msg_type: 2, msg_id: "M_1", msg_seq: 1 });
    expect(seenBodies[1]).toMatchObject({ msg_type: 2, msg_id: "M_1", msg_seq: 1 });
    expect(seenBodies[2]).toMatchObject({
      msg_type: 0,
      content: "# Title",
      msg_id: "M_1",
      msg_seq: 2,
    });

    const auditRes = await sender.send(createConnectorContext("qq", "channel:CH_AUDIT"), {
      text: "proactive channel post",
    });
    expect(auditRes.auditId).toBe("AUDIT_999");
    expect(auditRes.messageId).toBe("audit:AUDIT_999");
  });
});
