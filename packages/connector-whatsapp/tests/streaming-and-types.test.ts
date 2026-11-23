import { describe, expect, it } from "vitest";
import { createDefaultContextIdGenerator, type ConnectorContextId } from "@dsh-connector/core";
import {
  DEFAULT_WHATSAPP_API_VERSION,
  DEFAULT_WHATSAPP_CONNECTOR_NAME,
  DEFAULT_WHATSAPP_STATUS_REACTIONS,
  WHATSAPP_GRAPH_API_BASE_URL,
  WHATSAPP_MAX_TEXT_LENGTH,
  WHATSAPP_TYPING_MAX_TTL_MS,
} from "../src/constants";
import {
  formatWhatsAppContextId,
  normalizeWhatsAppPhoneDigits,
  parseWhatsAppTargetFromContextId,
  SentMessageTracker,
} from "../src/context-id";
import {
  buildMarkReadPayload,
  buildReactionPayload,
  buildTypingIndicatorPayload,
  resolveStatusReactionEmoji,
} from "../src/streaming";
import { whatsappReceiveSchema, whatsappSendSchema } from "../src/types";

describe("constants and schemas", () => {
  it("exposes official Meta WhatsApp Cloud API protocol constants", () => {
    expect(DEFAULT_WHATSAPP_CONNECTOR_NAME).toBe("whatsapp");
    expect(WHATSAPP_GRAPH_API_BASE_URL).toBe("https://graph.facebook.com");
    expect(DEFAULT_WHATSAPP_API_VERSION).toBe("v25.0");
    expect(WHATSAPP_MAX_TEXT_LENGTH).toBe(4096);
    expect(WHATSAPP_TYPING_MAX_TTL_MS).toBe(25_000);
  });

  it("validates whatsappSendSchema with required text and optional target fields", () => {
    const minimal = whatsappSendSchema.parse({ text: "Hello from DSH" });
    expect(minimal).toEqual({ text: "Hello from DSH" });

    const full = whatsappSendSchema.parse({
      text: "Check https://developers.facebook.com",
      to: "+16505551234",
      recipientType: "individual",
      replyToMessageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA",
      previewUrl: true,
    });
    expect(full.to).toBe("+16505551234");
    expect(full.previewUrl).toBe(true);

    expect(() => whatsappSendSchema.parse({ text: "" })).toThrow();
    expect(() => whatsappSendSchema.parse({})).toThrow();
  });

  it("validates whatsappReceiveSchema for inbound Cloud API messages", () => {
    const parsed = whatsappReceiveSchema.parse({
      messageId: "wamid.inbound1",
      from: "16505551234",
      waId: "16505551234",
      senderName: "Alice",
      phoneNumberId: "106540352242922",
      businessAccountId: "102290129340398",
      recipientType: "individual",
      messageType: "text",
      text: "Ping",
      timestamp: "1739321024",
      replyToMessageId: "wamid.parent1",
      replyToFrom: "15550783881",
    });
    expect(parsed.messageId).toBe("wamid.inbound1");
    expect(parsed.replyToMessageId).toBe("wamid.parent1");
  });
});

describe("context-id helpers and SentMessageTracker", () => {
  it("normalizes phone numbers to digits for consistent comparison", () => {
    expect(normalizeWhatsAppPhoneDigits("+1 (650) 555-1234")).toBe("16505551234");
    expect(normalizeWhatsAppPhoneDigits("16505551234")).toBe("16505551234");
  });

  it("formats and parses structured direct, p2p, and group context IDs while rejecting pure UUIDs", () => {
    const directId = formatWhatsAppContextId({
      recipientType: "individual",
      to: "16505551234",
    });
    expect(directId).toBe("direct:16505551234");
    expect(parseWhatsAppTargetFromContextId(directId)).toEqual({
      recipientType: "individual",
      to: "16505551234",
    });

    expect(parseWhatsAppTargetFromContextId("p2p:+16505551234")).toEqual({
      recipientType: "individual",
      to: "+16505551234",
    });

    const groupId = formatWhatsAppContextId({
      recipientType: "group",
      to: "Y2FwaV9ncm91cDoxNzA1NTU1MDEzOQ",
    });
    expect(groupId).toBe("group:Y2FwaV9ncm91cDoxNzA1NTU1MDEzOQ");
    expect(parseWhatsAppTargetFromContextId(groupId)).toEqual({
      recipientType: "group",
      to: "Y2FwaV9ncm91cDoxNzA1NTU1MDEzOQ",
    });

    const uuidContextId = createDefaultContextIdGenerator().generate("whatsapp");
    expect(parseWhatsAppTargetFromContextId(uuidContextId)).toBeUndefined();
    expect(parseWhatsAppTargetFromContextId("direct:   ")).toBeUndefined();
    expect(parseWhatsAppTargetFromContextId("group:")).toBeUndefined();
    expect(parseWhatsAppTargetFromContextId("unknown:123")).toBeUndefined();
  });

  it("tracks outbound message IDs with bounded FIFO eviction and context lookup", () => {
    const tracker = new SentMessageTracker(3);
    const ctxA = "uuid-ctx-a" as ConnectorContextId;
    const ctxB = "direct:16505551234" as ConnectorContextId;

    tracker.record("wamid.1", ctxA);
    tracker.record("wamid.2", ctxB);
    tracker.record("wamid.3", ctxA);
    expect(tracker.has("wamid.1")).toBe(true);
    expect(tracker.getContextId("wamid.1")).toBe(ctxA);
    expect(tracker.size).toBe(3);

    // Updating existing key refreshes position instead of exceeding capacity
    tracker.record("wamid.1", ctxB);
    expect(tracker.size).toBe(3);
    expect(tracker.getContextId("wamid.1")).toBe(ctxB);

    // Inserting 4th unique key evicts oldest ("wamid.2")
    tracker.record("wamid.4", ctxA);
    expect(tracker.size).toBe(3);
    expect(tracker.has("wamid.2")).toBe(false);
    expect(tracker.has("wamid.1")).toBe(true);
    expect(tracker.has("wamid.4")).toBe(true);

    // Empty message IDs are ignored safely
    tracker.record("", ctxA);
    expect(tracker.has("")).toBe(false);
    expect(() => new SentMessageTracker(0)).toThrow();
  });
});

describe("streaming payload builders (extension seam)", () => {
  it("builds official Cloud API mark-as-read and typing indicator payloads", () => {
    expect(buildMarkReadPayload("wamid.msg1")).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.msg1",
    });

    expect(buildTypingIndicatorPayload("wamid.msg1")).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.msg1",
      typing_indicator: {
        type: "text",
      },
    });
  });

  it("builds official Cloud API reaction payloads including clear reaction", () => {
    expect(
      buildReactionPayload({
        to: "+16505551234",
        recipientType: "individual",
        messageId: "wamid.msg1",
        emoji: "👀",
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+16505551234",
      type: "reaction",
      reaction: {
        message_id: "wamid.msg1",
        emoji: "👀",
      },
    });

    expect(resolveStatusReactionEmoji("processing")).toBe(
      DEFAULT_WHATSAPP_STATUS_REACTIONS.processing,
    );
    expect(resolveStatusReactionEmoji("success")).toBe(DEFAULT_WHATSAPP_STATUS_REACTIONS.success);
    expect(resolveStatusReactionEmoji("error")).toBe(DEFAULT_WHATSAPP_STATUS_REACTIONS.error);
    expect(resolveStatusReactionEmoji("clear")).toBe("");
    expect(resolveStatusReactionEmoji("processing", { processing: "⏳" })).toBe("⏳");
  });
});
