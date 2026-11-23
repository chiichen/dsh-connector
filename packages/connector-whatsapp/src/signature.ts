import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SHA256_HEX_LENGTH, WEBHOOK_SIGNATURE_PREFIX } from "./constants";

const HEX_DIGITS_RE = /^[0-9a-fA-F]+$/;

/**
 * Computes the Meta Webhook `X-Hub-Signature-256` header value (`sha256=<hex>`) for a raw HTTP body.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
 */
export function computeWhatsAppSignature(rawBody: Uint8Array, appSecret: string): string {
  const digestHex = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return `${WEBHOOK_SIGNATURE_PREFIX}${digestHex}`;
}

/**
 * Validates the `X-Hub-Signature-256` HMAC-SHA256 signature sent by Meta Webhooks against `rawBody`
 * using constant-time byte comparison (`crypto.timingSafeEqual`).
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
 */
export function verifyWhatsAppSignature(
  rawBody: Uint8Array,
  signatureHeader: string | readonly string[] | undefined,
  appSecret: string,
): boolean {
  if (appSecret.length === 0) {
    return false;
  }

  const headerValue =
    typeof signatureHeader === "string"
      ? signatureHeader
      : Array.isArray(signatureHeader)
        ? (signatureHeader[0] as string | undefined)
        : undefined;

  if (headerValue === undefined || !headerValue.startsWith(WEBHOOK_SIGNATURE_PREFIX)) {
    return false;
  }

  const signatureHex = headerValue.slice(WEBHOOK_SIGNATURE_PREFIX.length);
  if (signatureHex.length !== SHA256_HEX_LENGTH || !HEX_DIGITS_RE.test(signatureHex)) {
    return false;
  }

  const providedDigest = Buffer.from(signatureHex, "hex");
  const expectedDigest = createHmac("sha256", appSecret).update(rawBody).digest();

  return (
    providedDigest.byteLength === expectedDigest.byteLength &&
    timingSafeEqual(providedDigest, expectedDigest)
  );
}

/**
 * Verifies Meta Webhook `hub.verify_token` in constant time without leaking token length.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
export function verifyHubVerifyToken(
  providedToken: string | null | undefined,
  expectedToken: string | undefined,
): boolean {
  if (
    typeof providedToken !== "string" ||
    providedToken.length === 0 ||
    typeof expectedToken !== "string" ||
    expectedToken.length === 0
  ) {
    return false;
  }

  const providedHash = createHash("sha256").update(providedToken, "utf8").digest();
  const expectedHash = createHash("sha256").update(expectedToken, "utf8").digest();
  const hashesMatch = timingSafeEqual(providedHash, expectedHash);

  return hashesMatch && providedToken.length === expectedToken.length;
}

/**
 * Reads a header value from an incoming HTTP header map case-insensitively.
 */
export function getHeaderCaseInsensitive(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  lowerCaseName: string,
): string | readonly string[] | undefined {
  const direct = headers[lowerCaseName];
  if (direct !== undefined) {
    return direct;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerCaseName) {
      return value;
    }
  }
  return undefined;
}
