import {
  ConnectorAuthError,
  ConnectorTargetRequiredError,
  ConnectorTransportError,
  prependContextMarker,
  type ConnectorContext,
  type ConnectorSendOptions,
  type ConnectorSender,
  type ContextMarkerStyle,
} from "@dsh-connector/core";
import { splitWhatsAppText } from "./chunker";
import {
  DEFAULT_WHATSAPP_API_VERSION,
  DEFAULT_WHATSAPP_REQUEST_TIMEOUT_MS,
  DEFAULT_WHATSAPP_SENDER_DESCRIPTION,
  GRAPH_AUTH_ERROR_CODES,
  GRAPH_RATE_LIMIT_ERROR_CODES,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  WHATSAPP_GRAPH_API_BASE_URL,
  WHATSAPP_MAX_TEXT_LENGTH,
  WHATSAPP_MESSAGING_PRODUCT,
} from "./constants";
import { parseWhatsAppTargetFromContextId, type SentMessageTracker } from "./context-id";
import {
  whatsappSendSchema,
  type WhatsAppAccessTokenProvider,
  type WhatsAppCloudSendMessageResponse,
  type WhatsAppCloudSendTextRequest,
  type WhatsAppGraphErrorEnvelope,
  type WhatsAppSendParams,
  type WhatsAppSendResult,
  type WhatsAppTarget,
} from "./types";

export interface WhatsAppSenderConfig<TName extends string = "whatsapp"> {
  readonly connectorName: TName;
  readonly description?: string;
  readonly accessToken: WhatsAppAccessTokenProvider;
  readonly phoneNumberId: string;
  readonly apiBaseUrl?: string;
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly maxTextLength?: number;
  readonly contextMarkerStyle?: ContextMarkerStyle | false;
  readonly fetchFn?: typeof fetch;
  readonly sentMessageTracker: SentMessageTracker;
}

function buildMessagesEndpointUrl(
  apiBaseUrl: string,
  apiVersion: string,
  phoneNumberId: string,
): string {
  const normalizedBase = apiBaseUrl.replace(/\/+$/, "");
  const normalizedVersion = apiVersion.replace(/^\/+|\/+$/g, "");
  return `${normalizedBase}/${normalizedVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
}

function resolveTarget<TName extends string>(
  connectorName: TName,
  context: ConnectorContext<TName>,
  params: WhatsAppSendParams,
): WhatsAppTarget {
  if (params.to !== undefined && params.to.trim().length > 0) {
    return {
      to: params.to.trim(),
      recipientType: params.recipientType ?? "individual",
    };
  }

  const parsedFromContext = parseWhatsAppTargetFromContextId(context.contextId);
  if (parsedFromContext !== undefined) {
    return {
      to: parsedFromContext.to,
      recipientType: params.recipientType ?? parsedFromContext.recipientType,
    };
  }

  throw new ConnectorTargetRequiredError(connectorName, "to");
}

async function resolveAccessToken<TName extends string>(
  connectorName: TName,
  provider: WhatsAppAccessTokenProvider,
): Promise<string> {
  const raw = typeof provider === "function" ? await provider() : provider;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ConnectorAuthError("WhatsApp Cloud API accessToken must be a non-empty string.", {
      connectorName,
    });
  }
  return trimmed;
}

function parseJsonSafe(rawText: string): unknown {
  if (rawText.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return undefined;
  }
}

function throwForGraphApiFailure<TName extends string>(
  connectorName: TName,
  status: number,
  parsedBody: unknown,
  rawText: string,
): never {
  const envelope =
    typeof parsedBody === "object" && parsedBody !== null
      ? (parsedBody as WhatsAppGraphErrorEnvelope)
      : undefined;
  const graphError = envelope?.error;
  const code = graphError?.code;
  const details = graphError?.error_data?.details;
  const baseMsg = graphError?.message ?? (rawText.slice(0, 200) || `HTTP ${status}`);
  const detailSuffix = details !== undefined ? ` (${details})` : "";
  const codePrefix = code !== undefined ? `[code ${code}] ` : "";
  const fullMessage = `WhatsApp Cloud API error (HTTP ${status}): ${codePrefix}${baseMsg}${detailSuffix}`;

  if (
    status === HTTP_STATUS_UNAUTHORIZED ||
    status === HTTP_STATUS_FORBIDDEN ||
    (code !== undefined && GRAPH_AUTH_ERROR_CODES.has(code))
  ) {
    throw new ConnectorAuthError(fullMessage, { connectorName });
  }

  const retryable =
    status === HTTP_STATUS_TOO_MANY_REQUESTS ||
    status >= HTTP_STATUS_INTERNAL_SERVER_ERROR ||
    (code !== undefined && GRAPH_RATE_LIMIT_ERROR_CODES.has(code));

  throw new ConnectorTransportError(fullMessage, {
    connectorName,
    statusCode: status,
    retryable,
  });
}

/**
 * Creates a `ConnectorSender` backed by Meta WhatsApp Business Cloud API
 * `POST /{version}/{phone-number-id}/messages`.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#contextual-replies
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export function createWhatsAppSender<TName extends string = "whatsapp">(
  config: WhatsAppSenderConfig<TName>,
): ConnectorSender<typeof whatsappSendSchema, WhatsAppSendResult, TName> {
  const fetchImpl = config.fetchFn ?? globalThis.fetch;
  const endpointUrl = buildMessagesEndpointUrl(
    config.apiBaseUrl ?? WHATSAPP_GRAPH_API_BASE_URL,
    config.apiVersion ?? DEFAULT_WHATSAPP_API_VERSION,
    config.phoneNumberId,
  );
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_WHATSAPP_REQUEST_TIMEOUT_MS;
  const maxTextLength = config.maxTextLength ?? WHATSAPP_MAX_TEXT_LENGTH;
  const markerStyle = config.contextMarkerStyle ?? false;

  return {
    description: config.description ?? DEFAULT_WHATSAPP_SENDER_DESCRIPTION,
    schema: whatsappSendSchema,
    send: async (
      context: ConnectorContext<TName>,
      params: WhatsAppSendParams,
      options?: ConnectorSendOptions,
    ): Promise<WhatsAppSendResult> => {
      const target = resolveTarget(config.connectorName, context, params);
      const token = await resolveAccessToken(config.connectorName, config.accessToken);

      const preparedText =
        markerStyle !== false
          ? prependContextMarker(params.text, context.contextId, markerStyle)
          : params.text;
      const chunks = splitWhatsAppText(preparedText, maxTextLength);

      const messageIds: string[] = [];
      const rawResponses: WhatsAppCloudSendMessageResponse[] = [];
      let resolvedRecipientId = target.to;

      for (const [index, chunk] of chunks.entries()) {
        const payload: WhatsAppCloudSendTextRequest = {
          messaging_product: WHATSAPP_MESSAGING_PRODUCT,
          recipient_type: target.recipientType,
          to: target.to,
          type: "text",
          ...(index === 0 && params.replyToMessageId !== undefined
            ? { context: { message_id: params.replyToMessageId } }
            : {}),
          text: {
            body: chunk,
            ...(params.previewUrl !== undefined ? { preview_url: params.previewUrl } : {}),
          },
        };

        const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
        const combinedSignal =
          options?.signal !== undefined
            ? AbortSignal.any([options.signal, timeoutSignal])
            : timeoutSignal;

        let response: Response;
        try {
          response = await fetchImpl(endpointUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: combinedSignal,
          });
        } catch (error) {
          const callerAborted = options?.signal?.aborted === true;
          throw new ConnectorTransportError(
            `Failed to call WhatsApp Cloud API Messages endpoint: ${error instanceof Error ? error.message : String(error)}`,
            {
              connectorName: config.connectorName,
              cause: error,
              retryable: !callerAborted,
            },
          );
        }

        const rawText = await response.text();
        const parsedBody = parseJsonSafe(rawText);

        if (!response.ok) {
          throwForGraphApiFailure(config.connectorName, response.status, parsedBody, rawText);
        }

        const data =
          typeof parsedBody === "object" && parsedBody !== null
            ? (parsedBody as WhatsAppCloudSendMessageResponse)
            : undefined;
        const firstMsg = data?.messages?.[0];
        if (firstMsg === undefined || typeof firstMsg.id !== "string" || firstMsg.id.length === 0) {
          throw new ConnectorTransportError(
            "WhatsApp Cloud API returned 200 OK without a valid messages[0].id.",
            {
              connectorName: config.connectorName,
              statusCode: response.status,
              retryable: false,
            },
          );
        }

        const firstContactWaId = data?.contacts?.[0]?.wa_id;
        if (typeof firstContactWaId === "string" && firstContactWaId.length > 0) {
          resolvedRecipientId = firstContactWaId;
        } else if (typeof firstMsg.group_id === "string" && firstMsg.group_id.length > 0) {
          resolvedRecipientId = firstMsg.group_id;
        }

        config.sentMessageTracker.record(firstMsg.id, context.contextId);
        messageIds.push(firstMsg.id);
        if (data !== undefined) {
          rawResponses.push(data);
        }
      }

      const primaryMessageId = messageIds[0]!;
      return {
        externalId: primaryMessageId,
        messageId: primaryMessageId,
        messageIds,
        recipientId: resolvedRecipientId,
        recipientType: target.recipientType,
        phoneNumberId: config.phoneNumberId,
        raw: rawResponses,
        summary: `Sent WhatsApp ${target.recipientType} message (${messageIds.length} part(s)) to ${resolvedRecipientId}`,
        data: {
          messageId: primaryMessageId,
          messageIds,
          recipientId: resolvedRecipientId,
          recipientType: target.recipientType,
          phoneNumberId: config.phoneNumberId,
        },
      };
    },
  };
}
