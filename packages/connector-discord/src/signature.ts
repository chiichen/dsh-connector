/**
 * Ed25519 request signature verification (`X-Signature-Ed25519` + `X-Signature-Timestamp`)
 * for Discord HTTP Interactions Webhooks using Node.js native `node:crypto`.
 *
 * @see https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint
 * @see https://discord.com/developers/docs/interactions/overview#validating-security-request-headers
 */

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  DISCORD_ED25519_PUBLIC_KEY_HEX_LENGTH,
  DISCORD_ED25519_SIGNATURE_HEX_LENGTH,
  DISCORD_SECONDS_TO_MS,
  DISCORD_SIGNATURE_HEADER,
  DISCORD_TIMESTAMP_HEADER,
} from "./constants";

const HEX_STRING_RE = /^[0-9a-fA-F]+$/;
const DECIMAL_TIMESTAMP_RE = /^\d+$/;

export interface VerifyDiscordEd25519Params {
  readonly publicKeyHex: string;
  readonly signatureHex: string;
  readonly timestamp: string;
  readonly rawBody: Uint8Array;
}

export interface VerifyDiscordInteractionHeadersParams {
  readonly publicKeyHex: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Uint8Array;
  readonly maxSignatureAgeMs?: number;
  readonly nowMs?: number;
}

function importRawEd25519PublicKey(publicKeyHex: string): KeyObject | undefined {
  const trimmed = publicKeyHex.trim();
  if (trimmed.length !== DISCORD_ED25519_PUBLIC_KEY_HEX_LENGTH || !HEX_STRING_RE.test(trimmed)) {
    return undefined;
  }
  const rawKeyBytes = Buffer.from(trimmed, "hex");
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: rawKeyBytes.toString("base64url"),
    },
    format: "jwk",
  });
}

export function getHeaderFirstValue(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  targetLowerName: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== targetLowerName) {
      continue;
    }
    if (typeof value === "string") {
      return value.trim();
    }
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
      return value[0].trim();
    }
  }
  return undefined;
}

/**
 * Verifies a Discord Ed25519 detached signature over `UTF8(timestamp) || rawBody`.
 *
 * @see https://discord.com/developers/docs/interactions/overview#validating-security-request-headers
 */
export function verifyDiscordEd25519Signature(params: VerifyDiscordEd25519Params): boolean {
  const signatureTrimmed = params.signatureHex.trim();
  if (
    params.timestamp.length === 0 ||
    signatureTrimmed.length !== DISCORD_ED25519_SIGNATURE_HEX_LENGTH ||
    !HEX_STRING_RE.test(signatureTrimmed)
  ) {
    return false;
  }

  const publicKey = importRawEd25519PublicKey(params.publicKeyHex);
  if (publicKey === undefined) {
    return false;
  }

  const messageBuffer = Buffer.concat([
    Buffer.from(params.timestamp, "utf8"),
    Buffer.from(params.rawBody),
  ]);
  const signatureBuffer = Buffer.from(signatureTrimmed, "hex");
  return verify(null, messageBuffer, publicKey, signatureBuffer);
}

/**
 * Extracts `X-Signature-Ed25519` and `X-Signature-Timestamp` headers (case-insensitively),
 * optionally checks timestamp freshness, and validates the Ed25519 signature.
 *
 * @see https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint
 */
export function verifyDiscordInteractionHeaders(
  params: VerifyDiscordInteractionHeadersParams,
): boolean {
  const signatureHex = getHeaderFirstValue(params.headers, DISCORD_SIGNATURE_HEADER);
  const timestamp = getHeaderFirstValue(params.headers, DISCORD_TIMESTAMP_HEADER);
  if (signatureHex === undefined || timestamp === undefined || timestamp.length === 0) {
    return false;
  }

  if (params.maxSignatureAgeMs !== undefined) {
    if (!DECIMAL_TIMESTAMP_RE.test(timestamp)) {
      return false;
    }
    const timestampMs = Number(timestamp) * DISCORD_SECONDS_TO_MS;
    const nowMs = params.nowMs ?? Date.now();
    if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > params.maxSignatureAgeMs) {
      return false;
    }
  }

  return verifyDiscordEd25519Signature({
    publicKeyHex: params.publicKeyHex,
    signatureHex,
    timestamp,
    rawBody: params.rawBody,
  });
}
