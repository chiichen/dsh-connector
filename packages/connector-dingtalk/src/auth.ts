import { createHmac, timingSafeEqual } from "node:crypto";
import { ConnectorAuthError, ConnectorTransportError } from "@dsh-connector/core";
import {
  DINGTALK_API_BASE_URL,
  DINGTALK_DEFAULT_HTTP_TIMEOUT_MS,
  DINGTALK_DEFAULT_TOKEN_EXPIRE_SECONDS,
  DINGTALK_HMAC_ALGORITHM,
  DINGTALK_MIN_TOKEN_TTL_MS,
  DINGTALK_OAUTH_TOKEN_PATH,
  DINGTALK_TOKEN_REFRESH_BUFFER_SECONDS,
  DINGTALK_WEBHOOK_MAX_SKEW_MS,
  DINGTALK_WEBHOOK_SIGN_HEADER,
  DINGTALK_WEBHOOK_TIMESTAMP_HEADER,
  DINGTALK_WEBHOOK_TOKEN_HEADER,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_UNAUTHORIZED,
} from "./constants";
import { extractProviderErrorDetail, isRetryableHttpStatus, requestDingTalkJson } from "./http";

/**
 * Computes DingTalk HTTP Outgoing webhook HMAC-SHA256 Base64 signature:
 * `Base64(HMAC-SHA256(secret, "${timestamp}\n${secret}"))`.
 *
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 * @see https://open.dingtalk.com/document/dingstart/receive-message
 * @see https://open.dingtalk.com/document/group/process-of-signing-a-message-with-a-custom-chatbot
 */
export function computeDingTalkSignature(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac(DINGTALK_HMAC_ALGORITHM, Buffer.from(secret, "utf8"))
    .update(stringToSign, "utf8")
    .digest("base64");
}

function constantTimeStringEqual(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (actualBuf.byteLength !== expectedBuf.byteLength) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}

function readHeaderValue(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  targetLowerName: string,
): string | undefined {
  const direct = headers[targetLowerName];
  if (typeof direct === "string") return direct.trim();
  if (Array.isArray(direct) && typeof direct[0] === "string") return direct[0].trim();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== targetLowerName) continue;
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  }
  return undefined;
}

export type DingTalkSignatureFailureReason =
  | "verifier_not_configured"
  | "missing_or_invalid_timestamp"
  | "timestamp_expired"
  | "missing_sign"
  | "invalid_sign"
  | "invalid_token";

export type DingTalkSignatureVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DingTalkSignatureFailureReason };

export interface DingTalkVerifyWebhookOptions {
  readonly signingSecret?: string;
  readonly outgoingToken?: string;
  readonly maxSkewMs?: number;
  readonly maxWebhookSkewMs?: number;
  readonly nowMs?: number;
}

/**
 * Verifies an inbound DingTalk HTTP Outgoing webhook request:
 * 1. Enterprise Robot mode (`signingSecret`): checks `timestamp` skew (`<= 1h` by default) and
 *    constant-time compares `sign` against `HMAC-SHA256(secret, timestamp + "\n" + secret)`.
 * 2. Custom Robot Outgoing mode (`outgoingToken`): constant-time compares header `token`.
 *
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 * @see https://open.dingtalk.com/document/group/process-of-signing-a-message-with-a-custom-chatbot
 * @see https://open.dingtalk.com/document/isvapp/custom-bot-access-send-message.md
 */
export function verifyDingTalkWebhookSignature(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  options: DingTalkVerifyWebhookOptions,
): DingTalkSignatureVerifyResult {
  const signingSecret = options.signingSecret?.trim();
  const outgoingToken = options.outgoingToken?.trim();
  const nowMs = options.nowMs ?? Date.now();
  const maxSkewMs = options.maxWebhookSkewMs ?? options.maxSkewMs ?? DINGTALK_WEBHOOK_MAX_SKEW_MS;

  const hasSigningSecret = signingSecret !== undefined && signingSecret.length > 0;
  const hasOutgoingToken = outgoingToken !== undefined && outgoingToken.length > 0;

  const rawTimestamp = readHeaderValue(headers, DINGTALK_WEBHOOK_TIMESTAMP_HEADER);
  const rawSign = readHeaderValue(headers, DINGTALK_WEBHOOK_SIGN_HEADER);
  const rawToken = readHeaderValue(headers, DINGTALK_WEBHOOK_TOKEN_HEADER);

  if (
    hasOutgoingToken &&
    rawToken !== undefined &&
    rawTimestamp === undefined &&
    rawSign === undefined
  ) {
    if (!constantTimeStringEqual(rawToken, outgoingToken)) {
      return { ok: false, reason: "invalid_token" };
    }
    return { ok: true };
  }

  if (hasSigningSecret) {
    if (rawTimestamp === undefined || !/^\d+$/.test(rawTimestamp)) {
      return { ok: false, reason: "missing_or_invalid_timestamp" };
    }
    const timestampMs = Number(rawTimestamp);
    if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > maxSkewMs) {
      return { ok: false, reason: "timestamp_expired" };
    }

    if (rawSign === undefined || rawSign.length === 0) {
      return { ok: false, reason: "missing_sign" };
    }

    const expectedSign = computeDingTalkSignature(rawTimestamp, signingSecret);
    if (!constantTimeStringEqual(rawSign, expectedSign)) {
      return { ok: false, reason: "invalid_sign" };
    }
    return { ok: true };
  }

  if (hasOutgoingToken) {
    if (rawToken === undefined || !constantTimeStringEqual(rawToken, outgoingToken)) {
      return { ok: false, reason: "invalid_token" };
    }
    return { ok: true };
  }

  return { ok: false, reason: "verifier_not_configured" };
}

export interface DingTalkAccessTokenManagerOptions {
  readonly connectorName: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiBaseUrl?: string;
  readonly httpTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

/**
 * Acquires and caches DingTalk enterprise internal app `accessToken` via
 * `POST /v1.0/oauth2/accessToken`, deduplicating concurrent token requests and refreshing
 * before expiration to avoid DingTalk rate limits.
 *
 * @see https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app.md
 * @see https://open.dingtalk.com/document/orgapp-server/obtain-the-access_token-of-an-internal-app.md
 */
export class DingTalkAccessTokenManager {
  private readonly connectorName: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenUrl: string;
  private readonly httpTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  private cached?: CachedToken;
  private inFlight?: Promise<string>;

  constructor(options: DingTalkAccessTokenManagerOptions) {
    this.connectorName = options.connectorName;
    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    const base = (options.apiBaseUrl ?? DINGTALK_API_BASE_URL).replace(/\/+$/, "");
    this.tokenUrl = `${base}${DINGTALK_OAUTH_TOKEN_PATH}`;
    this.httpTimeoutMs = options.httpTimeoutMs ?? DINGTALK_DEFAULT_HTTP_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.cached !== undefined && this.cached.expiresAt > this.now()) {
      return this.cached.accessToken;
    }

    if (this.inFlight !== undefined && signal === undefined) {
      return this.inFlight;
    }

    const task = this.fetchFreshToken(signal);
    if (signal === undefined) {
      this.inFlight = task.finally(() => {
        this.inFlight = undefined;
      });
      return this.inFlight;
    }
    return task;
  }

  private async fetchFreshToken(signal?: AbortSignal): Promise<string> {
    const result = await requestDingTalkJson({
      connectorName: this.connectorName,
      fetchFn: this.fetchFn,
      url: this.tokenUrl,
      method: "POST",
      body: {
        appKey: this.clientId,
        appSecret: this.clientSecret,
      },
      timeoutMs: this.httpTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    });

    if (!result.ok) {
      const detail = extractProviderErrorDetail(result.data);
      if (
        result.status === HTTP_STATUS_BAD_REQUEST ||
        result.status === HTTP_STATUS_UNAUTHORIZED ||
        result.status === HTTP_STATUS_FORBIDDEN
      ) {
        throw new ConnectorAuthError(
          `Failed to obtain DingTalk accessToken (HTTP ${result.status}${detail !== undefined ? ` - ${detail}` : ""}).`,
          { connectorName: this.connectorName },
        );
      }
      throw new ConnectorTransportError(
        `DingTalk accessToken endpoint failed (HTTP ${result.status}${detail !== undefined ? ` - ${detail}` : ""}).`,
        {
          connectorName: this.connectorName,
          statusCode: result.status,
          retryable: isRetryableHttpStatus(result.status),
        },
      );
    }

    const rawToken = result.data["accessToken"];
    const accessToken = typeof rawToken === "string" ? rawToken.trim() : "";
    if (accessToken.length === 0) {
      throw new ConnectorAuthError(
        "DingTalk oauth2/accessToken response did not include a non-empty accessToken.",
        { connectorName: this.connectorName },
      );
    }

    const rawExpireIn = result.data["expireIn"];
    const expireSeconds =
      typeof rawExpireIn === "number" && Number.isFinite(rawExpireIn) && rawExpireIn > 0
        ? rawExpireIn
        : DINGTALK_DEFAULT_TOKEN_EXPIRE_SECONDS;
    const ttlMs = Math.max(
      DINGTALK_MIN_TOKEN_TTL_MS,
      (expireSeconds - DINGTALK_TOKEN_REFRESH_BUFFER_SECONDS) * 1_000,
    );

    this.cached = {
      accessToken,
      expiresAt: this.now() + ttlMs,
    };

    return accessToken;
  }
}
