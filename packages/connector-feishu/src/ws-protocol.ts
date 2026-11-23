/**
 * Zero-dependency binary Protobuf codec for Feishu's persistent WebSocket
 * `pbbp2.Frame` wire protocol and multi-fragment event reassembler.
 *
 * Wire specification matches official `@larksuiteoapi/node-sdk` / `oapi-sdk-go`:
 * - `Header`: `string key = 1; string value = 2;`
 * - `Frame`:
 *   - `uint64 SeqID = 1;`
 *   - `uint64 LogID = 2;`
 *   - `int32 service = 3;`
 *   - `int32 method = 4;` (`0` = control, `1` = data)
 *   - `repeated Header headers = 5;`
 *   - `string payload_encoding = 6;`
 *   - `string payload_type = 7;`
 *   - `bytes payload = 8;`
 *   - `string LogIDNew = 9;`
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 * @see https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events
 */

import { ConnectorTransportError, ConnectorValidationError } from "@dsh-connector/core";
import {
  DEFAULT_WS_FRAGMENT_TTL_MS,
  PBBP2_FIELD_HEADERS,
  PBBP2_FIELD_LOG_ID,
  PBBP2_FIELD_LOG_ID_NEW,
  PBBP2_FIELD_METHOD,
  PBBP2_FIELD_PAYLOAD,
  PBBP2_FIELD_PAYLOAD_ENCODING,
  PBBP2_FIELD_PAYLOAD_TYPE,
  PBBP2_FIELD_SEQ_ID,
  PBBP2_FIELD_SERVICE,
  PBBP2_FIXED_32_BYTES,
  PBBP2_FIXED_64_BYTES,
  PBBP2_HEADER_FIELD_KEY,
  PBBP2_HEADER_FIELD_VALUE,
  PBBP2_MAX_VARINT_SHIFT,
  PBBP2_WIRE_TYPE_32BIT,
  PBBP2_WIRE_TYPE_64BIT,
  PBBP2_WIRE_TYPE_LEN_DELIMITED,
  PBBP2_WIRE_TYPE_VARINT,
} from "./constants";

export interface FeishuPbbp2Header {
  readonly key: string;
  readonly value: string;
}

export interface FeishuPbbp2Frame {
  readonly seqId: number;
  readonly logId: number;
  readonly service: number;
  readonly method: number;
  readonly headers: readonly FeishuPbbp2Header[];
  readonly payloadEncoding?: string;
  readonly payloadType?: string;
  readonly payload: Uint8Array;
  readonly logIdNew?: string;
}

export interface DecodedFeishuPbbp2Frame {
  readonly seqId: number;
  readonly logId: number;
  readonly service: number;
  readonly method: number;
  readonly headers: readonly FeishuPbbp2Header[];
  readonly payloadEncoding: string;
  readonly payloadType: string;
  readonly payload: Uint8Array;
  readonly logIdNew: string;
}

export interface FeishuPbbp2FrameInput {
  readonly seqId: number;
  readonly logId: number;
  readonly service: number;
  readonly method: number;
  readonly headers?: readonly FeishuPbbp2Header[];
  readonly payloadEncoding?: string;
  readonly payloadType?: string;
  readonly payload?: Uint8Array;
  readonly logIdNew?: string;
}

const VARINT_CONT_BIT = 0x80n;
const VARINT_DATA_MASK = 0x7fn;
const VARINT_SHIFT_STEP = 7n;
const WIRE_TYPE_MASK = 0x07n;
const WIRE_TAG_SHIFT = 3n;
const UINT64_MASK = 0xffff_ffff_ffff_ffffn;

function pushVarint(value: bigint, out: number[]): void {
  let v = value & UINT64_MASK;
  while (v >= VARINT_CONT_BIT) {
    out.push(Number((v & VARINT_DATA_MASK) | VARINT_CONT_BIT));
    v >>= VARINT_SHIFT_STEP;
  }
  out.push(Number(v));
}

function pushTag(fieldNumber: number, wireType: number, out: number[]): void {
  pushVarint((BigInt(fieldNumber) << WIRE_TAG_SHIFT) | BigInt(wireType), out);
}

function pushVarintField(fieldNumber: number, value: number, out: number[]): void {
  pushTag(fieldNumber, PBBP2_WIRE_TYPE_VARINT, out);
  pushVarint(BigInt(Math.trunc(value)), out);
}

function pushBytesField(fieldNumber: number, bytes: Uint8Array, out: number[]): void {
  pushTag(fieldNumber, PBBP2_WIRE_TYPE_LEN_DELIMITED, out);
  pushVarint(BigInt(bytes.byteLength), out);
  for (const byte of bytes) {
    out.push(byte);
  }
}

function pushStringField(fieldNumber: number, text: string, out: number[]): void {
  if (text.length === 0) return;
  pushBytesField(fieldNumber, new TextEncoder().encode(text), out);
}

/**
 * Encode a `pbbp2.Frame` into Protobuf wire bytes.
 */
export function encodePbbp2Frame(frame: FeishuPbbp2FrameInput): Uint8Array {
  const out: number[] = [];
  pushVarintField(PBBP2_FIELD_SEQ_ID, frame.seqId, out);
  pushVarintField(PBBP2_FIELD_LOG_ID, frame.logId, out);
  pushVarintField(PBBP2_FIELD_SERVICE, frame.service, out);
  pushVarintField(PBBP2_FIELD_METHOD, frame.method, out);

  for (const header of frame.headers ?? []) {
    const headerOut: number[] = [];
    pushStringField(PBBP2_HEADER_FIELD_KEY, header.key, headerOut);
    pushStringField(PBBP2_HEADER_FIELD_VALUE, header.value, headerOut);
    pushBytesField(PBBP2_FIELD_HEADERS, Uint8Array.from(headerOut), out);
  }

  if (frame.payloadEncoding !== undefined) {
    pushStringField(PBBP2_FIELD_PAYLOAD_ENCODING, frame.payloadEncoding, out);
  }
  if (frame.payloadType !== undefined) {
    pushStringField(PBBP2_FIELD_PAYLOAD_TYPE, frame.payloadType, out);
  }
  if (frame.payload !== undefined && frame.payload.byteLength > 0) {
    pushBytesField(PBBP2_FIELD_PAYLOAD, frame.payload, out);
  }
  if (frame.logIdNew !== undefined) {
    pushStringField(PBBP2_FIELD_LOG_ID_NEW, frame.logIdNew, out);
  }

  return Uint8Array.from(out);
}

interface ReaderCursor {
  offset: number;
}

function readVarint(bytes: Uint8Array, cursor: ReaderCursor): bigint {
  let result = 0n;
  let shift = 0;
  while (cursor.offset < bytes.byteLength) {
    const byte = bytes[cursor.offset]!;
    cursor.offset += 1;
    result |= BigInt(byte & 0x7f) << BigInt(shift);
    if ((byte & 0x80) === 0) {
      return result;
    }
    shift += 7;
    if (shift >= PBBP2_MAX_VARINT_SHIFT) {
      throw new ConnectorTransportError("Malformed pbbp2 frame: varint overflow.");
    }
  }
  throw new ConnectorTransportError("Malformed pbbp2 frame: truncated varint.");
}

function readLenDelimited(bytes: Uint8Array, cursor: ReaderCursor): Uint8Array {
  const len = Number(readVarint(bytes, cursor));
  if (!Number.isSafeInteger(len) || len < 0 || cursor.offset + len > bytes.byteLength) {
    throw new ConnectorTransportError(
      "Malformed pbbp2 frame: length-delimited field out of bounds.",
    );
  }
  const slice = bytes.subarray(cursor.offset, cursor.offset + len);
  cursor.offset += len;
  return slice;
}

function skipUnknownField(wireType: number, bytes: Uint8Array, cursor: ReaderCursor): void {
  if (wireType === PBBP2_WIRE_TYPE_VARINT) {
    readVarint(bytes, cursor);
    return;
  }
  if (wireType === PBBP2_WIRE_TYPE_64BIT) {
    if (cursor.offset + PBBP2_FIXED_64_BYTES > bytes.byteLength) {
      throw new ConnectorTransportError("Malformed pbbp2 frame: truncated 64-bit field.");
    }
    cursor.offset += PBBP2_FIXED_64_BYTES;
    return;
  }
  if (wireType === PBBP2_WIRE_TYPE_LEN_DELIMITED) {
    readLenDelimited(bytes, cursor);
    return;
  }
  if (wireType === PBBP2_WIRE_TYPE_32BIT) {
    if (cursor.offset + PBBP2_FIXED_32_BYTES > bytes.byteLength) {
      throw new ConnectorTransportError("Malformed pbbp2 frame: truncated 32-bit field.");
    }
    cursor.offset += PBBP2_FIXED_32_BYTES;
    return;
  }
  throw new ConnectorTransportError(`Unsupported protobuf wire type ${wireType} in pbbp2 frame.`);
}

function decodePbbp2Header(bytes: Uint8Array): FeishuPbbp2Header {
  const cursor: ReaderCursor = { offset: 0 };
  const decoder = new TextDecoder("utf-8");
  let key = "";
  let value = "";
  while (cursor.offset < bytes.byteLength) {
    const tag = readVarint(bytes, cursor);
    const fieldNumber = Number(tag >> WIRE_TAG_SHIFT);
    const wireType = Number(tag & WIRE_TYPE_MASK);
    if (fieldNumber === PBBP2_HEADER_FIELD_KEY && wireType === PBBP2_WIRE_TYPE_LEN_DELIMITED) {
      key = decoder.decode(readLenDelimited(bytes, cursor));
    } else if (
      fieldNumber === PBBP2_HEADER_FIELD_VALUE &&
      wireType === PBBP2_WIRE_TYPE_LEN_DELIMITED
    ) {
      value = decoder.decode(readLenDelimited(bytes, cursor));
    } else {
      skipUnknownField(wireType, bytes, cursor);
    }
  }
  return { key, value };
}

/**
 * Decode Protobuf wire bytes into a `DecodedFeishuPbbp2Frame`.
 */
export function decodePbbp2Frame(bytes: Uint8Array): DecodedFeishuPbbp2Frame {
  const cursor: ReaderCursor = { offset: 0 };
  const decoder = new TextDecoder("utf-8");

  let seqId = 0;
  let logId = 0;
  let service = 0;
  let method = 0;
  const headers: FeishuPbbp2Header[] = [];
  let payloadEncoding = "";
  let payloadType = "";
  let payload: Uint8Array = new Uint8Array(0);
  let logIdNew = "";

  while (cursor.offset < bytes.byteLength) {
    const tag = readVarint(bytes, cursor);
    const fieldNumber = Number(tag >> WIRE_TAG_SHIFT);
    const wireType = Number(tag & WIRE_TYPE_MASK);

    if (fieldNumber === PBBP2_FIELD_SEQ_ID && wireType === PBBP2_WIRE_TYPE_VARINT) {
      seqId = Number(readVarint(bytes, cursor));
    } else if (fieldNumber === PBBP2_FIELD_LOG_ID && wireType === PBBP2_WIRE_TYPE_VARINT) {
      logId = Number(readVarint(bytes, cursor));
    } else if (fieldNumber === PBBP2_FIELD_SERVICE && wireType === PBBP2_WIRE_TYPE_VARINT) {
      service = Number(BigInt.asIntN(32, readVarint(bytes, cursor)));
    } else if (fieldNumber === PBBP2_FIELD_METHOD && wireType === PBBP2_WIRE_TYPE_VARINT) {
      method = Number(BigInt.asIntN(32, readVarint(bytes, cursor)));
    } else if (fieldNumber === PBBP2_FIELD_HEADERS && wireType === PBBP2_WIRE_TYPE_LEN_DELIMITED) {
      headers.push(decodePbbp2Header(readLenDelimited(bytes, cursor)));
    } else if (
      fieldNumber === PBBP2_FIELD_PAYLOAD_ENCODING &&
      wireType === PBBP2_WIRE_TYPE_LEN_DELIMITED
    ) {
      payloadEncoding = decoder.decode(readLenDelimited(bytes, cursor));
    } else if (
      fieldNumber === PBBP2_FIELD_PAYLOAD_TYPE &&
      wireType === PBBP2_WIRE_TYPE_LEN_DELIMITED
    ) {
      payloadType = decoder.decode(readLenDelimited(bytes, cursor));
    } else if (fieldNumber === PBBP2_FIELD_PAYLOAD && wireType === PBBP2_WIRE_TYPE_LEN_DELIMITED) {
      payload = new Uint8Array(readLenDelimited(bytes, cursor));
    } else if (
      fieldNumber === PBBP2_FIELD_LOG_ID_NEW &&
      wireType === PBBP2_WIRE_TYPE_LEN_DELIMITED
    ) {
      logIdNew = decoder.decode(readLenDelimited(bytes, cursor));
    } else {
      skipUnknownField(wireType, bytes, cursor);
    }
  }

  return {
    seqId,
    logId,
    service,
    method,
    headers,
    payloadEncoding,
    payloadType,
    payload,
    logIdNew,
  };
}

interface FragmentEntry {
  readonly chunks: Array<Uint8Array | undefined>;
  readonly createdAtMs: number;
}

/**
 * Reassembles multi-packet Feishu WebSocket data frames keyed by `message_id`
 * with `(sum, seq)` metadata and TTL expiration.
 */
export class FeishuWsFragmentAssembler {
  private readonly entries = new Map<string, FragmentEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options?: { readonly ttlMs?: number; readonly now?: () => number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_WS_FRAGMENT_TTL_MS;
    this.now = options?.now ?? Date.now;
  }

  push(input: {
    readonly messageId: string;
    readonly sum: number;
    readonly seq: number;
    readonly chunk: Uint8Array;
  }): Uint8Array | undefined {
    const { messageId, sum, seq, chunk } = input;
    if (
      messageId.trim().length === 0 ||
      !Number.isInteger(sum) ||
      sum <= 0 ||
      !Number.isInteger(seq) ||
      seq < 0 ||
      seq >= sum
    ) {
      throw new ConnectorValidationError(
        `Invalid Feishu WebSocket fragment metadata (messageId="${messageId}", sum=${sum}, seq=${seq}).`,
      );
    }

    const nowMs = this.now();
    this.evictExpired(nowMs);

    if (sum === 1) {
      return chunk;
    }

    let entry = this.entries.get(messageId);
    if (entry === undefined) {
      const chunks = Array.from<Uint8Array | undefined>({ length: sum });
      chunks[seq] = chunk;
      entry = { chunks, createdAtMs: nowMs };
      this.entries.set(messageId, entry);
      return undefined;
    }

    if (entry.chunks.length !== sum) {
      this.entries.delete(messageId);
      throw new ConnectorValidationError(
        `Feishu WebSocket fragment sum mismatch for "${messageId}": expected ${entry.chunks.length}, received ${sum}.`,
      );
    }

    entry.chunks[seq] = chunk;
    if (entry.chunks.some((part) => part === undefined)) {
      return undefined;
    }

    this.entries.delete(messageId);
    const definedChunks = entry.chunks as Uint8Array[];
    const totalBytes = definedChunks.reduce((acc, part) => acc + part.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of definedChunks) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    return merged;
  }

  clear(): void {
    this.entries.clear();
  }

  private evictExpired(nowMs: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (nowMs - entry.createdAtMs > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }
}
