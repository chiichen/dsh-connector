import {
  createConnectorContext,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  SLACK_HEADER_RETRY_NUM,
  SLACK_WEBHOOK_TYPE_EVENT_CALLBACK,
  SLACK_WEBHOOK_TYPE_URL_VERIFICATION,
} from "./constants";
import {
  parseSlackEventCallback,
  type slackReceiveSchema,
  type SlackThreadReplyPolicy,
} from "./event-parser";
import { verifySlackRequestSignature } from "./signature";

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json;charset=utf-8",
});

export interface SlackInboundDispatchConfig<TName extends string = string> {
  readonly connectorName: TName;
  readonly getReceiverContext: () =>
    | ConnectorReceiverContext<typeof slackReceiveSchema, TName>
    | undefined;
  readonly getBotUserId: () => string | undefined;
  readonly getExpectedAppId: () => string | undefined;
  readonly threadReplyPolicy?: SlackThreadReplyPolicy;
  readonly deliveryMode?: "queue" | "steer";
  readonly isParticipatingThread: (channelId: string, threadTs: string) => boolean;
  readonly markParticipatingThread: (channelId: string, threadTs: string) => void;
}

export interface SlackWebhookHandlerConfig<
  TName extends string = string,
> extends SlackInboundDispatchConfig<TName> {
  readonly signingSecret?: string;
  readonly signatureToleranceSeconds?: number;
  readonly nowSeconds?: () => number;
  readonly ignoreHttpRetries?: boolean;
}

export type SlackEventDispatchOutcome =
  | {
      readonly ok: true;
      readonly ignored: true;
      readonly reason: string;
    }
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly deduplicated?: boolean;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHeaderCaseInsensitive(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  targetLowerName: string,
): boolean {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== targetLowerName) {
      continue;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim().length > 0) {
      return true;
    }
  }
  return false;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): ConnectorWebhookResponse {
  return {
    status,
    headers: extraHeaders !== undefined ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

/**
 * Shared dispatcher used by both HTTP Events API Webhooks and Socket Mode `events_api` envelopes.
 */
export async function dispatchSlackEventCallback<const TName extends string>(
  payload: unknown,
  config: SlackInboundDispatchConfig<TName>,
): Promise<SlackEventDispatchOutcome> {
  const receiverCtx = config.getReceiverContext();
  if (receiverCtx === undefined) {
    throw new Error(`Slack connector "${config.connectorName}" receiver has not been initialized.`);
  }

  const parsed = parseSlackEventCallback(payload, {
    connectorName: config.connectorName,
    botUserId: config.getBotUserId(),
    expectedAppId: config.getExpectedAppId(),
    threadReplyPolicy: config.threadReplyPolicy,
    isParticipatingThread: config.isParticipatingThread,
  });

  if (parsed.kind === "ignored") {
    return {
      ok: true,
      ignored: true,
      reason: parsed.reason,
    };
  }

  if (parsed.participatingThread !== undefined) {
    config.markParticipatingThread(
      parsed.participatingThread.channelId,
      parsed.participatingThread.threadTs,
    );
  }

  const context = createConnectorContext(config.connectorName, parsed.contextId);
  const delivery = await receiverCtx.onReceive(context, parsed.params, {
    idempotencyKey: parsed.idempotencyKey,
    suggestedTitle: parsed.suggestedTitle,
    receivedAt: parsed.receivedAtMs,
    deliveryMode: config.deliveryMode,
  });

  return {
    ok: true,
    sessionId: delivery.sessionId,
    ...(delivery.deduplicated === true ? { deduplicated: true } : {}),
  };
}

/**
 * Handles Slack Events API HTTP Request URL webhooks:
 * - Enforces `POST` HTTP method
 * - Verifies `X-Slack-Signature` (`v0` HMAC-SHA256) and `X-Slack-Request-Timestamp` replay bounds
 * - Responds to `url_verification` challenge handshakes
 * - Dispatches `event_callback` payloads into `ConnectorReceiverContext.onReceive`
 *
 * @see https://docs.slack.dev/apis/events-api/using-http-request-urls/
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack/
 */
export async function handleSlackEventsWebhook<const TName extends string>(
  req: ConnectorWebhookRequest,
  config: SlackWebhookHandlerConfig<TName>,
): Promise<ConnectorWebhookResponse> {
  if (req.method.toUpperCase() !== "POST") {
    return jsonResponse(
      HTTP_STATUS_METHOD_NOT_ALLOWED,
      { ok: false, error: "method_not_allowed" },
      { allow: "POST" },
    );
  }

  const verification = verifySlackRequestSignature({
    signingSecret: config.signingSecret ?? "",
    headers: req.headers,
    rawBody: req.rawBody,
    nowSeconds: config.nowSeconds?.(),
    toleranceSeconds: config.signatureToleranceSeconds,
  });

  if (!verification.valid) {
    return jsonResponse(HTTP_STATUS_UNAUTHORIZED, {
      ok: false,
      error: verification.reason,
      message: verification.message,
    });
  }

  if (
    config.ignoreHttpRetries === true &&
    hasHeaderCaseInsensitive(req.headers, SLACK_HEADER_RETRY_NUM)
  ) {
    return jsonResponse(HTTP_STATUS_OK, {
      ok: true,
      ignored: true,
      reason: "http_retry",
    });
  }

  let payload: unknown;
  try {
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(req.rawBody);
    payload = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonResponse(HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error: "invalid_json",
    });
  }

  if (!isPlainRecord(payload)) {
    return jsonResponse(HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error: "invalid_payload",
    });
  }

  if (payload["type"] === SLACK_WEBHOOK_TYPE_URL_VERIFICATION) {
    const challenge = payload["challenge"];
    if (typeof challenge !== "string" || challenge.length === 0) {
      return jsonResponse(HTTP_STATUS_BAD_REQUEST, {
        ok: false,
        error: "missing_challenge",
      });
    }
    return jsonResponse(HTTP_STATUS_OK, { challenge });
  }

  if (payload["type"] !== SLACK_WEBHOOK_TYPE_EVENT_CALLBACK) {
    return jsonResponse(HTTP_STATUS_OK, {
      ok: true,
      ignored: true,
      reason: "unsupported_payload_type",
    });
  }

  if (config.getReceiverContext() === undefined) {
    return jsonResponse(HTTP_STATUS_INTERNAL_SERVER_ERROR, {
      ok: false,
      error: "receiver_not_initialized",
    });
  }

  const outcome = await dispatchSlackEventCallback(payload, config);
  return jsonResponse(HTTP_STATUS_OK, outcome);
}
