import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { ConnectorValidationError } from "@dsh-connector/core";
import {
  ED25519_HIGH_BITS_MASK,
  ED25519_PKCS8_DER_PREFIX_HEX,
  ED25519_SEED_BYTE_LENGTH,
  ED25519_SIGNATURE_BYTE_LENGTH,
} from "./constants";

const ED25519_PKCS8_DER_PREFIX = Buffer.from(ED25519_PKCS8_DER_PREFIX_HEX, "hex");
const HEX_RE = /^[0-9a-f]+$/i;
const LAST_SIGNATURE_BYTE_INDEX = ED25519_SIGNATURE_BYTE_LENGTH - 1;

export interface QqEd25519KeyPair {
  readonly seedBytes: Uint8Array;
  readonly publicKeyBytes: Uint8Array;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/**
 * Derives the 32-byte Ed25519 seed and RFC 8032 keypair from a QQ Bot `clientSecret`
 * by repeating the UTF-8 secret bytes to 32 bytes, matching the official Go reference.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html
 */
export function deriveQqEd25519KeyPair(botSecret: string): QqEd25519KeyPair {
  const secretBytes = Buffer.from(botSecret, "utf8");
  if (secretBytes.length === 0) {
    throw new ConnectorValidationError("QQ Bot secret must not be empty for Ed25519 derivation.");
  }

  const seed = Buffer.alloc(ED25519_SEED_BYTE_LENGTH);
  for (let i = 0; i < ED25519_SEED_BYTE_LENGTH; i += 1) {
    seed[i] = secretBytes[i % secretBytes.length]!;
  }

  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_DER_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyBytes = new Uint8Array(
    spkiDer.subarray(spkiDer.length - ED25519_SEED_BYTE_LENGTH),
  );

  return {
    seedBytes: new Uint8Array(seed),
    publicKeyBytes,
    privateKey,
    publicKey,
  };
}

/**
 * Computes the hex-encoded Ed25519 signature over `event_ts + plain_token`
 * for QQ HTTP Webhook `OpCode 13` callback URL validation.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html
 */
export function signQqCallbackValidation(
  botSecret: string,
  eventTs: string,
  plainToken: string,
): string {
  const { privateKey } = deriveQqEd25519KeyPair(botSecret);
  const message = Buffer.from(`${eventTs}${plainToken}`, "utf8");
  return cryptoSign(null, message, privateKey).toString("hex");
}

/**
 * Verifies an incoming QQ HTTP Webhook request using `X-Signature-Ed25519` and
 * `X-Signature-Timestamp` against `timestamp + rawBody`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 */
export function verifyQqWebhookSignature(
  botSecret: string,
  timestamp: string,
  rawBody: Uint8Array,
  signatureHex: string,
): boolean {
  const trimmedTimestamp = timestamp.trim();
  const trimmedSig = signatureHex.trim();
  if (
    trimmedTimestamp.length === 0 ||
    trimmedSig.length !== ED25519_SIGNATURE_BYTE_LENGTH * 2 ||
    !HEX_RE.test(trimmedSig)
  ) {
    return false;
  }

  const sigBuffer = Buffer.from(trimmedSig, "hex");
  if ((sigBuffer.readUInt8(LAST_SIGNATURE_BYTE_INDEX) & ED25519_HIGH_BITS_MASK) !== 0) {
    return false;
  }

  const { publicKey } = deriveQqEd25519KeyPair(botSecret);
  const message = Buffer.concat([Buffer.from(trimmedTimestamp, "utf8"), Buffer.from(rawBody)]);
  return cryptoVerify(null, message, publicKey, sigBuffer);
}

/**
 * Signs `timestamp + rawBody` with the secret-derived Ed25519 private key.
 * Useful for deterministic webhook unit testing.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 */
export function signQqWebhookBodyForTest(
  botSecret: string,
  timestamp: string,
  rawBody: Uint8Array,
): string {
  const { privateKey } = deriveQqEd25519KeyPair(botSecret);
  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody)]);
  return cryptoSign(null, message, privateKey).toString("hex");
}
