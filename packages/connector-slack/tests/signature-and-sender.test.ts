import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
  extractContextMarker,
} from "@dsh-connector/core";
import {
  computeSlackSignature,
  createSlackSender,
  SLACK_APP_TOKEN_PREFIX,
  SLACK_BOT_TOKEN_PREFIX,
  SlackApiClient,
  slackSendSchema,
  verifySlackRequestSignature,
} from "../src";

const TEST_BOT_TOKEN = `${SLACK_BOT_TOKEN_PREFIX}fixture-bot-token-0001`;
const TEST_APP_TOKEN = `${SLACK_APP_TOKEN_PREFIX}fixture-app-token-0001`;
const TEST_SIGNING_KEY = "unit-test-slack-signing-key";

describe("Stage 2: Slack v0 signature verification, Web API client, and outbound Sender", () => {
  describe("verifySlackRequestSignature", () => {
    it("computes and verifies Slack v0 HMAC-SHA256 signatures across string and Uint8Array bodies", () => {
      const sampleBody =
        '{"type":"event_callback","team_id":"T0123456789","event":{"type":"app_mention","text":"hello"}}';
      const timestamp = 1_700_000_123;
      const expectedHex = createHmac("sha256", TEST_SIGNING_KEY)
        .update(`v0:${timestamp}:${sampleBody}`, "utf8")
        .digest("hex");
      const expectedSig = `v0=${expectedHex}`;

      expect(computeSlackSignature(TEST_SIGNING_KEY, timestamp, sampleBody)).toBe(expectedSig);

      const rawBody = new TextEncoder().encode(sampleBody);
      expect(computeSlackSignature(TEST_SIGNING_KEY, String(timestamp), rawBody)).toBe(expectedSig);

      const verified = verifySlackRequestSignature({
        signingSecret: TEST_SIGNING_KEY,
        headers: {
          "X-Slack-Request-Timestamp": [String(timestamp)],
          "X-Slack-Signature": [expectedSig],
        },
        rawBody,
        nowSeconds: timestamp + 120,
      });
      expect(verified).toEqual({
        valid: true,
        timestampSeconds: timestamp,
      });

      // Default wall-clock nowSeconds path
      const liveNow = Math.floor(Date.now() / 1000);
      const liveSig = computeSlackSignature(TEST_SIGNING_KEY, liveNow, rawBody);
      expect(
        verifySlackRequestSignature({
          signingSecret: TEST_SIGNING_KEY,
          headers: {
            "x-slack-request-timestamp": String(liveNow),
            "x-slack-signature": liveSig,
          },
          rawBody,
        }),
      ).toEqual({
        valid: true,
        timestampSeconds: liveNow,
      });
    });

    it("rejects missing headers, malformed timestamps, replay-window violations, and invalid signatures", () => {
      const rawBody = new TextEncoder().encode('{"type":"url_verification","challenge":"ping"}');
      const nowSeconds = 1_700_000_000;
      const validSig = computeSlackSignature(TEST_SIGNING_KEY, nowSeconds, rawBody);

      expect(
        verifySlackRequestSignature({
          signingSecret: TEST_SIGNING_KEY,
          headers: { "x-slack-request-timestamp": "   " },
          rawBody,
          nowSeconds,
        }),
      ).toMatchObject({ valid: false, reason: "missing_timestamp" });

      expect(
        verifySlackRequestSignature({
          signingSecret: TEST_SIGNING_KEY,
          headers: {
            "x-slack-request-timestamp": String(nowSeconds),
            "x-slack-signature": ["   "],
          },
          rawBody,
          nowSeconds,
        }),
      ).toMatchObject({ valid: false, reason: "missing_signature" });

      expect(
        verifySlackRequestSignature({
          signingSecret: TEST_SIGNING_KEY,
          headers: {
            "x-slack-request-timestamp": "1700000000abc",
            "x-slack-signature": validSig,
          },
          rawBody,
          nowSeconds,
        }),
      ).toMatchObject({ valid: false, reason: "invalid_timestamp" });

      expect(
        verifySlackRequestSignature({
          signingSecret: TEST_SIGNING_KEY,
          headers: {
            "x-slack-request-timestamp": String(nowSeconds - 301),
            "x-slack-signature": computeSlackSignature(TEST_SIGNING_KEY, nowSeconds - 301, rawBody),
          },
          rawBody,
          nowSeconds,
        }),
      ).toMatchObject({ valid: false, reason: "timestamp_expired" });

      expect(
        verifySlackRequestSignature({
          signingSecret: TEST_SIGNING_KEY,
          headers: {
            "x-slack-request-timestamp": String(nowSeconds),
            "x-slack-signature": "v1=0000",
          },
          rawBody,
          nowSeconds,
        }),
      ).toMatchObject({ valid: false, reason: "signature_mismatch" });

      expect(
        verifySlackRequestSignature({
          signingSecret: TEST_SIGNING_KEY,
          headers: {
            "x-slack-request-timestamp": String(nowSeconds),
            "x-slack-signature": `v0=${"0".repeat(64)}`,
          },
          rawBody,
          nowSeconds,
        }),
      ).toMatchObject({ valid: false, reason: "signature_mismatch" });

      expect(() => computeSlackSignature("", nowSeconds, rawBody)).toThrow(
        ConnectorValidationError,
      );
      expect(() => computeSlackSignature(TEST_SIGNING_KEY, "not-int", rawBody)).toThrow(
        ConnectorValidationError,
      );
    });
  });

  describe("SlackApiClient", () => {
    it("validates token prefixes and performs auth.test and apps.connections.open", async () => {
      expect(() => new SlackApiClient({})).toThrow(ConnectorValidationError);
      expect(() => new SlackApiClient({ botToken: "xoxp-wrong" })).toThrow(
        ConnectorValidationError,
      );
      expect(() => new SlackApiClient({ appToken: "xoxb-wrong" })).toThrow(
        ConnectorValidationError,
      );

      const calls: Array<{ url: string; auth: string | null; contentType: string | null }> = [];
      const mockFetch: typeof fetch = vi.fn(async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          auth: headers.get("authorization"),
          contentType: headers.get("content-type"),
        });
        if (url.endsWith("/auth.test")) {
          return new Response(
            JSON.stringify({
              ok: true,
              url: "https://example.slack.com/",
              team: "Example",
              user: "dsh_bot",
              team_id: "T0123456789",
              user_id: "U0123456789",
              bot_id: "B0123456789",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            url: "wss://wss-primary.slack.com/link/?ticket=ticket-001&app_id=A0123456789",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        appToken: TEST_APP_TOKEN,
        fetchFn: mockFetch,
      });

      const identity = await client.authTest();
      expect(identity.user_id).toBe("U0123456789");
      expect(identity.bot_id).toBe("B0123456789");

      const conn = await client.openSocketConnection();
      expect(conn.url).toBe(
        "wss://wss-primary.slack.com/link/?ticket=ticket-001&app_id=A0123456789",
      );

      expect(calls[0]).toEqual({
        url: "https://slack.com/api/auth.test",
        auth: `Bearer ${TEST_BOT_TOKEN}`,
        contentType: "application/x-www-form-urlencoded;charset=utf-8",
      });
      expect(calls[1]).toEqual({
        url: "https://slack.com/api/apps.connections.open",
        auth: `Bearer ${TEST_APP_TOKEN}`,
        contentType: "application/x-www-form-urlencoded;charset=utf-8",
      });
    });

    it("retries HTTP 429 once and classifies Slack auth vs transport failures", async () => {
      let attempt = 0;
      const rateLimitedFetch: typeof fetch = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            status: 429,
            headers: { "retry-after": "0.1" },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            channel: "C0123456789",
            ts: "1717171717.000500",
            warning: "missing_charset",
          }),
          { status: 200 },
        );
      });

      const client = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: rateLimitedFetch,
      });

      const posted = await client.postMessage({
        channel: "C0123456789",
        text: "Hello <!channel>!",
      });
      expect(posted.ts).toBe("1717171717.000500");
      expect(posted.warning).toBe("missing_charset");
      expect(attempt).toBe(2);

      // Auth error classification (both Slack error code and HTTP 401 without error string)
      const authFailClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(
          async () =>
            new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }),
        ),
      });
      await expect(
        authFailClient.postMessage({ channel: "C0123456789", text: "hi" }),
      ).rejects.toThrow(ConnectorAuthError);

      const http401Client = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 401 })),
      });
      await expect(
        http401Client.postMessage({ channel: "C0123456789", text: "hi" }),
      ).rejects.toThrow(ConnectorAuthError);

      // Transport error classification (retryable vs non-retryable, and HTTP error without Slack error string)
      const serverErrClient = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 503 })),
      });
      await expect(
        serverErrClient.postMessage({ channel: "C0123456789", text: "hi" }),
      ).rejects.toMatchObject({
        name: "ConnectorTransportError",
        statusCode: 503,
        retryable: true,
      });

      // Unsafe Socket Mode URL rejection
      const insecureWsClient = new SlackApiClient({
        appToken: TEST_APP_TOKEN,
        fetchFn: vi.fn(
          async () =>
            new Response(JSON.stringify({ ok: true, url: "ws://insecure.slack.com/link" }), {
              status: 200,
            }),
        ),
      });
      await expect(insecureWsClient.openSocketConnection()).rejects.toThrow(
        ConnectorTransportError,
      );
    });
  });

  describe("createSlackSender", () => {
    it("sends threaded replies and top-level DMs via chat.postMessage with context markers and structured SlackSendResult", async () => {
      const sentBodies: Array<Record<string, unknown>> = [];
      const client = new SlackApiClient({
        botToken: TEST_BOT_TOKEN,
        fetchFn: vi.fn(async (_input, init) => {
          const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          sentBodies.push(parsedBody);
          return new Response(
            JSON.stringify({
              ok: true,
              channel: parsedBody["channel"],
              ts: "1717171717.000999",
              message: {
                text: "Delivered",
                ts: "1717171717.000999",
              },
              warning: "superfluous_charset",
            }),
            { status: 200 },
          );
        }),
      });

      const activeThreads: Array<{ channelId: string; threadTs: string }> = [];
      const sender = createSlackSender({
        connectorName: "slack",
        apiClient: client,
        includeContextMarker: true,
        contextMarkerStyle: "bracket",
        onThreadActive: (channelId, threadTs) => {
          activeThreads.push({ channelId, threadTs });
        },
      });

      const parsedParams = slackSendSchema.parse({
        text: "Deployment finished <!here>",
        replyBroadcast: true,
      });

      const ctx = createConnectorContext("slack", "channel:C0123456789:1717171717.000100");
      const result = await sender.send(ctx, parsedParams);

      expect(sentBodies).toHaveLength(1);
      expect(sentBodies[0]).toMatchObject({
        channel: "C0123456789",
        thread_ts: "1717171717.000100",
        reply_broadcast: true,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      });

      const wireText = String(sentBodies[0]?.["text"]);
      expect(wireText).toContain("@here");
      expect(wireText).not.toContain("<!here>");
      const extracted = extractContextMarker(wireText);
      expect(extracted.contextId).toBe("channel:C0123456789:1717171717.000100");
      expect(extracted.cleanedContent).toBe("Deployment finished @here");

      expect(result).toMatchObject({
        externalId: "C0123456789:1717171717.000999",
        channelId: "C0123456789",
        messageTs: "1717171717.000999",
        threadTs: "1717171717.000100",
      });
      expect(activeThreads).toEqual([{ channelId: "C0123456789", threadTs: "1717171717.000100" }]);

      // Top-level DM without threadTs and without includeContextMarker
      const plainSender = createSlackSender({
        connectorName: "slack",
        apiClient: client,
      });
      const dmCtx = createConnectorContext("slack", "dm:D0123456789");
      const dmResult = await plainSender.send(dmCtx, { text: "Direct ping", mrkdwn: false });
      expect(dmResult.threadTs).toBeUndefined();
      expect(dmResult.summary).toBe("Sent Slack message to D0123456789");
      expect(sentBodies[1]).toMatchObject({
        channel: "D0123456789",
        text: "Direct ping",
        mrkdwn: false,
      });

      const unroutedCtx = createConnectorContext("slack", "550e8400-e29b-41d4-a716-446655440000");
      await expect(
        sender.send(unroutedCtx, slackSendSchema.parse({ text: "Missing target" })),
      ).rejects.toThrow(ConnectorTargetRequiredError);
    });
  });
});
