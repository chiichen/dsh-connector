/**
 * Inbound Feishu `ConnectorReceiver` supporting:
 * 1. Event Subscription v2.0 HTTP Webhook (`url_verification`, AES-256-CBC decryption,
 *    `X-Lark-Signature` verification, `Verification Token` check, `im.message.receive_v1`).
 * 2. Shared event ingestion pipeline for WebSocket long-connection delivery (`pbbp2`).
 * 3. `[#ctx:<contextId>]` marker extraction from the message text already on the event.
 *    `parent_id` is only an id, so a reply that does not include the marker text opens a new context.
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 * @see https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/send-callbacks-to-developers-server
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 */

import {
  createConnectorContext,
  extractContextMarker,
  resolveInboundContextId,
  type ConnectorInboundPrompt,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import {
  FEISHU_MESSAGE_RECEIVE_EVENT_TYPE,
  FEISHU_NONCE_HEADER,
  FEISHU_SIGNATURE_HEADER,
  FEISHU_TIMESTAMP_HEADER,
  FEISHU_URL_VERIFICATION_TYPE,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
} from "./constants";
import { feishuReceiveSchema, type FeishuInboundMessage } from "./context";
import {
  decryptFeishuPayload,
  verifyFeishuEventSignature,
  verifyFeishuVerificationToken,
} from "./crypto";
import type { FeishuApiClient } from "./api-client";
import { parseFeishuMessageReceiveEvent, type FeishuGroupMentionPolicy } from "./message-parser";

export interface FeishuReceiverRuntime<TName extends string = string> {
  readonly receiver: ConnectorReceiver<typeof feishuReceiveSchema, TName>;
  readonly getReceiverContext: () =>
    | ConnectorReceiverContext<typeof feishuReceiveSchema, TName>
    | undefined;
  readonly ingestEventEnvelope: (envelope: Record<string, unknown>) => Promise<{
    readonly accepted: boolean;
    readonly reason?: string;
    readonly sessionId?: string;
    readonly deduplicated?: boolean;
  }>;
}

export interface CreateFeishuReceiverOptions<TName extends string = string> {
  readonly connectorName: TName;
  readonly appId: string;
  readonly apiClient: FeishuApiClient;
  readonly getBotOpenId: () => string | undefined;
  readonly getBotName: () => string | undefined;
  readonly verificationToken?: string;
  readonly encryptKey?: string;
  readonly allowedOpenIds?: readonly string[];
  readonly groupMentionPolicy?: FeishuGroupMentionPolicy;
  readonly allowAtAllInGroup?: boolean;
  readonly resolveReplyContextFromParent?: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSingleHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  lowerName: string,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerName) {
      if (typeof v === "string") return v;
      if (Array.isArray(v) && typeof v[0] === "string") return v[0];
      return undefined;
    }
  }
  return undefined;
}

function jsonWebhookResponse(
  status: number,
  payload: Record<string, unknown>,
): ConnectorWebhookResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  };
}

export function formatFeishuInboundPrompt(params: FeishuInboundMessage): ConnectorInboundPrompt {
  const scopeTitle =
    params.chatType === "p2p"
      ? `[Feishu DM] ${params.senderOpenId ?? params.chatId}`
      : params.threadId !== undefined
        ? `[Feishu Group Topic] ${params.chatId}#${params.threadId}`
        : `[Feishu Group] ${params.chatId}`;

  const senderPrefix =
    params.chatType === "group" && params.senderOpenId !== undefined
      ? `[From ${params.senderOpenId}]\n`
      : "";

  return {
    title: scopeTitle,
    text: `${senderPrefix}${params.text}`,
  };
}

export function createFeishuReceiver<const TName extends string>(
  options: CreateFeishuReceiverOptions<TName>,
): FeishuReceiverRuntime<TName> {
  let receiverCtx: ConnectorReceiverContext<typeof feishuReceiveSchema, TName> | undefined;

  async function ingestEventEnvelope(envelope: Record<string, unknown>): Promise<{
    readonly accepted: boolean;
    readonly reason?: string;
    readonly sessionId?: string;
    readonly deduplicated?: boolean;
  }> {
    if (receiverCtx === undefined) {
      throw new Error(`FeishuConnector "${options.connectorName}" receiver is not initialized.`);
    }

    const header = isPlainRecord(envelope["header"]) ? envelope["header"] : undefined;
    const eventType =
      typeof header?.["event_type"] === "string"
        ? header["event_type"]
        : typeof envelope["type"] === "string"
          ? envelope["type"]
          : undefined;

    if (eventType !== FEISHU_MESSAGE_RECEIVE_EVENT_TYPE) {
      return { accepted: false, reason: "unsupported_event_type" };
    }

    const botOpenId = options.getBotOpenId();
    const botName = options.getBotName();
    const parsedOutcome = parseFeishuMessageReceiveEvent(envelope, {
      appId: options.appId,
      ...(botOpenId !== undefined ? { botOpenId } : {}),
      ...(botName !== undefined ? { botName } : {}),
      ...(options.allowedOpenIds !== undefined ? { allowedOpenIds: options.allowedOpenIds } : {}),
      ...(options.groupMentionPolicy !== undefined
        ? { groupMentionPolicy: options.groupMentionPolicy }
        : {}),
      ...(options.allowAtAllInGroup !== undefined
        ? { allowAtAllInGroup: options.allowAtAllInGroup }
        : {}),
    });

    if (!parsedOutcome.accepted) {
      return { accepted: false, reason: parsedOutcome.reason };
    }

    const rawMsg = parsedOutcome.message;
    const { cleanedContent } = extractContextMarker(rawMsg.text);
    const cleanedText = cleanedContent.trim();
    if (cleanedText.length === 0) {
      return { accepted: false, reason: "empty_or_unsupported_message" };
    }

    const resolvedContextId = resolveInboundContextId({
      messageId: rawMsg.messageId,
      body: rawMsg.text,
    });
    const context = createConnectorContext(options.connectorName, resolvedContextId);
    const normalizedMsg: FeishuInboundMessage = {
      ...rawMsg,
      text: cleanedText,
    };

    const promptPreview = formatFeishuInboundPrompt(normalizedMsg);
    const delivery = await receiverCtx.onReceive(context, normalizedMsg, {
      idempotencyKey: normalizedMsg.messageId,
      ...(promptPreview.title !== undefined ? { suggestedTitle: promptPreview.title } : {}),
      ...(normalizedMsg.createTimeMs !== undefined
        ? { receivedAt: normalizedMsg.createTimeMs }
        : {}),
    });

    return {
      accepted: true,
      sessionId: delivery.sessionId,
      ...(delivery.deduplicated !== undefined ? { deduplicated: delivery.deduplicated } : {}),
    };
  }

  const receiver: ConnectorReceiver<typeof feishuReceiveSchema, TName> = {
    schema: feishuReceiveSchema,
    init(ctx) {
      receiverCtx = ctx;
    },
    formatInbound(params) {
      return formatFeishuInboundPrompt(params);
    },
    async handleWebhook(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> {
      if (req.method.toUpperCase() !== "POST") {
        return jsonWebhookResponse(HTTP_STATUS_METHOD_NOT_ALLOWED, {
          error: "Method Not Allowed",
        });
      }

      const rawBodyText = new TextDecoder("utf-8").decode(req.rawBody);
      let outerJson: unknown;
      try {
        outerJson = JSON.parse(rawBodyText);
      } catch {
        return jsonWebhookResponse(HTTP_STATUS_BAD_REQUEST, {
          error: "Invalid JSON request body",
        });
      }

      if (!isPlainRecord(outerJson)) {
        return jsonWebhookResponse(HTTP_STATUS_BAD_REQUEST, {
          error: "Expected JSON object payload",
        });
      }

      const signatureHeader = getSingleHeader(req.headers, FEISHU_SIGNATURE_HEADER);
      const timestampHeader = getSingleHeader(req.headers, FEISHU_TIMESTAMP_HEADER);
      const nonceHeader = getSingleHeader(req.headers, FEISHU_NONCE_HEADER);

      let eventEnvelope: Record<string, unknown> = outerJson;
      const wasEncrypted = typeof outerJson["encrypt"] === "string";

      if (wasEncrypted) {
        if (options.encryptKey === undefined || options.encryptKey.length === 0) {
          return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
            error: "Received encrypted Feishu payload but encryptKey is not configured",
          });
        }

        // Verify X-Lark-Signature immediately whenever present
        if (signatureHeader !== undefined) {
          const validSig = verifyFeishuEventSignature({
            timestamp: timestampHeader,
            nonce: nonceHeader,
            encryptKey: options.encryptKey,
            rawBody: req.rawBody,
            signature: signatureHeader,
            connectorName: options.connectorName,
          });
          if (!validSig) {
            return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
              error: "Invalid X-Lark-Signature",
            });
          }
        }

        try {
          const decryptedText = decryptFeishuPayload(
            outerJson["encrypt"] as string,
            options.encryptKey,
            options.connectorName,
          );
          const parsedInner: unknown = JSON.parse(decryptedText);
          if (!isPlainRecord(parsedInner)) {
            return jsonWebhookResponse(HTTP_STATUS_BAD_REQUEST, {
              error: "Decrypted Feishu payload is not a JSON object",
            });
          }
          eventEnvelope = parsedInner;
        } catch {
          return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
            error: "Failed to decrypt Feishu payload",
          });
        }
      }

      // 1. Handle Feishu URL verification challenge (`url_verification`)
      if (eventEnvelope["type"] === FEISHU_URL_VERIFICATION_TYPE) {
        if (options.verificationToken !== undefined && options.verificationToken.length > 0) {
          const tokenValue =
            typeof eventEnvelope["token"] === "string" ? eventEnvelope["token"] : undefined;
          if (!verifyFeishuVerificationToken(tokenValue, options.verificationToken)) {
            return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
              error: "Invalid Feishu Verification Token",
            });
          }
        }
        const challenge =
          typeof eventEnvelope["challenge"] === "string" ? eventEnvelope["challenge"] : "";
        return jsonWebhookResponse(HTTP_STATUS_OK, { challenge });
      }

      // 2. For real event callbacks, if encryptKey is configured, require encrypted envelope + X-Lark-Signature
      if (options.encryptKey !== undefined && options.encryptKey.length > 0) {
        if (!wasEncrypted || signatureHeader === undefined) {
          return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
            error: "Encrypted event envelope and valid X-Lark-Signature are required",
          });
        }
      }

      // 3. Optional Verification Token check on v2.0 header.token / v1 token
      if (options.verificationToken !== undefined && options.verificationToken.length > 0) {
        const headerObj = isPlainRecord(eventEnvelope["header"])
          ? eventEnvelope["header"]
          : undefined;
        const tokenCandidate =
          typeof headerObj?.["token"] === "string"
            ? headerObj["token"]
            : typeof eventEnvelope["token"] === "string"
              ? eventEnvelope["token"]
              : undefined;
        if (!verifyFeishuVerificationToken(tokenCandidate, options.verificationToken)) {
          return jsonWebhookResponse(HTTP_STATUS_UNAUTHORIZED, {
            error: "Invalid Feishu Verification Token",
          });
        }
      }

      try {
        const outcome = await ingestEventEnvelope(eventEnvelope);
        return jsonWebhookResponse(HTTP_STATUS_OK, {
          ok: true,
          accepted: outcome.accepted,
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
          ...(outcome.deduplicated !== undefined ? { deduplicated: outcome.deduplicated } : {}),
        });
      } catch (error) {
        receiverCtx?.logger.error("Error processing Feishu webhook event", {
          connectorName: options.connectorName,
          error: String(error),
        });
        return jsonWebhookResponse(HTTP_STATUS_INTERNAL_SERVER_ERROR, {
          error: "Internal Server Error",
        });
      }
    },
  };

  return {
    receiver,
    getReceiverContext: () => receiverCtx,
    ingestEventEnvelope,
  };
}
