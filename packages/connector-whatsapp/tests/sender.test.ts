import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  createConnectorContext,
  createDefaultContextIdGenerator,
} from "@dsh-connector/core";
import { WHATSAPP_MAX_TEXT_LENGTH } from "../src/constants";
import { SentMessageTracker } from "../src/context-id";
import { createWhatsAppSender } from "../src/sender";
import type { WhatsAppCloudSendTextRequest } from "../src/types";

function createJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WhatsApp Cloud API outbound Sender", () => {
  it("sends text message with three-tier target priority (explicit params > structured contextId > error)", async () => {
    const capturedRequests: Array<{
      url: string;
      headers: Headers;
      body: WhatsAppCloudSendTextRequest;
    }> = [];
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as WhatsAppCloudSendTextRequest;
      capturedRequests.push({ url, headers, body });
      return createJsonResponse(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: body.to, wa_id: "16505551234" }],
        messages: [{ id: `wamid.out.${capturedRequests.length}` }],
      });
    });

    const tracker = new SentMessageTracker();
    const sender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "EAATestToken123",
      phoneNumberId: "106540352242922",
      fetchFn,
      sentMessageTracker: tracker,
    });

    // Tier 1: Explicit `to` overrides contextId (even when contextId is a pure UUID)
    const uuidCtx = createConnectorContext(
      "whatsapp",
      createDefaultContextIdGenerator().generate("whatsapp"),
    );
    const res1 = await sender.send(uuidCtx, {
      text: "Hello https://example.com",
      to: "+16505551234",
      previewUrl: true,
    });

    expect(capturedRequests[0]?.url).toBe(
      "https://graph.facebook.com/v25.0/106540352242922/messages",
    );
    expect(capturedRequests[0]?.headers.get("authorization")).toBe("Bearer EAATestToken123");
    expect(capturedRequests[0]?.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+16505551234",
      type: "text",
      text: {
        body: `[#ctx:${uuidCtx.contextId}]\nHello https://example.com`,
        preview_url: true,
      },
    });
    expect(res1.messageId).toBe("wamid.out.1");
    expect(res1.externalId).toBe("wamid.out.1");
    expect(res1.recipientId).toBe("16505551234");
    expect(tracker.getContextId("wamid.out.1")).toBe(uuidCtx.contextId);

    // Tier 2: Structured `direct:<waId>` and `group:<groupId>` contextId fallback
    const directCtx = createConnectorContext("whatsapp", "direct:16505559999");
    await sender.send(directCtx, {
      text: "Contextual reply",
      replyToMessageId: "wamid.user.inbound.1",
    });
    expect(capturedRequests[1]?.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "16505559999",
      type: "text",
      context: { message_id: "wamid.user.inbound.1" },
      text: { body: "[#ctx:direct:16505559999]\nContextual reply" },
    });

    const groupCtx = createConnectorContext("whatsapp", "group:Y2FwaV9ncm91cDox");
    const groupSend = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "EAATestToken123",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async () =>
        createJsonResponse(200, {
          messaging_product: "whatsapp",
          messages: [{ id: "wamid.group.out.1", group_id: "Y2FwaV9ncm91cDox" }],
        }),
      ),
      sentMessageTracker: tracker,
    });
    const groupRes = await groupSend.send(groupCtx, { text: "Group update" });
    expect(groupRes.recipientId).toBe("Y2FwaV9ncm91cDox");

    // Tier 3: Pure UUID contextId without explicit `to` throws ConnectorTargetRequiredError
    await expect(sender.send(uuidCtx, { text: "Missing target" })).rejects.toThrow(
      ConnectorTargetRequiredError,
    );
  });

  it("chunks >4096 char messages sequentially and attaches context.message_id only on first chunk", async () => {
    const bodies: WhatsAppCloudSendTextRequest[] = [];
    const fetchFn: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as WhatsAppCloudSendTextRequest;
      bodies.push(body);
      return createJsonResponse(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: `wamid.chunk.${bodies.length}` }],
      });
    });

    const tracker = new SentMessageTracker();
    const sender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: async () => "dynamic-token",
      phoneNumberId: "106540352242922",
      contextMarkerStyle: "bracket",
      fetchFn,
      sentMessageTracker: tracker,
    });

    const ctx = createConnectorContext("whatsapp", "direct:8613800138000");
    const longParagraphA = "A".repeat(3000);
    const longParagraphB = "B".repeat(3000);
    const result = await sender.send(ctx, {
      text: `${longParagraphA}\n\n${longParagraphB}`,
      replyToMessageId: "wamid.quote.target",
    });

    expect(bodies.length).toBe(2);
    expect(bodies[0]?.text.body.startsWith("[#ctx:direct:8613800138000]\n")).toBe(true);
    expect(bodies[0]?.text.body.length).toBeLessThanOrEqual(WHATSAPP_MAX_TEXT_LENGTH);
    expect(bodies[0]?.context).toEqual({ message_id: "wamid.quote.target" });
    expect(bodies[1]?.context).toBeUndefined();
    expect(bodies[1]?.text.body.length).toBeLessThanOrEqual(WHATSAPP_MAX_TEXT_LENGTH);

    expect(result.messageId).toBe("wamid.chunk.1");
    expect(result.messageIds).toEqual(["wamid.chunk.1", "wamid.chunk.2"]);
    expect(tracker.has("wamid.chunk.1")).toBe(true);
    expect(tracker.has("wamid.chunk.2")).toBe(true);
  });

  it("maps Cloud API auth, rate-limit, client, malformed response, and network errors accurately", async () => {
    // 1. Empty token -> ConnectorAuthError
    const emptyTokenSender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "   ",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(),
      sentMessageTracker: new SentMessageTracker(),
    });
    const ctx = createConnectorContext("whatsapp", "direct:16505551234");
    await expect(emptyTokenSender.send(ctx, { text: "hi" })).rejects.toThrow(ConnectorAuthError);

    // 2. OAuth error 190 -> ConnectorAuthError
    const authFailSender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "expired-token",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async () =>
        createJsonResponse(401, {
          error: {
            message: "Invalid OAuth access token.",
            type: "OAuthException",
            code: 190,
            error_data: { details: "Session has expired" },
          },
        }),
      ),
      sentMessageTracker: new SentMessageTracker(),
    });
    await expect(authFailSender.send(ctx, { text: "hi" })).rejects.toThrow(ConnectorAuthError);

    // 3. Rate limit 130429 / HTTP 429 -> retryable ConnectorTransportError
    const rateLimitSender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "token",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async () =>
        createJsonResponse(429, {
          error: {
            message: "(#130429) Rate limit hit",
            code: 130429,
            error_data: { details: "Cloud API throughput reached" },
          },
        }),
      ),
      sentMessageTracker: new SentMessageTracker(),
    });
    await expect(rateLimitSender.send(ctx, { text: "hi" })).rejects.toMatchObject({
      name: "ConnectorTransportError",
      statusCode: 429,
      retryable: true,
    });

    // 4. Client 400 error -> non-retryable ConnectorTransportError
    const badParamSender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "token",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async () =>
        createJsonResponse(400, {
          error: {
            message: "(#131009) Parameter value is not valid",
            code: 131009,
          },
        }),
      ),
      sentMessageTracker: new SentMessageTracker(),
    });
    await expect(badParamSender.send(ctx, { text: "hi" })).rejects.toMatchObject({
      name: "ConnectorTransportError",
      statusCode: 400,
      retryable: false,
    });

    // 5. Non-JSON 502 & empty 503 responses -> retryable ConnectorTransportError
    const html502Sender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "token",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async () => new Response("<html>Bad Gateway</html>", { status: 502 })),
      sentMessageTracker: new SentMessageTracker(),
    });
    await expect(html502Sender.send(ctx, { text: "hi" })).rejects.toMatchObject({
      name: "ConnectorTransportError",
      statusCode: 502,
      retryable: true,
    });

    const empty503Sender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "token",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async () => new Response("", { status: 503 })),
      sentMessageTracker: new SentMessageTracker(),
    });
    await expect(empty503Sender.send(ctx, { text: "hi" })).rejects.toMatchObject({
      name: "ConnectorTransportError",
      statusCode: 503,
      retryable: true,
    });

    // 6. Missing messages[0].id in 200 response -> ConnectorTransportError
    const emptyMsgSender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "token",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async () =>
        createJsonResponse(200, { messaging_product: "whatsapp", messages: [] }),
      ),
      sentMessageTracker: new SentMessageTracker(),
    });
    await expect(emptyMsgSender.send(ctx, { text: "hi" })).rejects.toThrow(ConnectorTransportError);

    // 6. Network failure & caller abort signal
    const networkFailSender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "token",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
      sentMessageTracker: new SentMessageTracker(),
    });
    await expect(networkFailSender.send(ctx, { text: "hi" })).rejects.toMatchObject({
      name: "ConnectorTransportError",
      retryable: true,
    });

    const abortController = new AbortController();
    abortController.abort(new Error("user cancelled"));
    const abortedSender = createWhatsAppSender({
      connectorName: "whatsapp",
      accessToken: "token",
      phoneNumberId: "106540352242922",
      fetchFn: vi.fn(async (_url, init) => {
        init?.signal?.throwIfAborted();
        return createJsonResponse(200, {});
      }),
      sentMessageTracker: new SentMessageTracker(),
    });
    await expect(
      abortedSender.send(ctx, { text: "hi" }, { signal: abortController.signal }),
    ).rejects.toMatchObject({
      name: "ConnectorTransportError",
      retryable: false,
    });
  });
});
