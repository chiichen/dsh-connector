import { z } from "zod";
import type { ConnectorLogger, ConnectorSendResult, ContextMarkerStyle } from "@dsh-connector/core";
import type { WhatsAppStreamingAdapter, WhatsAppStreamingOptions } from "./streaming";

/**
 * Recipient type supported by Meta WhatsApp Business Cloud API `POST /{version}/{phone-number-id}/messages`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */
export const whatsappRecipientTypeSchema = z.enum(["individual", "group"]);
export type WhatsAppRecipientType = z.output<typeof whatsappRecipientTypeSchema>;

/**
 * Outbound schema for `ConnectorSender.send`.
 * `text` is required as the unified primary message field; target addressing fields are optional
 * so session-bound sends can resolve the recipient from `ConnectorContext.contextId`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
 */
export const whatsappSendSchema = z.object({
  text: z.string().min(1),
  to: z.string().min(1).optional(),
  recipientType: whatsappRecipientTypeSchema.optional(),
  replyToMessageId: z.string().min(1).optional(),
  previewUrl: z.boolean().optional(),
});

export type WhatsAppSendParams = z.output<typeof whatsappSendSchema>;
export type WhatsAppSendInput = z.input<typeof whatsappSendSchema>;

export const whatsappInboundMessageTypeSchema = z.enum(["text", "button", "interactive"]);
export type WhatsAppInboundMessageType = z.output<typeof whatsappInboundMessageTypeSchema>;

/**
 * Validated inbound user message payload emitted to `ConnectorReceiverContext.onReceive`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */
export const whatsappReceiveSchema = z.object({
  messageId: z.string().min(1),
  from: z.string().min(1),
  waId: z.string().min(1),
  senderName: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1),
  displayPhoneNumber: z.string().min(1).optional(),
  businessAccountId: z.string().min(1),
  recipientType: whatsappRecipientTypeSchema,
  groupId: z.string().min(1).optional(),
  messageType: whatsappInboundMessageTypeSchema,
  text: z.string().min(1),
  timestamp: z.string().min(1),
  replyToMessageId: z.string().min(1).optional(),
  replyToFrom: z.string().min(1).optional(),
});

export type WhatsAppReceivePayload = z.output<typeof whatsappReceiveSchema>;

export interface WhatsAppTarget {
  readonly recipientType: WhatsAppRecipientType;
  readonly to: string;
}

/**
 * Request body sent to `POST /{version}/{phone-number-id}/messages` for text messages.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
 */
export interface WhatsAppCloudSendTextRequest {
  readonly messaging_product: "whatsapp";
  readonly recipient_type: WhatsAppRecipientType;
  readonly to: string;
  readonly type: "text";
  readonly context?: {
    readonly message_id: string;
  };
  readonly text: {
    readonly body: string;
    readonly preview_url?: boolean;
  };
}

export interface WhatsAppCloudContactItem {
  readonly input?: string;
  readonly wa_id?: string;
  readonly user_id?: string;
}

export interface WhatsAppCloudMessageItem {
  readonly id: string;
  readonly group_id?: string;
  readonly message_status?: string;
}

/**
 * Response body returned by `POST /{version}/{phone-number-id}/messages`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#responses
 */
export interface WhatsAppCloudSendMessageResponse {
  readonly messaging_product?: string;
  readonly contacts?: readonly WhatsAppCloudContactItem[];
  readonly messages?: readonly WhatsAppCloudMessageItem[];
}

/**
 * Graph API synchronous error envelope returned by WhatsApp Cloud API.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export interface WhatsAppGraphErrorEnvelope {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly fbtrace_id?: string;
    readonly error_data?: {
      readonly messaging_product?: string;
      readonly details?: string;
    };
  };
}

/**
 * Structured send result preserving all platform message handles (`wamid`s, recipient ID,
 * phone number ID, and raw Graph API responses) required for subsequent status tracking,
 * reaction updates, or streaming continuation.
 */
export interface WhatsAppSendResult extends ConnectorSendResult {
  readonly messageId: string;
  readonly messageIds: readonly string[];
  readonly recipientId: string;
  readonly recipientType: WhatsAppRecipientType;
  readonly phoneNumberId: string;
  readonly raw: readonly WhatsAppCloudSendMessageResponse[];
}

/**
 * Access token value or lazy provider for Meta Graph API `Authorization: Bearer <token>`.
 */
export type WhatsAppAccessTokenProvider = string | (() => string | Promise<string>);

/**
 * Configuration options for `WhatsAppConnector` / `createWhatsAppConnector`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export interface WhatsAppConnectorOptions<TName extends string = "whatsapp"> {
  readonly name?: TName;
  readonly displayName?: string;
  readonly description?: string;
  readonly accessToken: WhatsAppAccessTokenProvider;
  readonly phoneNumberId: string;
  readonly logger?: ConnectorLogger;
  readonly businessPhoneNumber?: string;
  readonly verifyToken?: string;
  readonly appSecret?: string;
  readonly allowUnsignedWebhooks?: boolean;
  readonly apiBaseUrl?: string;
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly maxTextLength?: number;
  readonly outboundEchoCacheSize?: number;
  readonly contextMarkerStyle?: ContextMarkerStyle | false;
  readonly allowedSenders?: readonly string[];
  readonly fetchFn?: typeof fetch;
  readonly streaming?: WhatsAppStreamingOptions;
  readonly streamingAdapter?: WhatsAppStreamingAdapter;
}
