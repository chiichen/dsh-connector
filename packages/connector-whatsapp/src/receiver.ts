import {
  createConnectorContext,
  extractContextMarker,
  resolveInboundContextId,
  type ConnectorContext,
  type ConnectorInboundPrompt,
  type ConnectorLogger,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import {
  CONTENT_TYPE_JSON,
  CONTENT_TYPE_TEXT_PLAIN,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  HUB_CHALLENGE_QUERY_PARAM,
  HUB_MODE_QUERY_PARAM,
  HUB_SUBSCRIBE_MODE,
  HUB_VERIFY_TOKEN_QUERY_PARAM,
  WHATSAPP_LOG_HANDSHAKE_FAILED,
  MILLISECONDS_PER_SECOND,
  WEBHOOK_SIGNATURE_HEADER,
  WHATSAPP_MESSAGING_PRODUCT,
  WHATSAPP_WEBHOOK_MESSAGES_FIELD,
  WHATSAPP_WEBHOOK_OBJECT,
} from "./constants";
import { normalizeWhatsAppPhoneDigits, type SentMessageTracker } from "./context-id";
import {
  getHeaderCaseInsensitive,
  verifyHubVerifyToken,
  verifyWhatsAppSignature,
} from "./signature";
import {
  whatsappReceiveSchema,
  type WhatsAppInboundMessageType,
  type WhatsAppReceivePayload,
} from "./types";

/**
 * Typed subset of Meta WhatsApp Business Account Webhook notification payloads.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export interface WhatsAppWebhookContact {
  readonly wa_id?: string;
  readonly profile?: {
    readonly name?: string;
  };
}

export interface WhatsAppWebhookMessageContext {
  readonly from?: string;
  readonly id?: string;
}

export interface WhatsAppWebhookIncomingMessage {
  readonly id?: string;
  readonly from?: string;
  readonly group_id?: string;
  readonly timestamp?: string;
  readonly type?: string;
  readonly context?: WhatsAppWebhookMessageContext;
  readonly text?: {
    readonly body?: string;
  };
  readonly button?: {
    readonly text?: string;
    readonly payload?: string;
  };
  readonly interactive?: {
    readonly type?: string;
    readonly button_reply?: {
      readonly id?: string;
      readonly title?: string;
    };
    readonly list_reply?: {
      readonly id?: string;
      readonly title?: string;
      readonly description?: string;
    };
  };
}

export interface WhatsAppWebhookStatusReceipt {
  readonly id?: string;
  readonly status?: string;
  readonly timestamp?: string;
  readonly recipient_id?: string;
}

export interface WhatsAppWebhookChangeValue {
  readonly messaging_product?: string;
  readonly metadata?: {
    readonly display_phone_number?: string;
    readonly phone_number_id?: string;
  };
  readonly contacts?: readonly WhatsAppWebhookContact[];
  readonly messages?: readonly WhatsAppWebhookIncomingMessage[];
  readonly statuses?: readonly WhatsAppWebhookStatusReceipt[];
}

export interface WhatsAppWebhookChange {
  readonly field?: string;
  readonly value?: WhatsAppWebhookChangeValue;
}

export interface WhatsAppWebhookEntry {
  readonly id?: string;
  readonly changes?: readonly WhatsAppWebhookChange[];
}

export interface WhatsAppWebhookEnvelope {
  readonly object?: string;
  readonly entry?: readonly WhatsAppWebhookEntry[];
}

export interface WhatsAppReceiverConfig<TName extends string = "whatsapp"> {
  readonly connectorName: TName;
  readonly phoneNumberId: string;
  readonly businessPhoneNumber?: string;
  readonly verifyToken?: string;
  readonly appSecret?: string;
  readonly allowUnsignedWebhooks?: boolean;
  readonly allowedSenders?: readonly string[];
  readonly sentMessageTracker: SentMessageTracker;
  readonly logger?: ConnectorLogger;
}

function extractMessageText(msg: WhatsAppWebhookIncomingMessage):
  | {
      readonly messageType: WhatsAppInboundMessageType;
      readonly rawText: string;
    }
  | undefined {
  if (msg.type === "text" && typeof msg.text?.body === "string") {
    return { messageType: "text", rawText: msg.text.body };
  }
  if (msg.type === "button" && typeof msg.button?.text === "string") {
    return { messageType: "button", rawText: msg.button.text };
  }
  if (msg.type === "interactive" && msg.interactive !== undefined) {
    if (
      msg.interactive.type === "button_reply" &&
      typeof msg.interactive.button_reply?.title === "string"
    ) {
      return { messageType: "interactive", rawText: msg.interactive.button_reply.title };
    }
    if (
      msg.interactive.type === "list_reply" &&
      typeof msg.interactive.list_reply?.title === "string"
    ) {
      return { messageType: "interactive", rawText: msg.interactive.list_reply.title };
    }
  }
  return undefined;
}

function findMatchingContact(
  contacts: readonly WhatsAppWebhookContact[] | undefined,
  from: string,
  fromDigits: string,
): WhatsAppWebhookContact | undefined {
  if (contacts === undefined || contacts.length === 0) {
    return undefined;
  }
  for (const contact of contacts) {
    if (contact.wa_id === undefined) {
      continue;
    }
    if (
      contact.wa_id === from ||
      (fromDigits.length > 0 && normalizeWhatsAppPhoneDigits(contact.wa_id) === fromDigits)
    ) {
      return contact;
    }
  }
  return contacts.length === 1 && contacts[0]?.wa_id !== undefined ? contacts[0] : undefined;
}

function decodeWebhookEnvelope(rawBody: Uint8Array): WhatsAppWebhookEnvelope | undefined {
  let jsonText: string;
  try {
    jsonText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const candidate = parsed as WhatsAppWebhookEnvelope;
  if (candidate.object !== WHATSAPP_WEBHOOK_OBJECT || !Array.isArray(candidate.entry)) {
    return undefined;
  }

  return candidate;
}

/**
 * Creates a `ConnectorReceiver` implementing Meta WhatsApp Business Cloud API Webhook verification
 * (`GET` `hub.mode` / `hub.verify_token` / `hub.challenge`), `POST` `X-Hub-Signature-256`
 * HMAC-SHA256 verification, status receipt filtering, bot echo filtering, and inbound message +
 * `context.id` contextual reply routing.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-whatsapp-echo-bot
 */
export function createWhatsAppReceiver<TName extends string = "whatsapp">(
  config: WhatsAppReceiverConfig<TName>,
): ConnectorReceiver<typeof whatsappReceiveSchema, TName> {
  let receiverCtx: ConnectorReceiverContext<typeof whatsappReceiveSchema, TName> | undefined;
  const activeLogger = (): ConnectorLogger | undefined => receiverCtx?.logger ?? config.logger;

  const configuredBizDigits =
    config.businessPhoneNumber !== undefined
      ? normalizeWhatsAppPhoneDigits(config.businessPhoneNumber)
      : "";

  const allowedRawSet =
    config.allowedSenders !== undefined ? new Set(config.allowedSenders) : undefined;
  const allowedDigitsSet =
    config.allowedSenders !== undefined
      ? new Set(
          config.allowedSenders
            .map((entry) => normalizeWhatsAppPhoneDigits(entry))
            .filter((digits) => digits.length > 0),
        )
      : undefined;

  return {
    schema: whatsappReceiveSchema,

    init: (ctx: ConnectorReceiverContext<typeof whatsappReceiveSchema, TName>): void => {
      receiverCtx = ctx;
    },

    formatInbound: (
      params: WhatsAppReceivePayload,
      _context: ConnectorContext<TName>,
    ): ConnectorInboundPrompt => {
      const speakerLabel =
        params.senderName !== undefined ? `${params.senderName} (${params.waId})` : params.waId;
      const isGroup = params.recipientType === "group" && params.groupId !== undefined;
      const scopePrefix = isGroup
        ? `[WhatsApp Group ${params.groupId}] ${speakerLabel}`
        : `[WhatsApp] ${speakerLabel}`;
      const replySuffix =
        params.replyToMessageId !== undefined ? ` (replying to ${params.replyToMessageId})` : "";
      const title = isGroup
        ? `WhatsApp Group ${params.groupId}`
        : `WhatsApp ${params.senderName ?? params.waId}`;

      return {
        title,
        text: `${scopePrefix}${replySuffix}:\n${params.text}`,
      };
    },

    handleWebhook: async (req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> => {
      const method = req.method.toUpperCase();

      if (method === "GET") {
        const mode = req.query.get(HUB_MODE_QUERY_PARAM);
        const verifyToken = req.query.get(HUB_VERIFY_TOKEN_QUERY_PARAM);
        const challenge = req.query.get(HUB_CHALLENGE_QUERY_PARAM);

        if (
          mode === HUB_SUBSCRIBE_MODE &&
          challenge !== null &&
          challenge.length > 0 &&
          verifyHubVerifyToken(verifyToken, config.verifyToken)
        ) {
          return {
            status: HTTP_STATUS_OK,
            headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN },
            body: challenge,
          };
        }

        activeLogger()?.error(WHATSAPP_LOG_HANDSHAKE_FAILED, {
          connector: config.connectorName,
        });
        return {
          status: HTTP_STATUS_FORBIDDEN,
          headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN },
          body: "Webhook verification failed",
        };
      }

      if (method !== "POST") {
        return {
          status: HTTP_STATUS_METHOD_NOT_ALLOWED,
          headers: {
            "content-type": CONTENT_TYPE_TEXT_PLAIN,
            allow: "GET, POST",
          },
          body: "Method Not Allowed",
        };
      }

      if (receiverCtx === undefined) {
        return {
          status: HTTP_STATUS_INTERNAL_SERVER_ERROR,
          headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN },
          body: "WhatsApp receiver is not initialized",
        };
      }

      if (config.appSecret !== undefined && config.appSecret.length > 0) {
        const signatureHeader = getHeaderCaseInsensitive(req.headers, WEBHOOK_SIGNATURE_HEADER);
        if (!verifyWhatsAppSignature(req.rawBody, signatureHeader, config.appSecret)) {
          activeLogger()?.error(WHATSAPP_LOG_HANDSHAKE_FAILED, {
            connector: config.connectorName,
          });
          return {
            status: HTTP_STATUS_UNAUTHORIZED,
            headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN },
            body: "Invalid X-Hub-Signature-256 signature",
          };
        }
      } else if (config.allowUnsignedWebhooks !== true) {
        return {
          status: HTTP_STATUS_UNAUTHORIZED,
          headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN },
          body: "Webhook appSecret is required unless allowUnsignedWebhooks is enabled",
        };
      }

      const envelope = decodeWebhookEnvelope(req.rawBody);
      if (envelope === undefined) {
        return {
          status: HTTP_STATUS_BAD_REQUEST,
          headers: { "content-type": CONTENT_TYPE_TEXT_PLAIN },
          body: "Invalid WhatsApp Business Account webhook payload",
        };
      }

      let processed = 0;
      let ignored = 0;
      let deduplicated = 0;

      for (const entry of envelope.entry ?? []) {
        const businessAccountId =
          typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id.trim() : "unknown";

        for (const change of entry.changes ?? []) {
          if (
            change.field !== WHATSAPP_WEBHOOK_MESSAGES_FIELD ||
            change.value?.messaging_product !== WHATSAPP_MESSAGING_PRODUCT
          ) {
            ignored += 1;
            continue;
          }

          const value = change.value;
          const eventPhoneNumberId = value.metadata?.phone_number_id?.trim();
          if (eventPhoneNumberId !== undefined && eventPhoneNumberId !== config.phoneNumberId) {
            ignored += value.messages?.length ?? value.statuses?.length ?? 1;
            continue;
          }

          if (Array.isArray(value.statuses) && value.statuses.length > 0) {
            ignored += value.statuses.length;
            activeLogger()?.debug("Ignored WhatsApp Cloud API message status receipts", {
              count: value.statuses.length,
            });
          }

          const metadataDisplayPhone = value.metadata?.display_phone_number?.trim();
          const metadataDisplayDigits =
            metadataDisplayPhone !== undefined
              ? normalizeWhatsAppPhoneDigits(metadataDisplayPhone)
              : "";

          for (const msg of value.messages ?? []) {
            const msgId = msg.id?.trim();
            const msgFrom = msg.from?.trim();
            if (
              msgId === undefined ||
              msgId.length === 0 ||
              msgFrom === undefined ||
              msgFrom.length === 0
            ) {
              ignored += 1;
              continue;
            }

            if (config.sentMessageTracker.has(msgId)) {
              ignored += 1;
              continue;
            }

            const fromDigits = normalizeWhatsAppPhoneDigits(msgFrom);
            const isSelfSender =
              msgFrom === config.phoneNumberId ||
              (fromDigits.length > 0 &&
                (fromDigits === metadataDisplayDigits || fromDigits === configuredBizDigits));
            if (isSelfSender) {
              ignored += 1;
              continue;
            }

            const matchedContact = findMatchingContact(value.contacts, msgFrom, fromDigits);
            const waId = matchedContact?.wa_id?.trim() || msgFrom;
            const waIdDigits = normalizeWhatsAppPhoneDigits(waId);
            const senderNameRaw = matchedContact?.profile?.name?.trim();
            const senderName =
              senderNameRaw !== undefined && senderNameRaw.length > 0 ? senderNameRaw : undefined;

            if (allowedRawSet !== undefined && allowedDigitsSet !== undefined) {
              const allowed =
                allowedRawSet.has(waId) ||
                allowedRawSet.has(msgFrom) ||
                (waIdDigits.length > 0 && allowedDigitsSet.has(waIdDigits)) ||
                (fromDigits.length > 0 && allowedDigitsSet.has(fromDigits));
              if (!allowed) {
                ignored += 1;
                continue;
              }
            }

            const extractedText = extractMessageText(msg);
            if (extractedText === undefined || extractedText.rawText.trim().length === 0) {
              ignored += 1;
              continue;
            }

            const { cleanedContent } = extractContextMarker(extractedText.rawText);
            if (cleanedContent.trim().length === 0) {
              ignored += 1;
              continue;
            }

            const replyToMessageIdRaw = msg.context?.id?.trim();
            const replyToMessageId =
              replyToMessageIdRaw !== undefined && replyToMessageIdRaw.length > 0
                ? replyToMessageIdRaw
                : undefined;
            const replyToFromRaw = msg.context?.from?.trim();
            const replyToFrom =
              replyToFromRaw !== undefined && replyToFromRaw.length > 0
                ? replyToFromRaw
                : undefined;

            const groupIdRaw = msg.group_id?.trim();
            const groupId =
              groupIdRaw !== undefined && groupIdRaw.length > 0 ? groupIdRaw : undefined;
            const recipientType = groupId !== undefined ? "group" : "individual";

            const resolvedContextId = resolveInboundContextId({
              messageId: msgId,
              body: extractedText.rawText,
            });

            const connectorCtx = createConnectorContext(config.connectorName, resolvedContextId);
            const timestampStr = msg.timestamp?.trim() || "0";
            const timestampSec = Number.parseInt(timestampStr, 10);
            const receivedAt =
              Number.isFinite(timestampSec) && timestampSec > 0
                ? timestampSec * MILLISECONDS_PER_SECOND
                : undefined;

            const receivePayload: WhatsAppReceivePayload = whatsappReceiveSchema.parse({
              messageId: msgId,
              from: msgFrom,
              waId,
              ...(senderName !== undefined ? { senderName } : {}),
              phoneNumberId: eventPhoneNumberId ?? config.phoneNumberId,
              ...(metadataDisplayPhone !== undefined && metadataDisplayPhone.length > 0
                ? { displayPhoneNumber: metadataDisplayPhone }
                : {}),
              businessAccountId,
              recipientType,
              ...(groupId !== undefined ? { groupId } : {}),
              messageType: extractedText.messageType,
              text: cleanedContent,
              timestamp: timestampStr,
              ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
              ...(replyToFrom !== undefined ? { replyToFrom } : {}),
            });

            const suggestedTitle =
              groupId !== undefined
                ? `WhatsApp Group ${groupId}`
                : `WhatsApp ${senderName ?? waId}`;

            const deliveryResult = await receiverCtx.onReceive(connectorCtx, receivePayload, {
              idempotencyKey: msgId,
              suggestedTitle,
              ...(receivedAt !== undefined ? { receivedAt } : {}),
            });
            processed += 1;
            if (deliveryResult.deduplicated === true) {
              deduplicated += 1;
            }
          }
        }
      }

      return {
        status: HTTP_STATUS_OK,
        headers: { "content-type": CONTENT_TYPE_JSON },
        body: JSON.stringify({
          status: "ok",
          processed,
          ignored,
          deduplicated,
        }),
      };
    },
  };
}
