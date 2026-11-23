/**
 * Feishu (Lark) event subscription v2.0 signature verification and AES-256-CBC
 * payload encryption/decryption using Node.js native `node:crypto`.
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 * @see https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/send-callbacks-to-developers-server
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { ConnectorAuthError, ConnectorValidationError } from "@dsh-connector/core";
import {
  FEISHU_AES_ALGORITHM,
  FEISHU_AES_BLOCK_BYTES,
  FEISHU_AES_MIN_CIPHERTEXT_BYTES,
  FEISHU_HASH_ALGORITHM,
} from "./constants";

export interface FeishuSignatureCheckInput {
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly encryptKey: string;
  readonly rawBody: Uint8Array;
  readonly signature: string | undefined;
  readonly connectorName?: string;
}

function deriveAes256Key(encryptKey: string, connectorName?: string): Buffer {
  if (encryptKey.length === 0) {
    throw new ConnectorValidationError(
      "Feishu encryptKey must be a non-empty string.",
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }
  return createHash(FEISHU_HASH_ALGORITHM).update(encryptKey, "utf8").digest();
}

/**
 * Compute Feishu event signature:
 * `SHA-256(UTF-8(timestamp + nonce + encrypt_key) || raw_request_body)` in lowercase hex.
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
export function computeFeishuEventSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  rawBody: Uint8Array,
): string {
  const prefixBytes = Buffer.from(`${timestamp}${nonce}${encryptKey}`, "utf8");
  const hash = createHash(FEISHU_HASH_ALGORITHM);
  hash.update(prefixBytes);
  hash.update(rawBody);
  return hash.digest("hex");
}

/**
 * Verify Feishu `X-Lark-Signature` header in constant time (`timingSafeEqual`).
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
export function verifyFeishuEventSignature(input: FeishuSignatureCheckInput): boolean {
  const { timestamp, nonce, encryptKey, rawBody, signature } = input;
  if (
    typeof timestamp !== "string" ||
    timestamp.length === 0 ||
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    typeof signature !== "string" ||
    signature.length === 0 ||
    encryptKey.length === 0
  ) {
    return false;
  }

  const expectedHex = computeFeishuEventSignature(timestamp, nonce, encryptKey, rawBody);
  const actualHex = signature.trim().toLowerCase();
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  const actualBuf = Buffer.from(actualHex, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Verify Feishu application `Verification Token` in constant time.
 *
 * @see https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/send-callbacks-to-developers-server
 */
export function verifyFeishuVerificationToken(
  actualToken: string | undefined,
  expectedToken: string,
): boolean {
  if (typeof actualToken !== "string" || actualToken.length === 0 || expectedToken.length === 0) {
    return false;
  }
  const actualBuf = Buffer.from(actualToken, "utf8");
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Decrypt Feishu `encrypt` field (`Base64(IV_16B || AES-256-CBC(ciphertext))` with `key = SHA-256(encryptKey)`).
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
export function decryptFeishuPayload(
  encryptedBase64: string,
  encryptKey: string,
  connectorName?: string,
): string {
  const key = deriveAes256Key(encryptKey, connectorName);
  const rawBuffer = Buffer.from(encryptedBase64, "base64");
  if (
    rawBuffer.length < FEISHU_AES_MIN_CIPHERTEXT_BYTES ||
    (rawBuffer.length - FEISHU_AES_BLOCK_BYTES) % FEISHU_AES_BLOCK_BYTES !== 0
  ) {
    throw new ConnectorAuthError(
      "Invalid Feishu encrypted event payload length or AES block alignment.",
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }

  const iv = rawBuffer.subarray(0, FEISHU_AES_BLOCK_BYTES);
  const ciphertext = rawBuffer.subarray(FEISHU_AES_BLOCK_BYTES);

  try {
    const decipher = createDecipheriv(FEISHU_AES_ALGORITHM, key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (cause) {
    throw new ConnectorAuthError("Failed to decrypt Feishu encrypted event payload.", {
      cause,
      ...(connectorName !== undefined ? { connectorName } : {}),
    });
  }
}

/**
 * Encrypt a plaintext UTF-8 string using Feishu's AES-256-CBC scheme (`Base64(IV_16B || ciphertext)`).
 * Useful for deterministic webhook integration testing and verification.
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
export function encryptFeishuPayload(
  plaintext: string,
  encryptKey: string,
  iv?: Uint8Array,
): string {
  const key = deriveAes256Key(encryptKey);
  const ivBytes = iv ?? randomBytes(FEISHU_AES_BLOCK_BYTES);
  if (ivBytes.byteLength !== FEISHU_AES_BLOCK_BYTES) {
    throw new ConnectorValidationError(
      `Feishu AES-256-CBC IV must be ${FEISHU_AES_BLOCK_BYTES} bytes.`,
    );
  }
  const cipher = createCipheriv(FEISHU_AES_ALGORITHM, key, ivBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(ivBytes), ciphertext]).toString("base64");
}
