import { createHmac, timingSafeEqual } from "node:crypto";
import { ConnectorValidationError } from "@dsh-connector/core";
import {
  DEFAULT_SLACK_SIGNATURE_TOLERANCE_SEC,
  MILLISECONDS_PER_SECOND,
  SLACK_HEADER_SIGNATURE,
  SLACK_HEADER_TIMESTAMP,
  SLACK_SIGNATURE_PREFIX,
  SLACK_SIGNATURE_VERSION,
} from "./constants";

const POSITIVE_INTEGER_SECONDS_RE = /^\d+$/;
const HMAC_ALGORITHM = "sha256";
const HEX_ENCODING = "hex";
const UTF8_ENCODING = "utf8";

export type SlackSignatureFailureReason =
  | "missing_signing_secret"
  | "missing_timestamp"
  | "missing_signature"
  | "invalid_timestamp"
  | "timestamp_expired"
  | "signature_mismatch";

export type SlackSignatureVerificationResult =
  | {
      readonly valid: true;
      readonly timestampSeconds: number;
    }
  | {
      readonly valid: false;
      readonly reason: SlackSignatureFailureReason;
      readonly message: string;
    };

export interface VerifySlackSignatureOptions {
  readonly signingSecret: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Uint8Array;
  readonly nowSeconds?: number;
  readonly toleranceSeconds?: number;
}

function getHeaderCaseInsensitive(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  targetLowerName: string,
): string | undefined {
  const direct = headers[targetLowerName];
  if (typeof direct === "string") {
    return direct.trim() || undefined;
  }
  if (Array.isArray(direct) && typeof direct[0] === "string") {
    return direct[0].trim() || undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== targetLowerName) {
      continue;
    }
    if (typeof value === "string") {
      return value.trim() || undefined;
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
      return value[0].trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Computes the Slack `v0` HMAC-SHA256 request signature (`v0=<hex_digest>`) over
 * `v0:<timestamp>:<raw_body>`.
 *
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack/
 */
export function computeSlackSignature(
  signingSecret: string,
  timestamp: string | number,
  rawBody: Uint8Array | string,
): string {
  const secret = signingSecret.trim();
  if (secret.length === 0) {
    throw new ConnectorValidationError("Slack signingSecret must be a non-empty string.");
  }

  const timestampStr = String(timestamp).trim();
  if (!POSITIVE_INTEGER_SECONDS_RE.test(timestampStr)) {
    throw new ConnectorValidationError(
      `Invalid Slack request timestamp "${String(timestamp)}": expected UNIX epoch integer seconds.`,
    );
  }

  const hmac = createHmac(HMAC_ALGORITHM, secret);
  hmac.update(`${SLACK_SIGNATURE_VERSION}:${timestampStr}:`);
  if (typeof rawBody === "string") {
    hmac.update(rawBody, UTF8_ENCODING);
  } else {
    hmac.update(rawBody);
  }
  return `${SLACK_SIGNATURE_PREFIX}${hmac.digest(HEX_ENCODING)}`;
}

/**
 * Verifies an incoming HTTP request from Slack using `X-Slack-Request-Timestamp`
 * anti-replay bounds and `X-Slack-Signature` (`v0` HMAC-SHA256) constant-time comparison.
 *
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack/
 */
export function verifySlackRequestSignature(
  options: VerifySlackSignatureOptions,
): SlackSignatureVerificationResult {
  const secret = options.signingSecret.trim();
  if (secret.length === 0) {
    return {
      valid: false,
      reason: "missing_signing_secret",
      message: "Slack signing secret is not configured.",
    };
  }

  const rawTimestamp = getHeaderCaseInsensitive(options.headers, SLACK_HEADER_TIMESTAMP);
  if (rawTimestamp === undefined) {
    return {
      valid: false,
      reason: "missing_timestamp",
      message: `Missing required "${SLACK_HEADER_TIMESTAMP}" header.`,
    };
  }

  const rawSignature = getHeaderCaseInsensitive(options.headers, SLACK_HEADER_SIGNATURE);
  if (rawSignature === undefined) {
    return {
      valid: false,
      reason: "missing_signature",
      message: `Missing required "${SLACK_HEADER_SIGNATURE}" header.`,
    };
  }

  if (!POSITIVE_INTEGER_SECONDS_RE.test(rawTimestamp)) {
    return {
      valid: false,
      reason: "invalid_timestamp",
      message: `Malformed "${SLACK_HEADER_TIMESTAMP}" header value.`,
    };
  }

  const timestampSeconds = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return {
      valid: false,
      reason: "invalid_timestamp",
      message: `Out-of-range "${SLACK_HEADER_TIMESTAMP}" header value.`,
    };
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_SLACK_SIGNATURE_TOLERANCE_SEC;
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return {
      valid: false,
      reason: "timestamp_expired",
      message: `Slack request timestamp differs from local clock by more than ${toleranceSeconds} seconds.`,
    };
  }

  if (!rawSignature.startsWith(SLACK_SIGNATURE_PREFIX)) {
    return {
      valid: false,
      reason: "signature_mismatch",
      message: `Unsupported Slack signature version in "${SLACK_HEADER_SIGNATURE}".`,
    };
  }

  const expectedSignature = computeSlackSignature(secret, rawTimestamp, options.rawBody);
  const expectedBuf = Buffer.from(expectedSignature, UTF8_ENCODING);
  const actualBuf = Buffer.from(rawSignature, UTF8_ENCODING);

  if (expectedBuf.byteLength !== actualBuf.byteLength || !timingSafeEqual(expectedBuf, actualBuf)) {
    return {
      valid: false,
      reason: "signature_mismatch",
      message: "Slack request HMAC-SHA256 signature verification failed.",
    };
  }

  return {
    valid: true,
    timestampSeconds,
  };
}
