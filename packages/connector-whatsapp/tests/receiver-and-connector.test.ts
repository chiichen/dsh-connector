import { describe, expect, it, vi } from "vitest";
import {
  ConnectorValidationError,
  createConnectorContext,
  createDefaultContextIdGenerator,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorLogger,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import {
  computeWhatsAppSignature,
  createWhatsAppConnector,
  WHATSAPP_CONNECTOR_PACKAGE_NAME,
  WhatsAppConnector,
  type WhatsAppReceivePayload,
  type WhatsAppStreamingAdapter,
} from "../src";

const APP_SECRET = "whatsapp-app-secret-xyz";
const VERIFY_TOKEN = "whatsapp-verify-token-abc";
const PHONE_NUMBER_ID = "106540352242922";
const DISPLAY_PHONE = "15550783881";

function createTestLogger(): ConnectorLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildWebhookRequest(options: {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  rawBodyString?: string;
  signWithSecret?: string | false;
  headers?: Record<string, string | readonly string[] | undefined>;
}): ConnectorWebhookRequest {
  const method = options.method ?? "POST";
  const query = new URLSearchParams(options.query ?? {});
  const bodyStr =
    options.rawBodyString ?? (options.body !== undefined ? JSON.stringify(options.body) : "");
  const rawBody = new TextEncoder().encode(bodyStr);
  const headers: Record<string, string | readonly string[] | undefined> = {
    ...options.headers,
  };

  if (method === "POST" && options.signWithSecret !== false) {
    headers["x-hub-signature-256"] = computeWhatsAppSignature(
      rawBody,
      options.signWithSecret ?? APP_SECRET,
    );
  }

  return {
    method,
    pathname: "/webhooks/whatsapp",
    subPath: "/",
    query,
    headers,
    rawBody,
  };
}

describe("WhatsAppConnector & Cloud API Webhook Receiver", () => {
  it("validates connector options and exposes lifecycle & streaming extension slots", () => {
    expect(
      () =>
        new WhatsAppConnector({
          accessToken: "token",
          phoneNumberId: "   ",
        }),
    ).toThrow(ConnectorValidationError);

    expect(
      () =>
        new WhatsAppConnector({
          name: "Invalid--Name",
          accessToken: "token",
          phoneNumberId: PHONE_NUMBER_ID,
        }),
    ).toThrow(ConnectorValidationError);

    const mockStreamingAdapter: WhatsAppStreamingAdapter = {
      startStream: vi.fn(),
      updateStream: vi.fn(),
      completeStream: vi.fn(),
      abortStream: vi.fn(),
    };

    const connector = createWhatsAppConnector({
      accessToken: "token",
      phoneNumberId: PHONE_NUMBER_ID,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      streaming: {
        enabled: false,
        markAsReadOnReceive: true,
        sendTypingIndicator: true,
        adapter: mockStreamingAdapter,
      },
    });

    expect(connector.name).toBe("whatsapp");
    expect(WHATSAPP_CONNECTOR_PACKAGE_NAME).toBe("@dsh-connector/connector-whatsapp");
    expect(connector.getStreamingOptions()?.sendTypingIndicator).toBe(true);
    expect(connector.getStreamingAdapter()).toBe(mockStreamingAdapter);
    expect(connector.isStarted()).toBe(false);
    connector.start();
    expect(connector.isStarted()).toBe(true);
    connector.stop();
    expect(connector.isStarted()).toBe(false);
  });

  it("handles Meta Webhook GET verification requests (hub.mode / hub.verify_token / hub.challenge)", async () => {
    const connector = createWhatsAppConnector({
      accessToken: "token",
      phoneNumberId: PHONE_NUMBER_ID,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    });
    const receiver = connector.getReceiver();

    const okRes = await receiver.handleWebhook!(
      buildWebhookRequest({
        method: "GET",
        query: {
          "hub.mode": "subscribe",
          "hub.verify_token": VERIFY_TOKEN,
          "hub.challenge": "1158201444",
        },
        signWithSecret: false,
      }),
    );
    expect(okRes.status).toBe(200);
    expect(okRes.body).toBe("1158201444");

    // Wrong verify_token -> 403
    const badTokenRes = await receiver.handleWebhook!(
      buildWebhookRequest({
        method: "GET",
        query: {
          "hub.mode": "subscribe",
          "hub.verify_token": "wrong-token",
          "hub.challenge": "1158201444",
        },
        signWithSecret: false,
      }),
    );
    expect(badTokenRes.status).toBe(403);

    // Wrong mode or missing challenge -> 403
    const badModeRes = await receiver.handleWebhook!(
      buildWebhookRequest({
        method: "GET",
        query: {
          "hub.mode": "unsubscribe",
          "hub.verify_token": VERIFY_TOKEN,
          "hub.challenge": "1158201444",
        },
        signWithSecret: false,
      }),
    );
    expect(badModeRes.status).toBe(403);

    // Unsupported HTTP method -> 405
    const putRes = await receiver.handleWebhook!(
      buildWebhookRequest({ method: "PUT", signWithSecret: false }),
    );
    expect(putRes.status).toBe(405);
  });

  it("enforces X-Hub-Signature-256 on POST webhooks and rejects malformed payloads", async () => {
    const connector = createWhatsAppConnector({
      accessToken: "token",
      phoneNumberId: PHONE_NUMBER_ID,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    });
    const receiver = connector.getReceiver();

    // Uninitialized receiver returns 500
    const uninitRes = await receiver.handleWebhook!(
      buildWebhookRequest({ body: { object: "whatsapp_business_account", entry: [] } }),
    );
    expect(uninitRes.status).toBe(500);

    const idGen = createDefaultContextIdGenerator();
    receiver.init!({
      allocateContextId: () => idGen.generate("whatsapp"),
      contextIdGenerator: idGen,
      onReceive: vi.fn(async () => ({ sessionId: "sess-1" })),
      logger: createTestLogger(),
    });

    // Tampered signature -> 401
    const badSigRes = await receiver.handleWebhook!(
      buildWebhookRequest({
        body: { object: "whatsapp_business_account", entry: [] },
        signWithSecret: "wrong-secret",
      }),
    );
    expect(badSigRes.status).toBe(401);

    // Missing appSecret without allowUnsignedWebhooks -> 401
    const unconfiguredConnector = createWhatsAppConnector({
      accessToken: "token",
      phoneNumberId: PHONE_NUMBER_ID,
    });
    unconfiguredConnector.getReceiver().init!({
      allocateContextId: () => idGen.generate("whatsapp"),
      contextIdGenerator: idGen,
      onReceive: vi.fn(async () => ({ sessionId: "sess-1" })),
      logger: createTestLogger(),
    });
    const missingSecretRes = await unconfiguredConnector.getReceiver().handleWebhook!(
      buildWebhookRequest({
        body: { object: "whatsapp_business_account", entry: [] },
        signWithSecret: false,
      }),
    );
    expect(missingSecretRes.status).toBe(401);

    // Malformed JSON -> 400
    const badJsonRes = await receiver.handleWebhook!(
      buildWebhookRequest({ rawBodyString: "{not-json" }),
    );
    expect(badJsonRes.status).toBe(400);

    // Wrong webhook object -> 400
    const wrongObjRes = await receiver.handleWebhook!(
      buildWebhookRequest({ body: { object: "page", entry: [] } }),
    );
    expect(wrongObjRes.status).toBe(400);
  });

  it("parses inbound text, button, interactive, and contextual reply messages while filtering status receipts and bot echoes", async () => {
    const received: Array<{
      context: ConnectorContext<"whatsapp">;
      payload: WhatsAppReceivePayload;
      meta: InboundDeliveryMeta | undefined;
    }> = [];

    const fetchFn: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "+16505551234", wa_id: "16505551234" }],
          messages: [{ id: "wamid.bot.outbound.1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const connector = createWhatsAppConnector({
      accessToken: "EAATest",
      phoneNumberId: PHONE_NUMBER_ID,
      businessPhoneNumber: `+${DISPLAY_PHONE}`,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      allowedSenders: ["+1 (650) 555-1234", "8613800138000"],
      fetchFn,
    });

    const idGen = createDefaultContextIdGenerator();
    const receiverCtx: ConnectorReceiverContext<
      typeof connector.getReceiver extends () => infer R
        ? R extends { schema: infer S }
          ? S
          : never
        : never,
      "whatsapp"
    > = {
      allocateContextId: () => idGen.generate("whatsapp"),
      contextIdGenerator: idGen,
      onReceive: vi.fn(async (context, payload, meta) => {
        received.push({ context, payload, meta });
        return { sessionId: "sess-wa-1", deduplicated: payload.messageId === "wamid.dup.1" };
      }),
      logger: createTestLogger(),
    };
    connector.getReceiver().init!(receiverCtx);

    // Outbound-first notification sent by agent with pre-allocated UUID contextId
    const outboundUuidCtx = createConnectorContext("whatsapp", idGen.generate("whatsapp"));
    await connector.getSender().send(outboundUuidCtx, {
      to: "+16505551234",
      text: "Deployment finished. Reply here if rollback is needed.",
    });

    // Deliver a rich Cloud API webhook batch with:
    // 1. Status receipt (`sent` / `delivered` / `read`) -> ignored
    // 2. Wrong phone_number_id -> ignored
    // 3. Echo of bot's own messageId (`wamid.bot.outbound.1`) -> ignored
    // 4. Message from business's own display phone -> ignored
    // 5. Unauthorized sender not in allowlist -> ignored
    // 6. Reaction / non-text message -> ignored
    // 7. Standard inbound 1:1 text message -> routed to `direct:16505551234`
    // 8. Swipe-reply (`context.id = wamid.bot.outbound.1`) -> routed back to `outboundUuidCtx.contextId`!
    // 9. Message with explicit context marker (`[#ctx:custom-ticket-42]`) -> routed to `custom-ticket-42` and marker stripped
    // 10. Group interactive button reply -> routed to `group:Y2FwaV9ncm91cDox`
    const markedBody = prependContextMarker("Approve release", "custom-ticket-42", "bracket");

    const webhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_102290129340398",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: DISPLAY_PHONE,
                  phone_number_id: PHONE_NUMBER_ID,
                },
                statuses: [
                  {
                    id: "wamid.bot.outbound.1",
                    status: "delivered",
                    timestamp: "1739321000",
                    recipient_id: "16505551234",
                  },
                ],
              },
            },
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "9999999",
                  phone_number_id: "OTHER_PHONE_ID",
                },
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.other.phone",
                    timestamp: "1739321001",
                    type: "text",
                    text: { body: "Should be skipped" },
                  },
                ],
              },
            },
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: DISPLAY_PHONE,
                  phone_number_id: PHONE_NUMBER_ID,
                },
                contacts: [
                  { wa_id: "16505551234", profile: { name: "Sheena Nelson" } },
                  { wa_id: "8613800138000", profile: { name: "Zhang San" } },
                ],
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.bot.outbound.1",
                    timestamp: "1739321002",
                    type: "text",
                    text: { body: "Echoed outbound ID" },
                  },
                  {
                    from: DISPLAY_PHONE,
                    id: "wamid.self.from",
                    timestamp: "1739321003",
                    type: "text",
                    text: { body: "From business phone" },
                  },
                  {
                    from: "447700900000",
                    id: "wamid.blocked.user",
                    timestamp: "1739321004",
                    type: "text",
                    text: { body: "Blocked sender" },
                  },
                  {
                    from: "16505551234",
                    id: "wamid.reaction.1",
                    timestamp: "1739321005",
                    type: "reaction",
                    reaction: { message_id: "wamid.bot.outbound.1", emoji: "👍" },
                  },
                  {
                    from: "16505551234",
                    id: "wamid.user.text.1",
                    timestamp: "1739321010",
                    type: "text",
                    text: { body: "Hello Cloud API!" },
                  },
                  {
                    from: "16505551234",
                    id: "wamid.user.reply.1",
                    timestamp: "1739321020",
                    type: "text",
                    context: {
                      from: DISPLAY_PHONE,
                      id: "wamid.bot.outbound.1",
                    },
                    text: { body: "Please rollback staging" },
                  },
                  {
                    from: "8613800138000",
                    id: "wamid.dup.1",
                    timestamp: "1739321030",
                    type: "button",
                    button: { text: markedBody, payload: "approve" },
                  },
                  {
                    from: "8613800138000",
                    group_id: "Y2FwaV9ncm91cDox",
                    id: "wamid.group.interactive.1",
                    timestamp: "1739321040",
                    type: "interactive",
                    interactive: {
                      type: "button_reply",
                      button_reply: { id: "btn-1", title: "Run diagnostics" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await connector.getReceiver().handleWebhook!(
      buildWebhookRequest({ body: webhookPayload }),
    );
    expect(res.status).toBe(200);
    const bodyJson = JSON.parse(String(res.body)) as {
      status: string;
      processed: number;
      ignored: number;
      deduplicated: number;
    };
    expect(bodyJson).toEqual({
      status: "ok",
      processed: 4,
      ignored: 6,
      deduplicated: 1,
    });

    // Check message 1: standard 1:1 text
    expect(received[0]?.context.contextId).toBe("direct:16505551234");
    expect(received[0]?.payload.text).toBe("Hello Cloud API!");
    expect(received[0]?.payload.senderName).toBe("Sheena Nelson");
    expect(received[0]?.meta).toEqual({
      idempotencyKey: "wamid.user.text.1",
      suggestedTitle: "WhatsApp Sheena Nelson",
      receivedAt: 1739321010 * 1000,
    });

    // Check message 2: contextual swipe-reply to outbound UUID notification!
    expect(received[1]?.context.contextId).toBe(outboundUuidCtx.contextId);
    expect(received[1]?.payload.replyToMessageId).toBe("wamid.bot.outbound.1");
    expect(received[1]?.payload.replyToFrom).toBe(DISPLAY_PHONE);
    expect(received[1]?.payload.text).toBe("Please rollback staging");

    // Check message 3: explicit context marker stripped and bound
    expect(received[2]?.context.contextId).toBe("custom-ticket-42");
    expect(received[2]?.payload.messageType).toBe("button");
    expect(received[2]?.payload.text).toBe("Approve release");

    // Check message 4: group interactive reply
    expect(received[3]?.context.contextId).toBe("group:Y2FwaV9ncm91cDox");
    expect(received[3]?.payload.recipientType).toBe("group");
    expect(received[3]?.payload.groupId).toBe("Y2FwaV9ncm91cDox");
    expect(received[3]?.payload.text).toBe("Run diagnostics");

    // Check formatInbound formatting for both direct reply and group message
    const formattedDirect = connector.getReceiver().formatInbound!(
      received[1]!.payload,
      received[1]!.context,
    );
    expect(formattedDirect).toEqual({
      title: "WhatsApp Sheena Nelson",
      text: "[WhatsApp] Sheena Nelson (16505551234) (replying to wamid.bot.outbound.1):\nPlease rollback staging",
    });

    const formattedGroup = connector.getReceiver().formatInbound!(
      received[3]!.payload,
      received[3]!.context,
    );
    expect(formattedGroup).toEqual({
      title: "WhatsApp Group Y2FwaV9ncm91cDox",
      text: "[WhatsApp Group Y2FwaV9ncm91cDox] Zhang San (8613800138000):\nRun diagnostics",
    });
  });

  it("covers unsigned dev webhooks, list_reply messages, invalid UTF-8/scalar JSON, and missing contact names", async () => {
    const receivedPayloads: WhatsAppReceivePayload[] = [];
    const customAdapter: WhatsAppStreamingAdapter = {
      startStream: vi.fn(),
      updateStream: vi.fn(),
      completeStream: vi.fn(),
      abortStream: vi.fn(),
    };

    const devConnector = createWhatsAppConnector({
      name: "whatsapp-dev",
      accessToken: "token",
      phoneNumberId: PHONE_NUMBER_ID,
      apiBaseUrl: "https://graph.facebook.com/",
      apiVersion: "v24.0",
      requestTimeoutMs: 5_000,
      maxTextLength: 2_000,
      contextMarkerStyle: "html-comment",
      allowUnsignedWebhooks: true,
      streamingAdapter: customAdapter,
    });
    expect(devConnector.getStreamingAdapter()).toBe(customAdapter);

    const idGen = createDefaultContextIdGenerator();
    devConnector.getReceiver().init!({
      allocateContextId: () => idGen.generate("whatsapp-dev"),
      contextIdGenerator: idGen,
      onReceive: vi.fn(async (_ctx, payload) => {
        receivedPayloads.push(payload);
        return { sessionId: "sess-dev" };
      }),
      logger: createTestLogger(),
    });

    // Invalid UTF-8 bytes -> 400
    const badUtf8Res = await devConnector.getReceiver().handleWebhook!({
      method: "POST",
      pathname: "/webhooks/whatsapp-dev",
      subPath: "/",
      query: new URLSearchParams(),
      headers: {},
      rawBody: new Uint8Array([0xff, 0xfe]),
    });
    expect(badUtf8Res.status).toBe(400);

    // JSON scalar -> 400
    const scalarJsonRes = await devConnector.getReceiver().handleWebhook!(
      buildWebhookRequest({ rawBodyString: "123", signWithSecret: false }),
    );
    expect(scalarJsonRes.status).toBe(400);

    // Unsigned dev webhook with non-messages field, missing id/from, marker-only text, and list_reply without contacts
    const edgeRes = await devConnector.getReceiver().handleWebhook!(
      buildWebhookRequest({
        signWithSecret: false,
        body: {
          object: "whatsapp_business_account",
          entry: [
            {
              changes: [
                { field: "account_alerts", value: {} },
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: { phone_number_id: PHONE_NUMBER_ID },
                    messages: [
                      {
                        from: "16505550001",
                        id: "wamid.no.contacts",
                        timestamp: "1739321099",
                        type: "text",
                        text: { body: "No contacts array" },
                      },
                    ],
                  },
                },
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: { phone_number_id: PHONE_NUMBER_ID },
                    contacts: [{ profile: { name: "Missing WaId" } }],
                    messages: [
                      {
                        from: "16505550000",
                        timestamp: "1",
                        type: "text",
                        text: { body: "No ID" },
                      },
                      {
                        from: "16505550000",
                        id: "wamid.marker.only",
                        timestamp: "0",
                        type: "text",
                        text: { body: "[#ctx:empty-after-strip]" },
                      },
                      {
                        from: "16505550000",
                        id: "wamid.list.1",
                        timestamp: "invalid",
                        type: "interactive",
                        interactive: {
                          type: "list_reply",
                          list_reply: { id: "item-1", title: "Selected option A" },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    expect(edgeRes.status).toBe(200);
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[0]?.text).toBe("No contacts array");
    expect(receivedPayloads[1]?.messageType).toBe("interactive");
    expect(receivedPayloads[1]?.text).toBe("Selected option A");
    expect(receivedPayloads[1]?.senderName).toBeUndefined();

    const formatted = devConnector.getReceiver().formatInbound!(
      receivedPayloads[1]!,
      createConnectorContext("whatsapp-dev", "direct:16505550000"),
    );
    expect(formatted).toEqual({
      title: "WhatsApp 16505550000",
      text: "[WhatsApp] 16505550000:\nSelected option A",
    });
  });
});
