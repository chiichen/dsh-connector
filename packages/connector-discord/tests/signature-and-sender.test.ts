import { generateKeyPairSync, sign } from "node:crypto";
import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
  extractContextMarker,
} from "@dsh-connector/core";
import { describe, expect, it, vi } from "vitest";
import {
  DiscordRestClient,
  DiscordSender,
  verifyDiscordEd25519Signature,
  verifyDiscordInteractionHeaders,
  type DiscordApiMessage,
} from "../src";

function createTestEd25519Keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const rawPublicKeyHex = Buffer.from(jwk.x ?? "", "base64url").toString("hex");
  return {
    publicKeyHex: rawPublicKeyHex,
    signPayload(timestamp: string, rawBody: Uint8Array): string {
      const msg = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody)]);
      return sign(null, msg, privateKey).toString("hex");
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function makeMessage(overrides: Partial<DiscordApiMessage> = {}): DiscordApiMessage {
  return {
    id: "900000000000000001",
    channel_id: "41771983423143937",
    author: { id: "100000000000000001", username: "dsh-bot", bot: true },
    content: "Hello",
    timestamp: "2026-11-23T10:00:00.000Z",
    type: 0,
    ...overrides,
  };
}

describe("Stage 2: Ed25519 webhook signature verification & Discord REST v10 Sender", () => {
  describe("Ed25519 signature verification", () => {
    it("verifies valid X-Signature-Ed25519 + X-Signature-Timestamp payloads and rejects tampered inputs", () => {
      const keys = createTestEd25519Keys();
      const otherKeys = createTestEd25519Keys();
      const bodyBytes = new TextEncoder().encode(JSON.stringify({ type: 1 }));
      const timestamp = "1763892000";
      const signature = keys.signPayload(timestamp, bodyBytes);

      expect(
        verifyDiscordEd25519Signature({
          publicKeyHex: keys.publicKeyHex,
          signatureHex: signature,
          timestamp,
          rawBody: bodyBytes,
        }),
      ).toBe(true);

      // Tampered body
      expect(
        verifyDiscordEd25519Signature({
          publicKeyHex: keys.publicKeyHex,
          signatureHex: signature,
          timestamp,
          rawBody: new TextEncoder().encode(JSON.stringify({ type: 2 })),
        }),
      ).toBe(false);

      // Tampered timestamp
      expect(
        verifyDiscordEd25519Signature({
          publicKeyHex: keys.publicKeyHex,
          signatureHex: signature,
          timestamp: "1763892001",
          rawBody: bodyBytes,
        }),
      ).toBe(false);

      // Wrong public key
      expect(
        verifyDiscordEd25519Signature({
          publicKeyHex: otherKeys.publicKeyHex,
          signatureHex: signature,
          timestamp,
          rawBody: bodyBytes,
        }),
      ).toBe(false);

      // Invalid hex lengths / non-hex chars
      expect(
        verifyDiscordEd25519Signature({
          publicKeyHex: "abcd",
          signatureHex: signature,
          timestamp,
          rawBody: bodyBytes,
        }),
      ).toBe(false);
      expect(
        verifyDiscordEd25519Signature({
          publicKeyHex: keys.publicKeyHex,
          signatureHex: "zzzz",
          timestamp,
          rawBody: bodyBytes,
        }),
      ).toBe(false);
    });

    it("extracts case-insensitive headers and enforces optional maxSignatureAgeMs window", () => {
      const keys = createTestEd25519Keys();
      const bodyBytes = new TextEncoder().encode('{"type":1}');
      const nowMs = 1_763_892_000_000;
      const timestamp = "1763891995"; // 5 seconds ago
      const signature = keys.signPayload(timestamp, bodyBytes);

      expect(
        verifyDiscordInteractionHeaders({
          publicKeyHex: keys.publicKeyHex,
          headers: {
            "X-Signature-Ed25519": [signature],
            "X-Signature-Timestamp": timestamp,
          },
          rawBody: bodyBytes,
          maxSignatureAgeMs: 10_000,
          nowMs,
        }),
      ).toBe(true);

      // Default Date.now() path on maxSignatureAgeMs + empty header array
      const liveTs = String(Math.floor(Date.now() / 1000));
      const liveSig = keys.signPayload(liveTs, bodyBytes);
      expect(
        verifyDiscordInteractionHeaders({
          publicKeyHex: keys.publicKeyHex,
          headers: {
            "x-signature-ed25519": liveSig,
            "x-signature-timestamp": liveTs,
          },
          rawBody: bodyBytes,
          maxSignatureAgeMs: 60_000,
        }),
      ).toBe(true);
      expect(
        verifyDiscordInteractionHeaders({
          publicKeyHex: keys.publicKeyHex,
          headers: {
            "x-signature-ed25519": [],
            "x-signature-timestamp": liveTs,
          },
          rawBody: bodyBytes,
        }),
      ).toBe(false);

      // Expired outside maxSignatureAgeMs
      expect(
        verifyDiscordInteractionHeaders({
          publicKeyHex: keys.publicKeyHex,
          headers: {
            "x-signature-ed25519": signature,
            "x-signature-timestamp": "1763891000",
          },
          rawBody: bodyBytes,
          maxSignatureAgeMs: 10_000,
          nowMs,
        }),
      ).toBe(false);

      // Missing headers or non-numeric timestamp when maxSignatureAgeMs enabled
      expect(
        verifyDiscordInteractionHeaders({
          publicKeyHex: keys.publicKeyHex,
          headers: {},
          rawBody: bodyBytes,
        }),
      ).toBe(false);
      expect(
        verifyDiscordInteractionHeaders({
          publicKeyHex: keys.publicKeyHex,
          headers: {
            "x-signature-ed25519": signature,
            "x-signature-timestamp": "not-a-timestamp",
          },
          rawBody: bodyBytes,
          maxSignatureAgeMs: 10_000,
          nowMs,
        }),
      ).toBe(false);
    });
  });

  describe("DiscordRestClient", () => {
    it("sends Bot authorization & User-Agent headers across v10 endpoints and handles 204 typing", async () => {
      const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
      const fetchFn: typeof fetch = vi.fn(async (input, init) => {
        const url = input instanceof URL ? input.href : String(input);
        calls.push({ url, init });
        if (url.endsWith("/typing")) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/users/@me")) {
          return jsonResponse({ id: "10001", username: "dsh", bot: true });
        }
        if (url.endsWith("/gateway/bot")) {
          return jsonResponse({ url: "wss://gateway.discord.gg/" });
        }
        if (url.includes("/webhooks/")) {
          return jsonResponse(makeMessage({ id: "900009", content: "updated interaction" }));
        }
        if (init?.method === "PATCH") {
          return jsonResponse(makeMessage({ id: "900002", content: "edited" }));
        }
        return jsonResponse(makeMessage());
      });

      const api = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn,
      });

      const me = await api.getCurrentUser();
      expect(me.id).toBe("10001");

      const gw = await api.getGatewayBot();
      expect(gw.url).toBe("wss://gateway.discord.gg/");

      await api.triggerTypingIndicator("41771983423143937");
      const edited = await api.editMessage({
        channelId: "41771983423143937",
        messageId: "900002",
        content: "edited",
      });
      expect(edited.content).toBe("edited");

      const updatedInteraction = await api.editOriginalInteractionResponse({
        applicationId: "20001",
        interactionToken: "tok_abc",
        content: "updated interaction",
        threadId: "30001",
        withComponents: true,
      });
      expect(updatedInteraction.id).toBe("900009");

      expect(() =>
        api.editOriginalInteractionResponse({
          applicationId: "20001",
          interactionToken: "   ",
          content: "bad",
        }),
      ).toThrow(ConnectorValidationError);

      const firstHeaders = calls[0]?.init?.headers as Record<string, string>;
      expect(firstHeaders["authorization"]).toBe("Bot test-bot-token");
      expect(firstHeaders["user-agent"]).toMatch(/^DiscordBot \(/);
      expect(calls[4]?.url).toBe(
        "https://discord.com/api/v10/webhooks/20001/tok_abc/messages/@original?thread_id=30001&with_components=true",
      );
    });

    it("supports getChannel, startThreadFromMessage, malformed JSON error, and aborted 429 backoff", async () => {
      const api = new DiscordRestClient({
        botToken: "test-bot-token",
        baseUrl: "https://discord.com/api/v10",
        fetchFn: vi.fn(async (input, init) => {
          const url = input instanceof URL ? input.href : String(input);
          if (url.endsWith("/threads")) {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return jsonResponse({ id: "88888", type: 11, name: body["name"] });
          }
          return jsonResponse({ id: "41771983423143937", type: 0, name: "general" });
        }),
      });

      const ch = await api.getChannel("41771983423143937");
      expect(ch.name).toBe("general");

      const thread = await api.startThreadFromMessage({
        channelId: "41771983423143937",
        messageId: "334385199974967042",
        name: "   ",
        autoArchiveDuration: 60,
      });
      expect(thread.id).toBe("88888");
      expect(thread.name).toBe("DeepSeek Harness");

      // Malformed 200 JSON
      const badJsonApi = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn: vi.fn(async () => new Response("not-json", { status: 200 })),
      });
      await expect(badJsonApi.getCurrentUser()).rejects.toThrow(ConnectorTransportError);

      // Aborted 429 retry
      const abortController = new AbortController();
      const abort429Api = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn: vi.fn(async () => {
          setTimeout(() => abortController.abort(new Error("user cancelled")), 10);
          return jsonResponse({ retry_after: 5 }, 429);
        }),
      });
      await expect(abort429Api.getCurrentUser({ signal: abortController.signal })).rejects.toThrow(
        ConnectorTransportError,
      );

      // Already aborted before 429 wait
      const preAborted = new AbortController();
      preAborted.abort();
      const preAborted429Api = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn: vi.fn(
          async () => new Response("{}", { status: 429, headers: { "retry-after": "1" } }),
        ),
      });
      await expect(preAborted429Api.getCurrentUser({ signal: preAborted.signal })).rejects.toThrow(
        ConnectorTransportError,
      );
    });

    it("retries HTTP 429 rate limits once and maps 401/403/500/network errors to core error classes", async () => {
      let attempt = 0;
      const rateLimitedFetch: typeof fetch = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return jsonResponse({ message: "You are being rate limited.", retry_after: 0.05 }, 429);
        }
        return jsonResponse(makeMessage({ id: "900100" }));
      });

      const api = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn: rateLimitedFetch,
      });
      const recovered = await api.createMessage({
        channelId: "41771983423143937",
        content: "after 429",
      });
      expect(recovered.id).toBe("900100");
      expect(attempt).toBe(2);

      // Auth error (401)
      const authApi = new DiscordRestClient({
        botToken: "bad-token",
        fetchFn: vi.fn(async () => jsonResponse({ code: 50014, message: "Invalid token" }, 401)),
      });
      await expect(
        authApi.createMessage({ channelId: "41771983423143937", content: "hi" }),
      ).rejects.toThrow(ConnectorAuthError);

      // Missing botToken on bot route vs allowed on token-authenticated @original webhook route
      const tokenlessApi = new DiscordRestClient({
        fetchFn: vi.fn(async () => jsonResponse(makeMessage())),
      });
      await expect(tokenlessApi.getCurrentUser()).rejects.toThrow(ConnectorAuthError);
      const editedOrig = await tokenlessApi.editOriginalInteractionResponse({
        applicationId: "20001",
        interactionToken: "tok_no_bot",
        content: "updated without bot token",
      });
      expect(editedOrig.id).toBe("900000000000000001");

      // 403 Forbidden on expectBody: false route (triggerTypingIndicator)
      const forbiddenApi = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn: vi.fn(async () => jsonResponse({ message: "Missing Access" }, 403)),
      });
      await expect(forbiddenApi.triggerTypingIndicator("41771983423143937")).rejects.toThrow(
        ConnectorAuthError,
      );

      // 502 retryable transport error
      const serverErrApi = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn: vi.fn(async () => new Response("Bad Gateway", { status: 502 })),
      });
      await expect(
        serverErrApi.createMessage({ channelId: "41771983423143937", content: "hi" }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ConnectorTransportError && err.statusCode === 502 && err.retryable,
      );

      // Network failure
      const netErrApi = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn: vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      });
      await expect(
        netErrApi.createMessage({ channelId: "41771983423143937", content: "hi" }),
      ).rejects.toThrow(ConnectorTransportError);

      // 429 rate-limit with pre-aborted signal & header-based retry-after fallback
      const preAborted = new AbortController();
      preAborted.abort(new Error("already aborted"));
      const rateLimitPreAbortedApi = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn: vi.fn(
          async () =>
            new Response("{}", {
              status: 429,
              headers: { "retry-after": "0" },
            }),
        ),
      });
      await expect(
        rateLimitPreAbortedApi.createMessage({
          channelId: "41771983423143937",
          content: "hi",
          signal: preAborted.signal,
        }),
      ).rejects.toThrow(ConnectorTransportError);
    });
  });

  describe("DiscordSender", () => {
    it("sends chunked >2000-char messages, attaches reply reference only on first chunk, and caches DM user channels", async () => {
      const postedBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
      let msgSeq = 0;

      const fetchFn: typeof fetch = vi.fn(async (input, init) => {
        const url = input instanceof URL ? input.href : String(input);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        postedBodies.push({ url, body });

        if (url.endsWith("/users/@me/channels")) {
          return jsonResponse({ id: "777000111222333444", type: 1 });
        }

        msgSeq += 1;
        return jsonResponse(
          makeMessage({
            id: `90000000000000000${msgSeq}`,
            channel_id: url.includes("777000111222333444")
              ? "777000111222333444"
              : "555666777888999000",
            content: String(body["content"] ?? ""),
          }),
        );
      });

      const api = new DiscordRestClient({
        botToken: "test-bot-token",
        fetchFn,
      });
      const sender = new DiscordSender({
        connectorName: "discord",
        api,
        includeContextMarker: true,
      });

      const threadCtx = createConnectorContext(
        "discord",
        "thread:41771983423143937:555666777888999000",
      );
      const longText = `${"Chunk paragraph one. ".repeat(65)}\n\n${"Chunk paragraph two. ".repeat(65)}`;
      const res = await sender.send(threadCtx, {
        text: longText,
        replyToMessageId: "111222333444555666",
      });

      expect(res.messageIds.length).toBe(2);
      expect(res.messageId).toBe("900000000000000001");
      expect(res.externalId).toBe("900000000000000001");
      expect(res.channelId).toBe("555666777888999000");
      expect(res.threadId).toBe("555666777888999000");
      expect(res.data).toEqual({
        messageId: "900000000000000001",
        messageIds: ["900000000000000001", "900000000000000002"],
        channelId: "555666777888999000",
        threadId: "555666777888999000",
      });

      // Every chunk must strictly obey Discord's 2000-character limit even with prepended context marker!
      expect(String(postedBodies[0]?.body["content"]).length).toBeLessThanOrEqual(2000);
      expect(String(postedBodies[1]?.body["content"]).length).toBeLessThanOrEqual(2000);

      // First chunk has context marker and message_reference; second chunk does not repeat message_reference
      const extracted = extractContextMarker(String(postedBodies[0]?.body["content"]));
      expect(extracted.contextId).toBe("thread:41771983423143937:555666777888999000");
      expect(postedBodies[0]?.body["message_reference"]).toEqual({
        message_id: "111222333444555666",
        channel_id: "555666777888999000",
        fail_if_not_exists: false,
      });
      expect(postedBodies[1]?.body["message_reference"]).toBeUndefined();

      // Proactive DM by userId opens DM channel once and caches it on second send
      const uuidCtx = createConnectorContext("discord", "550e8400-e29b-41d4-a716-446655440000");
      await sender.send(uuidCtx, {
        text: "Hello via DM 1",
        userId: "80351110224678912",
        includeContextMarker: false,
      });
      await sender.send(uuidCtx, {
        text: "Hello via DM 2",
        userId: "80351110224678912",
        includeContextMarker: false,
      });
      const dmCreateCalls = postedBodies.filter((entry) =>
        entry.url.endsWith("/users/@me/channels"),
      );
      expect(dmCreateCalls).toHaveLength(1);
      expect(dmCreateCalls[0]?.body).toEqual({ recipient_id: "80351110224678912" });

      const channelCtx = createConnectorContext("discord", "channel:41771983423143937");
      const singleRes = await sender.send(channelCtx, {
        text: "Short channel update",
        includeContextMarker: false,
      });
      expect(singleRes.messageIds).toHaveLength(1);

      // Missing target with UUID context throws ConnectorTargetRequiredError
      await expect(sender.send(uuidCtx, { text: "no target" })).rejects.toThrow(
        ConnectorTargetRequiredError,
      );
    });
  });
});
