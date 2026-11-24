import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type {
  WeComWebSocketCloseEvent,
  WeComWebSocketLike,
  WeComWebSocketMessageEvent,
} from "./types";

/**
 * RFC 6455 opening handshake.
 * WeCom's long-connection server answers Node's global WebSocket, which sends
 * `upgrade: websocket`, with HTTP 404. An origin-form `GET /` carrying
 * `Upgrade: websocket` receives `101 Switching Protocols`.
 *
 * @see https://developer.work.weixin.qq.com/document/path/101463
 * @see https://datatracker.ietf.org/doc/html/rfc6455#section-1.3
 */
const WEBSOCKET_PROTOCOL_VERSION = 13;
const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HEADER_HOST = "Host";
const HEADER_CONNECTION = "Connection";
const HEADER_UPGRADE = "Upgrade";
const HEADER_SEC_WEBSOCKET_KEY = "Sec-WebSocket-Key";
const HEADER_SEC_WEBSOCKET_VERSION = "Sec-WebSocket-Version";
const HEADER_SEC_WEBSOCKET_ACCEPT = "sec-websocket-accept";
const CONNECTION_UPGRADE = "Upgrade";
const UPGRADE_WEBSOCKET = "websocket";
const HTTP_METHOD_GET = "GET";
const HTTP_SWITCHING_PROTOCOLS = 101;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
const FRAME_FIN = 0x80;
const FRAME_MASK = 0x80;
const LENGTH_7BIT_MAX = 125;
const LENGTH_16BIT_MARK = 126;
const LENGTH_64BIT_MARK = 127;
const MASK_KEY_BYTES = 4;
const EXTENDED_LENGTH_16_BYTES = 2;
const EXTENDED_LENGTH_64_BYTES = 8;
const CLOSE_CODE_BYTES = 2;
const CLOSE_REASON_MAX_BYTES = LENGTH_7BIT_MAX - CLOSE_CODE_BYTES;
const READY_CONNECTING = 0;
const READY_OPEN = 1;
const READY_CLOSING = 2;
const READY_CLOSED = 3;
const DEFAULT_WS_PORT = 80;
const DEFAULT_WSS_PORT = 443;

type SocketListener =
  | { readonly type: "open"; readonly call: () => void; once: boolean }
  | {
      readonly type: "message";
      readonly call: (event: WeComWebSocketMessageEvent) => void;
      once: boolean;
    }
  | {
      readonly type: "close";
      readonly call: (event: WeComWebSocketCloseEvent) => void;
      once: boolean;
    }
  | { readonly type: "error"; readonly call: (event: unknown) => void; once: boolean };

export function websocketRequestPath(url: string): string {
  return requestTarget(new URL(url));
}

export function createWeComWebSocket(url: string): WeComWebSocketLike {
  return new UpgradedWebSocket(url);
}

class UpgradedWebSocket implements WeComWebSocketLike {
  readyState = READY_CONNECTING;
  private readonly listeners: SocketListener[] = [];
  private socket: Socket | undefined;
  private request: http.ClientRequest | undefined;
  private buffer = Buffer.alloc(0);
  private fragmentOpcode: number | undefined;
  private readonly fragments: Buffer[] = [];
  private closeNotified = false;
  private failed = false;

  constructor(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      throw new Error(`WeCom WebSocket URL must use ws or wss, received "${parsed.protocol}".`);
    }
    const secure = parsed.protocol === "wss:";
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(`${key}${WEBSOCKET_ACCEPT_GUID}`)
      .digest("base64");
    const request = (secure ? https.request : http.request)({
      protocol: secure ? "https:" : "http:",
      hostname: parsed.hostname,
      port:
        parsed.port.length > 0 ? Number(parsed.port) : secure ? DEFAULT_WSS_PORT : DEFAULT_WS_PORT,
      path: requestTarget(parsed),
      method: HTTP_METHOD_GET,
      headers: {
        [HEADER_HOST]: parsed.host,
        [HEADER_CONNECTION]: CONNECTION_UPGRADE,
        [HEADER_UPGRADE]: UPGRADE_WEBSOCKET,
        [HEADER_SEC_WEBSOCKET_KEY]: key,
        [HEADER_SEC_WEBSOCKET_VERSION]: String(WEBSOCKET_PROTOCOL_VERSION),
      },
    });
    this.request = request;
    request.on("upgrade", (response, socket, head) => {
      this.acceptUpgrade(response, socket, head, expectedAccept);
    });
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      this.fail(new Error(`WeCom WebSocket upgrade failed with HTTP ${status}`));
    });
    request.on("error", (error) => {
      this.fail(error);
    });
    request.end();
  }

  send(data: string): void {
    if (this.readyState !== READY_OPEN || this.socket === undefined) {
      throw new Error("WeCom WebSocket is not open.");
    }
    this.socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(data), true));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === READY_CLOSED || this.readyState === READY_CLOSING) return;
    if (this.readyState === READY_CONNECTING) {
      this.readyState = READY_CLOSING;
      this.request?.destroy();
      this.notifyClose(code, reason);
      return;
    }
    this.readyState = READY_CLOSING;
    this.socket?.write(encodeFrame(OPCODE_CLOSE, closePayload(code, reason), true));
    this.socket?.end();
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener:
      | (() => void)
      | ((event: WeComWebSocketMessageEvent) => void)
      | ((event: WeComWebSocketCloseEvent) => void)
      | ((event: unknown) => void),
    options?: { readonly once?: boolean },
  ): void {
    const once = options?.once === true;
    if (type === "open") {
      this.listeners.push({ type, call: listener as () => void, once });
      return;
    }
    if (type === "message") {
      this.listeners.push({
        type,
        call: listener as (event: WeComWebSocketMessageEvent) => void,
        once,
      });
      return;
    }
    if (type === "close") {
      this.listeners.push({
        type,
        call: listener as (event: WeComWebSocketCloseEvent) => void,
        once,
      });
      return;
    }
    this.listeners.push({ type, call: listener as (event: unknown) => void, once });
  }

  removeEventListener(type: string, listener: (...args: never[]) => void): void {
    const index = this.listeners.findIndex(
      (entry) => entry.type === type && entry.call === listener,
    );
    if (index >= 0) this.listeners.splice(index, 1);
  }

  private acceptUpgrade(
    response: IncomingMessage,
    socket: Socket,
    head: Buffer,
    expectedAccept: string,
  ): void {
    const accept = firstHeader(response.headers[HEADER_SEC_WEBSOCKET_ACCEPT]);
    if (response.statusCode !== HTTP_SWITCHING_PROTOCOLS || accept !== expectedAccept) {
      socket.destroy();
      this.fail(new Error("WeCom WebSocket upgrade accept mismatch"));
      return;
    }
    this.socket = socket;
    this.readyState = READY_OPEN;
    socket.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on("error", (error) => {
      this.fail(error);
    });
    socket.on("close", () => {
      this.notifyClose();
    });
    this.emit("open");
    if (head.byteLength > 0) this.onData(head);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.consumeFrames();
  }

  private consumeFrames(): void {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      if (first === undefined || second === undefined) return;
      const fin = (first & FRAME_FIN) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & FRAME_MASK) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === LENGTH_16BIT_MARK) {
        if (this.buffer.length < offset + EXTENDED_LENGTH_16_BYTES) return;
        length = this.buffer.readUInt16BE(offset);
        offset += EXTENDED_LENGTH_16_BYTES;
      } else if (length === LENGTH_64BIT_MARK) {
        if (this.buffer.length < offset + EXTENDED_LENGTH_64_BYTES) return;
        const wide = this.buffer.readBigUInt64BE(offset);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.fail(new Error("WeCom WebSocket frame is too large."));
          return;
        }
        length = Number(wide);
        offset += EXTENDED_LENGTH_64_BYTES;
      }
      const maskLength = masked ? MASK_KEY_BYTES : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + MASK_KEY_BYTES) : undefined;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (mask !== undefined) applyMask(payload, mask);
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(fin, opcode, payload);
      if (this.readyState === READY_CLOSED) return;
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === OPCODE_PING) {
      if (this.readyState === READY_OPEN) {
        this.socket?.write(encodeFrame(OPCODE_PONG, payload, true));
      }
      return;
    }
    if (opcode === OPCODE_PONG) return;
    if (opcode === OPCODE_CLOSE) {
      const code = payload.length >= CLOSE_CODE_BYTES ? payload.readUInt16BE(0) : undefined;
      const reason =
        payload.length > CLOSE_CODE_BYTES
          ? payload.subarray(CLOSE_CODE_BYTES).toString("utf8")
          : undefined;
      if (this.readyState === READY_OPEN) {
        this.readyState = READY_CLOSING;
        this.socket?.write(encodeFrame(OPCODE_CLOSE, closePayload(code, reason), true));
        this.socket?.end();
      }
      this.notifyClose(code, reason);
      return;
    }
    if (opcode === OPCODE_CONTINUATION) {
      this.fragments.push(payload);
    } else if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      this.fragmentOpcode = opcode;
      this.fragments.length = 0;
      this.fragments.push(payload);
    } else {
      this.fail(new Error(`WeCom WebSocket received opcode ${opcode}.`));
      return;
    }
    if (!fin) return;
    const body = Buffer.concat(this.fragments);
    const kind = this.fragmentOpcode;
    this.fragments.length = 0;
    this.fragmentOpcode = undefined;
    if (kind === OPCODE_TEXT) {
      this.emit("message", { data: body.toString("utf8") });
      return;
    }
    if (kind === OPCODE_BINARY) {
      this.emit("message", { data: new Uint8Array(body) });
    }
  }

  private fail(error: unknown): void {
    if (this.readyState === READY_CLOSED) return;
    this.readyState = READY_CLOSING;
    if (!this.failed) {
      this.failed = true;
      this.emit("error", error);
    }
    this.socket?.destroy();
    this.request?.destroy();
    this.notifyClose();
  }

  private notifyClose(code?: number, reason?: string): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.readyState = READY_CLOSED;
    this.emit("close", {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  private emit(type: "open"): void;
  private emit(type: "message", event: WeComWebSocketMessageEvent): void;
  private emit(type: "close", event: WeComWebSocketCloseEvent): void;
  private emit(type: "error", event: unknown): void;
  private emit(
    type: SocketListener["type"],
    event?: WeComWebSocketMessageEvent | WeComWebSocketCloseEvent | unknown,
  ): void {
    const pending = this.listeners.filter((entry) => entry.type === type);
    for (const entry of pending) {
      if (entry.once) {
        const index = this.listeners.indexOf(entry);
        if (index >= 0) this.listeners.splice(index, 1);
      }
      if (entry.type === "open") entry.call();
      else if (entry.type === "message" && isMessageEvent(event)) entry.call(event);
      else if (entry.type === "close" && isCloseEvent(event)) entry.call(event);
      else if (entry.type === "error") entry.call(event);
    }
  }
}

function requestTarget(url: URL): string {
  const path = url.pathname.length > 0 ? url.pathname : "/";
  return `${path}${url.search}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  const length = payload.byteLength;
  let prefix = 2;
  if (length > LENGTH_7BIT_MAX && length <= 0xffff) prefix += EXTENDED_LENGTH_16_BYTES;
  else if (length > 0xffff) prefix += EXTENDED_LENGTH_64_BYTES;
  if (masked) prefix += MASK_KEY_BYTES;
  const frame = Buffer.alloc(prefix + length);
  frame[0] = FRAME_FIN | opcode;
  const maskBit = masked ? FRAME_MASK : 0;
  let offset = 2;
  if (length <= LENGTH_7BIT_MAX) {
    frame[1] = maskBit | length;
  } else if (length <= 0xffff) {
    frame[1] = maskBit | LENGTH_16BIT_MARK;
    frame.writeUInt16BE(length, offset);
    offset += EXTENDED_LENGTH_16_BYTES;
  } else {
    frame[1] = maskBit | LENGTH_64BIT_MARK;
    frame.writeBigUInt64BE(BigInt(length), offset);
    offset += EXTENDED_LENGTH_64_BYTES;
  }
  const body = Buffer.from(payload);
  if (masked) {
    const mask = randomBytes(MASK_KEY_BYTES);
    mask.copy(frame, offset);
    applyMask(body, mask);
    offset += MASK_KEY_BYTES;
  }
  body.copy(frame, offset);
  return frame;
}

function applyMask(payload: Buffer, mask: Buffer): void {
  for (let index = 0; index < payload.length; index += 1) {
    const payloadByte = payload[index];
    const maskByte = mask[index % MASK_KEY_BYTES];
    if (payloadByte === undefined || maskByte === undefined) continue;
    payload[index] = payloadByte ^ maskByte;
  }
}

function closePayload(code: number | undefined, reason: string | undefined): Buffer {
  if (code === undefined && (reason === undefined || reason.length === 0)) return Buffer.alloc(0);
  const status = code ?? 1000;
  const text = Buffer.from(reason ?? "", "utf8").subarray(0, CLOSE_REASON_MAX_BYTES);
  const payload = Buffer.alloc(CLOSE_CODE_BYTES + text.byteLength);
  payload.writeUInt16BE(status, 0);
  text.copy(payload, CLOSE_CODE_BYTES);
  return payload;
}

function isMessageEvent(value: unknown): value is WeComWebSocketMessageEvent {
  return typeof value === "object" && value !== null && "data" in value;
}

function isCloseEvent(value: unknown): value is WeComWebSocketCloseEvent {
  return typeof value === "object" && value !== null;
}
