/**
 * Enterprise WeChat (WeCom) official `WXBizMsgCrypt` protocol implementation using Node.js `node:crypto`.
 *
 * Implements:
 * - SHA-1 `msg_signature` calculation and constant-time verification (`sha1(sort(token, timestamp, nonce, encrypt))`)
 * - 43-char `EncodingAESKey` decoding into 32-byte `AESKey` + 16-byte `IV` (`AESKey[0..16]`)
 * - 32-byte block PKCS#7 padding and unpadding
 * - AES-256-CBC framing (`random(16B) + msg_len(4B UInt32BE) + msg + receiveId`)
 * - GET `echostr` URL verification and POST XML / JSON encrypted callback envelopes
 *
 * @see https://developer.work.weixin.qq.com/document/path/90930 Callback configuration & GET echostr verification
 * @see https://developer.work.weixin.qq.com/document/path/91144 Encryption/decryption algorithm specification
 * @see https://developer.work.weixin.qq.com/document/path/90968 ReceiveId semantics across self-built apps & suites
 * @see https://developer.work.weixin.qq.com/document/path/101033 Intelligent Bot JSON callback encryption (`receiveId = ""`)
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
  WECOM_AES_ALGORITHM,
  WECOM_AES_CIPHER_BLOCK_BYTE_LENGTH,
  WECOM_AES_IV_BYTE_LENGTH,
  WECOM_AES_KEY_BYTE_LENGTH,
  WECOM_ENCODING_AES_KEY_LENGTH,
  WECOM_ENVELOPE_HEADER_BYTE_LENGTH,
  WECOM_MSG_LEN_HEADER_BYTE_LENGTH,
  WECOM_PKCS7_BLOCK_BYTE_LENGTH,
  WECOM_RANDOM_PREFIX_BYTE_LENGTH,
  WECOM_SIGNATURE_ALGORITHM,
} from "./constants";
import type { WeComCallbackConfig } from "./types";

const ENCODING_AES_KEY_RE = /^[A-Za-z0-9]{43}$/;
const XML_CDATA_TAG_RE = /<([\w:-]+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/gu;
const XML_PLAIN_TAG_RE = /<([\w:-]+)>([^<>]*)<\/\1>/gu;

export type WeComCallbackEnvelopeFormat = "xml" | "json";

export interface ExtractedWeComCallbackEnvelope {
  readonly format: WeComCallbackEnvelopeFormat;
  readonly encrypt: string;
  readonly msgSignature?: string;
  readonly timestamp?: string;
  readonly nonce?: string;
  readonly toUserName?: string;
  readonly agentId?: string;
}

export interface DecryptedWeComPayload {
  readonly message: string;
  readonly receiveId: string;
}

export function decodeWeComEncodingAesKey(encodingAesKey: string): {
  readonly aesKey: Buffer;
  readonly iv: Buffer;
} {
  const trimmed = encodingAesKey.trim();
  if (trimmed.length !== WECOM_ENCODING_AES_KEY_LENGTH || !ENCODING_AES_KEY_RE.test(trimmed)) {
    throw new ConnectorValidationError(
      `Invalid WeCom EncodingAESKey: expected ${WECOM_ENCODING_AES_KEY_LENGTH} Base64 alphanumeric characters.`,
    );
  }

  const aesKey = Buffer.from(`${trimmed}=`, "base64");
  if (aesKey.byteLength !== WECOM_AES_KEY_BYTE_LENGTH) {
    throw new ConnectorValidationError(
      `Decoded WeCom AESKey must be ${WECOM_AES_KEY_BYTE_LENGTH} bytes, got ${aesKey.byteLength}.`,
    );
  }

  return {
    aesKey,
    iv: aesKey.subarray(0, WECOM_AES_IV_BYTE_LENGTH),
  };
}

/**
 * Pads plaintext bytes to a multiple of 32 bytes per WeCom `PKCS7Encoder` specification.
 *
 * @see https://developer.work.weixin.qq.com/document/path/91144
 */
export function pkcs7Pad32(data: Uint8Array): Buffer {
  const remainder = data.byteLength % WECOM_PKCS7_BLOCK_BYTE_LENGTH;
  const padLen =
    remainder === 0 ? WECOM_PKCS7_BLOCK_BYTE_LENGTH : WECOM_PKCS7_BLOCK_BYTE_LENGTH - remainder;
  const padBuf = Buffer.alloc(padLen, padLen);
  return Buffer.concat([Buffer.from(data), padBuf]);
}

/**
 * Strips and validates PKCS#7 padding (`1..32` bytes) from a decrypted WeCom buffer.
 *
 * @see https://developer.work.weixin.qq.com/document/path/91144
 */
export function pkcs7Unpad32(decrypted: Buffer): Buffer {
  if (decrypted.byteLength === 0) {
    throw new ConnectorAuthError("Decrypted WeCom payload is empty.");
  }

  const padLen = decrypted[decrypted.byteLength - 1] ?? 0;
  if (padLen < 1 || padLen > WECOM_PKCS7_BLOCK_BYTE_LENGTH || padLen > decrypted.byteLength) {
    throw new ConnectorAuthError("Invalid PKCS#7 padding length in WeCom payload.");
  }

  const padStart = decrypted.byteLength - padLen;
  for (let i = padStart; i < decrypted.byteLength; i += 1) {
    if (decrypted[i] !== padLen) {
      throw new ConnectorAuthError("Corrupted PKCS#7 padding bytes in WeCom payload.");
    }
  }

  return decrypted.subarray(0, padStart);
}

/**
 * Computes `sha1(sort(token, timestamp, nonce, encryptedMsg))` lowercase hex signature.
 *
 * @see https://developer.work.weixin.qq.com/document/path/91144
 */
export function computeWeComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encryptedMsg: string,
): string {
  const sorted = [token, timestamp, nonce, encryptedMsg].sort().join("");
  return createHash(WECOM_SIGNATURE_ALGORITHM).update(sorted, "utf8").digest("hex");
}

export function verifyWeComSignature(
  expectedSignature: string,
  token: string,
  timestamp: string,
  nonce: string,
  encryptedMsg: string,
): boolean {
  const computed = computeWeComSignature(token, timestamp, nonce, encryptedMsg);
  const expectedBuf = Buffer.from(expectedSignature.trim().toLowerCase(), "utf8");
  const computedBuf = Buffer.from(computed, "utf8");
  if (expectedBuf.byteLength === 0 || expectedBuf.byteLength !== computedBuf.byteLength) {
    return false;
  }
  return timingSafeEqual(expectedBuf, computedBuf);
}

export function parseWeComXmlFields(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of xml.matchAll(XML_CDATA_TAG_RE)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      fields[key] = value;
    }
  }
  for (const match of xml.matchAll(XML_PLAIN_TAG_RE)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined && fields[key] === undefined) {
      fields[key] = value;
    }
  }
  return fields;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts the encrypted ciphertext (`Encrypt` / `encrypt`) and optional inline signature
 * metadata from either a Self-Built App XML body or an Intelligent Bot JSON body.
 *
 * @see https://developer.work.weixin.qq.com/document/path/90238
 * @see https://developer.work.weixin.qq.com/document/path/101033
 */
export function extractEncryptedCallbackEnvelope(
  rawBodyText: string,
): ExtractedWeComCallbackEnvelope | undefined {
  const trimmed = rawBodyText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    const fields = parseWeComXmlFields(trimmed);
    const encrypt = fields["Encrypt"]?.trim();
    if (encrypt === undefined || encrypt.length === 0) {
      return undefined;
    }
    return {
      format: "xml",
      encrypt,
      ...(fields["MsgSignature"] !== undefined ? { msgSignature: fields["MsgSignature"] } : {}),
      ...(fields["TimeStamp"] !== undefined ? { timestamp: fields["TimeStamp"] } : {}),
      ...(fields["Nonce"] !== undefined ? { nonce: fields["Nonce"] } : {}),
      ...(fields["ToUserName"] !== undefined ? { toUserName: fields["ToUserName"] } : {}),
      ...(fields["AgentID"] !== undefined ? { agentId: fields["AgentID"] } : {}),
    };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isPlainRecord(parsed)) {
      return undefined;
    }
    const rawEncrypt = parsed["encrypt"] ?? parsed["Encrypt"];
    if (typeof rawEncrypt !== "string" || rawEncrypt.trim().length === 0) {
      return undefined;
    }
    const rawSig = parsed["msgsignature"] ?? parsed["msg_signature"] ?? parsed["MsgSignature"];
    const rawTs = parsed["timestamp"] ?? parsed["TimeStamp"];
    const rawNonce = parsed["nonce"] ?? parsed["Nonce"];

    return {
      format: "json",
      encrypt: rawEncrypt.trim(),
      ...(typeof rawSig === "string" ? { msgSignature: rawSig } : {}),
      ...(typeof rawTs === "string" || typeof rawTs === "number"
        ? { timestamp: String(rawTs) }
        : {}),
      ...(typeof rawNonce === "string" || typeof rawNonce === "number"
        ? { nonce: String(rawNonce) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export class WeComMsgCrypt {
  readonly token: string;
  readonly expectedReceiveId: string | undefined;
  private readonly aesKey: Buffer;
  private readonly iv: Buffer;

  constructor(config: WeComCallbackConfig) {
    const trimmedToken = config.token.trim();
    if (trimmedToken.length === 0) {
      throw new ConnectorValidationError("WeCom callback token must not be empty.");
    }
    const { aesKey, iv } = decodeWeComEncodingAesKey(config.encodingAesKey);
    this.token = trimmedToken;
    this.expectedReceiveId = config.receiveId;
    this.aesKey = aesKey;
    this.iv = iv;
  }

  sign(timestamp: string, nonce: string, encryptedMsg: string): string {
    return computeWeComSignature(this.token, timestamp, nonce, encryptedMsg);
  }

  encrypt(plaintext: string, receiveIdOverride?: string): string {
    const randomPrefix = randomBytes(WECOM_RANDOM_PREFIX_BYTE_LENGTH);
    const msgBuf = Buffer.from(plaintext, "utf8");
    const receiveIdBuf = Buffer.from(receiveIdOverride ?? this.expectedReceiveId ?? "", "utf8");
    const lenBuf = Buffer.alloc(WECOM_MSG_LEN_HEADER_BYTE_LENGTH);
    lenBuf.writeUInt32BE(msgBuf.byteLength, 0);

    const unpadded = Buffer.concat([randomPrefix, lenBuf, msgBuf, receiveIdBuf]);
    const padded = pkcs7Pad32(unpadded);

    const cipher = createCipheriv(WECOM_AES_ALGORITHM, this.aesKey, this.iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return encrypted.toString("base64");
  }

  decrypt(cipherBase64: string, expectedReceiveIdOverride?: string): DecryptedWeComPayload {
    const trimmed = cipherBase64.trim();
    if (trimmed.length === 0) {
      throw new ConnectorAuthError("WeCom encrypted payload must not be empty.");
    }

    const cipherBuf = Buffer.from(trimmed, "base64");
    if (
      cipherBuf.byteLength === 0 ||
      cipherBuf.byteLength % WECOM_AES_CIPHER_BLOCK_BYTE_LENGTH !== 0
    ) {
      throw new ConnectorAuthError(
        "WeCom ciphertext length must be a non-zero multiple of 16 bytes.",
      );
    }

    let decrypted: Buffer;
    try {
      const decipher = createDecipheriv(WECOM_AES_ALGORITHM, this.aesKey, this.iv);
      decipher.setAutoPadding(false);
      decrypted = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    } catch (error) {
      throw new ConnectorAuthError("Failed to AES-256-CBC decrypt WeCom payload.", {
        cause: error,
      });
    }

    const unpadded = pkcs7Unpad32(decrypted);
    if (unpadded.byteLength < WECOM_ENVELOPE_HEADER_BYTE_LENGTH) {
      throw new ConnectorAuthError("Decrypted WeCom frame is shorter than 20-byte header.");
    }

    const msgLen = unpadded.readUInt32BE(WECOM_RANDOM_PREFIX_BYTE_LENGTH);
    const msgEndOffset = WECOM_ENVELOPE_HEADER_BYTE_LENGTH + msgLen;
    if (msgEndOffset > unpadded.byteLength) {
      throw new ConnectorAuthError("Decrypted WeCom msg_len exceeds frame boundary.");
    }

    const message = unpadded
      .subarray(WECOM_ENVELOPE_HEADER_BYTE_LENGTH, msgEndOffset)
      .toString("utf8");
    const receiveId = unpadded.subarray(msgEndOffset).toString("utf8");

    const requiredReceiveId = expectedReceiveIdOverride ?? this.expectedReceiveId;
    if (requiredReceiveId !== undefined && receiveId !== requiredReceiveId) {
      throw new ConnectorAuthError(
        `WeCom callback receiveId mismatch: expected "${requiredReceiveId}", received "${receiveId}".`,
      );
    }

    return { message, receiveId };
  }

  /**
   * Verifies GET callback URL challenge (`echostr`) and returns the decrypted challenge string.
   *
   * @see https://developer.work.weixin.qq.com/document/path/90930
   * @see https://developer.work.weixin.qq.com/document/path/101033
   */
  verifyUrl(params: {
    readonly msgSignature: string;
    readonly timestamp: string;
    readonly nonce: string;
    readonly echostr: string;
    readonly expectedReceiveId?: string;
  }): DecryptedWeComPayload {
    if (
      !verifyWeComSignature(
        params.msgSignature,
        this.token,
        params.timestamp,
        params.nonce,
        params.echostr,
      )
    ) {
      throw new ConnectorAuthError("WeCom GET URL verification signature mismatch.");
    }
    return this.decrypt(params.echostr, params.expectedReceiveId);
  }

  /**
   * Verifies POST callback signature and decrypts `Encrypt` / `encrypt` payload.
   *
   * @see https://developer.work.weixin.qq.com/document/path/91144
   */
  decryptCallback(params: {
    readonly msgSignature: string;
    readonly timestamp: string;
    readonly nonce: string;
    readonly encrypt: string;
    readonly expectedReceiveId?: string;
  }): DecryptedWeComPayload {
    if (
      !verifyWeComSignature(
        params.msgSignature,
        this.token,
        params.timestamp,
        params.nonce,
        params.encrypt,
      )
    ) {
      throw new ConnectorAuthError("WeCom POST callback signature mismatch.");
    }
    return this.decrypt(params.encrypt, params.expectedReceiveId);
  }

  /**
   * Encrypts a passive callback reply into an XML or JSON envelope signed with `msgSignature`.
   *
   * @see https://developer.work.weixin.qq.com/document/path/91144
   * @see https://developer.work.weixin.qq.com/document/path/101033
   */
  encryptReply(params: {
    readonly plaintext: string;
    readonly timestamp: string;
    readonly nonce: string;
    readonly format: WeComCallbackEnvelopeFormat;
    readonly receiveId?: string;
  }): string {
    const encrypt = this.encrypt(params.plaintext, params.receiveId);
    const msgSignature = this.sign(params.timestamp, params.nonce, encrypt);

    if (params.format === "json") {
      return JSON.stringify({
        encrypt,
        msgsignature: msgSignature,
        timestamp: params.timestamp,
        nonce: params.nonce,
      });
    }

    return [
      "<xml>",
      `<Encrypt><![CDATA[${encrypt}]]></Encrypt>`,
      `<MsgSignature><![CDATA[${msgSignature}]]></MsgSignature>`,
      `<TimeStamp>${params.timestamp}</TimeStamp>`,
      `<Nonce><![CDATA[${params.nonce}]]></Nonce>`,
      "</xml>",
    ].join("");
  }
}
