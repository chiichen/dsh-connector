import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { ConnectorAuthError, ConnectorValidationError } from "@dsh-connector/core";
import {
  WEIXIN_AES_ALGORITHM,
  WEIXIN_AES_IV_BYTES,
  WEIXIN_AES_KEY_BYTES,
  WEIXIN_ENCODING_AES_KEY_LEN,
  WEIXIN_FALLBACK_PKCS7_BLOCK_SIZE,
  WEIXIN_MSG_LEN_BYTES,
  WEIXIN_PKCS7_BLOCK_SIZE,
  WEIXIN_RANDOM_PREFIX_BYTES,
  WEIXIN_SHA1_HEX_LEN,
} from "./constants";

const ENCODING_AES_KEY_RE = /^[A-Za-z0-9+/]{43}$/;
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA1_HEX_RE = /^[0-9a-f]{40}$/;

/**
 * Computes the official WeChat SHA-1 signature by sorting parameters lexicographically,
 * concatenating them without a delimiter, and computing the lowercase SHA-1 hex digest.
 *
 * @see https://developers.weixin.qq.com/doc/service/guide/dev/push/
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */
export function computeWeixinSignature(params: readonly string[]): string {
  const sorted = [...params].sort();
  return createHash("sha1").update(sorted.join(""), "utf8").digest("hex");
}

function safeCompareSha1Hex(computedHex: string, expectedSignature: string): boolean {
  const normalizedExpected = expectedSignature.trim().toLowerCase();
  if (normalizedExpected.length !== WEIXIN_SHA1_HEX_LEN || !SHA1_HEX_RE.test(normalizedExpected)) {
    return false;
  }
  const computedBuf = Buffer.from(computedHex, "hex");
  const expectedBuf = Buffer.from(normalizedExpected, "hex");
  return (
    computedBuf.byteLength === expectedBuf.byteLength && timingSafeEqual(computedBuf, expectedBuf)
  );
}

/**
 * Verifies the `signature` query parameter for WeChat `GET` (`echostr`) and plaintext `POST` callbacks.
 *
 * @see https://developers.weixin.qq.com/doc/service/guide/dev/push/
 */
export function verifyWeixinSignature(
  token: string,
  timestamp: string,
  nonce: string,
  expectedSignature: string,
): boolean {
  const computed = computeWeixinSignature([token, timestamp, nonce]);
  return safeCompareSha1Hex(computed, expectedSignature);
}

/**
 * Verifies the `msg_signature` query parameter for WeChat Safe / Compatible encrypted `POST` callbacks.
 *
 * Per official WeChat encryption specification, encrypted payloads MUST be verified with
 * `sort([token, timestamp, nonce, Encrypt])` against `msg_signature`.
 *
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */
export function verifyWeixinMsgSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encryptedPayload: string,
  expectedMsgSignature: string,
): boolean {
  const computed = computeWeixinSignature([token, timestamp, nonce, encryptedPayload]);
  return safeCompareSha1Hex(computed, expectedMsgSignature);
}

/**
 * Decodes WeChat's 43-character `EncodingAESKey` into a 32-byte AES-256 key (`Base64Decode(EncodingAESKey + "=")`).
 *
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */
export function decodeEncodingAesKey(encodingAesKey: string, connectorName?: string): Buffer {
  const trimmed = encodingAesKey.trim();
  if (trimmed.length !== WEIXIN_ENCODING_AES_KEY_LEN || !ENCODING_AES_KEY_RE.test(trimmed)) {
    throw new ConnectorValidationError(
      `Invalid Weixin EncodingAESKey: expected ${WEIXIN_ENCODING_AES_KEY_LEN} Base64 characters.`,
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }
  const decoded = Buffer.from(`${trimmed}=`, "base64");
  if (decoded.byteLength !== WEIXIN_AES_KEY_BYTES) {
    throw new ConnectorValidationError(
      `Invalid Weixin EncodingAESKey: decoded key must be ${WEIXIN_AES_KEY_BYTES} bytes.`,
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }
  return decoded;
}

function pkcs7Pad32(buf: Buffer): Buffer {
  const remainder = buf.byteLength % WEIXIN_PKCS7_BLOCK_SIZE;
  const padLen = remainder === 0 ? WEIXIN_PKCS7_BLOCK_SIZE : WEIXIN_PKCS7_BLOCK_SIZE - remainder;
  const padBuf = Buffer.alloc(padLen, padLen);
  return Buffer.concat([buf, padBuf]);
}

function pkcs7Unpad(buf: Buffer, connectorName?: string): Buffer {
  if (
    buf.byteLength < WEIXIN_FALLBACK_PKCS7_BLOCK_SIZE ||
    buf.byteLength % WEIXIN_FALLBACK_PKCS7_BLOCK_SIZE !== 0
  ) {
    throw new ConnectorValidationError(
      "Invalid Weixin decrypted block size.",
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }

  const padLen = buf[buf.byteLength - 1]!;
  if (padLen < 1 || padLen > WEIXIN_PKCS7_BLOCK_SIZE || padLen > buf.byteLength) {
    throw new ConnectorValidationError(
      "Invalid PKCS#7 padding length in Weixin encrypted message.",
      connectorName !== undefined ? { connectorName } : undefined,
    );
  }

  for (let i = buf.byteLength - padLen; i < buf.byteLength; i += 1) {
    if (buf[i] !== padLen) {
      throw new ConnectorValidationError(
        "Corrupted PKCS#7 padding bytes in Weixin encrypted message.",
        connectorName !== undefined ? { connectorName } : undefined,
      );
    }
  }

  return buf.subarray(0, buf.byteLength - padLen);
}

export interface DecryptWeixinCiphertextOptions {
  readonly encodingAesKey: string;
  readonly cipherTextBase64: string;
  readonly expectedAppId?: string;
  readonly connectorName?: string;
}

export interface DecryptedWeixinPayload {
  readonly plaintext: string;
  readonly appId: string;
}

/**
 * Decrypts a Base64 `Encrypt` payload using AES-256-CBC (`IV = AESKey.slice(0, 16)`, 32-byte PKCS#7)
 * and validates the trailing `AppID` per `WXBizMsgCrypt`.
 *
 * Binary layout: `random(16B) + msg_len(4B, UInt32BE) + msg(UTF-8) + appid(UTF-8)`.
 *
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */
export function decryptWeixinCiphertext(
  options: DecryptWeixinCiphertextOptions,
): DecryptedWeixinPayload {
  const { encodingAesKey, cipherTextBase64, expectedAppId, connectorName } = options;
  const errOpts = connectorName !== undefined ? { connectorName } : undefined;
  const aesKey = decodeEncodingAesKey(encodingAesKey, connectorName);

  const trimmedCipher = cipherTextBase64.trim();
  if (
    trimmedCipher.length === 0 ||
    trimmedCipher.length % 4 !== 0 ||
    !STRICT_BASE64_RE.test(trimmedCipher)
  ) {
    throw new ConnectorValidationError("Invalid Base64 in Weixin Encrypt field.", errOpts);
  }

  const cipherBuf = Buffer.from(trimmedCipher, "base64");
  if (cipherBuf.byteLength === 0 || cipherBuf.byteLength % WEIXIN_FALLBACK_PKCS7_BLOCK_SIZE !== 0) {
    throw new ConnectorValidationError(
      "Weixin ciphertext byte length must be a non-zero multiple of AES block size.",
      errOpts,
    );
  }

  const iv = aesKey.subarray(0, WEIXIN_AES_IV_BYTES);
  let decryptedPadded: Buffer;
  try {
    const decipher = createDecipheriv(WEIXIN_AES_ALGORITHM, aesKey, iv);
    decipher.setAutoPadding(false);
    decryptedPadded = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  } catch (error) {
    throw new ConnectorValidationError("Failed to decrypt Weixin AES-256-CBC payload.", {
      ...errOpts,
      cause: error,
    });
  }

  const fullBuf = pkcs7Unpad(decryptedPadded, connectorName);
  const headerLen = WEIXIN_RANDOM_PREFIX_BYTES + WEIXIN_MSG_LEN_BYTES;
  if (fullBuf.byteLength < headerLen) {
    throw new ConnectorValidationError("Decrypted Weixin payload is shorter than header.", errOpts);
  }

  const msgLen = fullBuf.readUInt32BE(WEIXIN_RANDOM_PREFIX_BYTES);
  const msgEnd = headerLen + msgLen;
  if (msgEnd > fullBuf.byteLength) {
    throw new ConnectorValidationError(
      "Decrypted Weixin payload message length exceeds buffer bounds.",
      errOpts,
    );
  }

  const plaintext = fullBuf.subarray(headerLen, msgEnd).toString("utf8");
  const appId = fullBuf.subarray(msgEnd).toString("utf8");

  const expectedTrimmed = expectedAppId?.trim();
  if (expectedTrimmed !== undefined && expectedTrimmed.length > 0 && appId !== expectedTrimmed) {
    throw new ConnectorAuthError(
      `Weixin encrypted payload AppID mismatch: expected "${expectedTrimmed}", received "${appId}".`,
      errOpts,
    );
  }

  return { plaintext, appId };
}

export interface EncryptWeixinPlaintextOptions {
  readonly encodingAesKey: string;
  readonly plaintext: string;
  readonly appId: string;
  readonly random16Bytes?: Uint8Array;
  readonly connectorName?: string;
}

/**
 * Encrypts a plaintext XML/JSON message into Base64 `Encrypt` format per `WXBizMsgCrypt`.
 *
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */
export function encryptWeixinPlaintext(options: EncryptWeixinPlaintextOptions): string {
  const { encodingAesKey, plaintext, appId, random16Bytes, connectorName } = options;
  const errOpts = connectorName !== undefined ? { connectorName } : undefined;
  const aesKey = decodeEncodingAesKey(encodingAesKey, connectorName);

  const randomPrefix =
    random16Bytes !== undefined
      ? Buffer.from(random16Bytes)
      : randomBytes(WEIXIN_RANDOM_PREFIX_BYTES);
  if (randomPrefix.byteLength !== WEIXIN_RANDOM_PREFIX_BYTES) {
    throw new ConnectorValidationError(
      `random16Bytes must be exactly ${WEIXIN_RANDOM_PREFIX_BYTES} bytes.`,
      errOpts,
    );
  }

  const msgBuf = Buffer.from(plaintext, "utf8");
  const appIdBuf = Buffer.from(appId.trim(), "utf8");
  const lenBuf = Buffer.allocUnsafe(WEIXIN_MSG_LEN_BYTES);
  lenBuf.writeUInt32BE(msgBuf.byteLength, 0);

  const padded = pkcs7Pad32(Buffer.concat([randomPrefix, lenBuf, msgBuf, appIdBuf]));
  const iv = aesKey.subarray(0, WEIXIN_AES_IV_BYTES);
  const cipher = createCipheriv(WEIXIN_AES_ALGORITHM, aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

export interface BuildEncryptedWeixinReplyOptions {
  readonly token: string;
  readonly encodingAesKey: string;
  readonly appId: string;
  readonly plaintext: string;
  readonly timestamp: string | number;
  readonly nonce: string;
  readonly format?: "xml" | "json";
  readonly random16Bytes?: Uint8Array;
  readonly connectorName?: string;
}

/**
 * Builds an encrypted XML or JSON webhook response envelope (`Encrypt`, `MsgSignature`, `TimeStamp`, `Nonce`).
 *
 * @see https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 */
export function buildEncryptedWeixinReply(options: BuildEncryptedWeixinReplyOptions): string {
  const encrypt = encryptWeixinPlaintext({
    encodingAesKey: options.encodingAesKey,
    plaintext: options.plaintext,
    appId: options.appId,
    random16Bytes: options.random16Bytes,
    connectorName: options.connectorName,
  });
  const timestampStr = String(options.timestamp);
  const msgSignature = computeWeixinSignature([
    options.token,
    timestampStr,
    options.nonce,
    encrypt,
  ]);

  if (options.format === "json") {
    return JSON.stringify({
      Encrypt: encrypt,
      MsgSignature: msgSignature,
      TimeStamp: options.timestamp,
      Nonce: options.nonce,
    });
  }

  return [
    "<xml>",
    `<Encrypt><![CDATA[${encrypt}]]></Encrypt>`,
    `<MsgSignature><![CDATA[${msgSignature}]]></MsgSignature>`,
    `<TimeStamp>${timestampStr}</TimeStamp>`,
    `<Nonce><![CDATA[${options.nonce}]]></Nonce>`,
    "</xml>",
  ].join("\n");
}
