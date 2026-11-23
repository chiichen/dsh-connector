import {
  assertNonEmptyContextId,
  ConnectorValidationError,
  type ConnectorContextId,
} from "@dsh-connector/core";
import {
  DEFAULT_OUTBOUND_ECHO_CACHE_SIZE,
  DIRECT_CONTEXT_PREFIX,
  GROUP_CONTEXT_PREFIX,
  P2P_CONTEXT_PREFIX,
} from "./constants";
import type { WhatsAppTarget } from "./types";

const NON_DIGIT_RE = /\D+/g;

/**
 * Strips formatting characters (`+`, spaces, hyphens, parentheses) so phone numbers and `wa_id`
 * values can be compared consistently across outbound requests and inbound webhooks.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#whatsapp-user-phone-number-formats
 */
export function normalizeWhatsAppPhoneDigits(phoneOrWaId: string): string {
  return phoneOrWaId.replace(NON_DIGIT_RE, "");
}

/**
 * Formats a WhatsApp business conversation target into a deterministic `ConnectorContextId`
 * (`direct:<waId>` for 1:1 chats, `group:<groupId>` for Cloud API Groups).
 */
export function formatWhatsAppContextId(target: WhatsAppTarget): ConnectorContextId {
  const trimmed = target.to.trim();
  const prefix = target.recipientType === "group" ? GROUP_CONTEXT_PREFIX : DIRECT_CONTEXT_PREFIX;
  const raw = `${prefix}${trimmed}`;
  assertNonEmptyContextId(raw);
  return raw;
}

/**
 * Extracts a structured WhatsApp target from `ConnectorContext.contextId`.
 * Returns `undefined` for unstructured outbound-first UUIDs so they are never mistaken for
 * recipient phone numbers or group IDs.
 */
export function parseWhatsAppTargetFromContextId(contextId: string): WhatsAppTarget | undefined {
  if (contextId.startsWith(DIRECT_CONTEXT_PREFIX)) {
    const to = contextId.slice(DIRECT_CONTEXT_PREFIX.length).trim();
    return to.length > 0 ? { recipientType: "individual", to } : undefined;
  }
  if (contextId.startsWith(P2P_CONTEXT_PREFIX)) {
    const to = contextId.slice(P2P_CONTEXT_PREFIX.length).trim();
    return to.length > 0 ? { recipientType: "individual", to } : undefined;
  }
  if (contextId.startsWith(GROUP_CONTEXT_PREFIX)) {
    const to = contextId.slice(GROUP_CONTEXT_PREFIX.length).trim();
    return to.length > 0 ? { recipientType: "group", to } : undefined;
  }
  return undefined;
}

/**
 * Bounded FIFO tracker of outbound WhatsApp message IDs (`wamid.*`) mapped to `ConnectorContextId`.
 * Serves two roles:
 * 1. Anti-loop echo filtering if an outbound message ID re-enters via webhook.
 * 2. Resolving the originating `ConnectorContextId` when a customer swipe-replies (`context.id`)
 *    to an outbound notification on WhatsApp Cloud API.
 */
export class SentMessageTracker {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, ConnectorContextId>();

  constructor(maxEntries: number = DEFAULT_OUTBOUND_ECHO_CACHE_SIZE) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new ConnectorValidationError("outboundEchoCacheSize must be a positive safe integer.");
    }
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  record(messageId: string, contextId: ConnectorContextId): void {
    const trimmed = messageId.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (this.entries.has(trimmed)) {
      this.entries.delete(trimmed);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(trimmed, contextId);
  }

  has(messageId: string): boolean {
    return this.entries.has(messageId.trim());
  }

  getContextId(messageId: string): ConnectorContextId | undefined {
    return this.entries.get(messageId.trim());
  }
}
