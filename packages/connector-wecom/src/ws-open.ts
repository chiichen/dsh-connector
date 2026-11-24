import WebSocket from "ws";
import type {
  WeComWebSocketCloseEvent,
  WeComWebSocketLike,
  WeComWebSocketMessageEvent,
} from "./types";

/**
 * Opens the WeCom Intelligent Bot long connection with the `ws` client.
 * Node's global WebSocket sends `upgrade: websocket`, and WeCom answers that
 * request with HTTP 404. `ws` sends `Upgrade: websocket` and completes the
 * opening handshake for `wss://openws.work.weixin.qq.com/`.
 *
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */
export function createWeComWebSocket(url: string): WeComWebSocketLike {
  return new WsLibrarySocket(new WebSocket(url));
}

type OpenListener = () => void;
type MessageListener = (event: WeComWebSocketMessageEvent) => void;
type CloseListener = (event: WeComWebSocketCloseEvent) => void;
type ErrorListener = (event: unknown) => void;
type BoundListener = (event: unknown) => void;

class WsLibrarySocket implements WeComWebSocketLike {
  private readonly bound = new Map<
    object,
    { readonly type: string; readonly call: BoundListener }
  >();

  constructor(private readonly socket: WebSocket) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    if (code === undefined) {
      this.socket.close();
      return;
    }
    this.socket.close(code, reason ?? "");
  }

  addEventListener(
    type: "open",
    listener: OpenListener,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "message",
    listener: MessageListener,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "close",
    listener: CloseListener,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "error",
    listener: ErrorListener,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: OpenListener | MessageListener | CloseListener | ErrorListener,
    options?: { readonly once?: boolean },
  ): void {
    const call = adaptListener(type, listener);
    this.bound.set(listener, { type, call });
    this.socket.addEventListener(type, call, options);
  }

  removeEventListener(type: string, listener: (...args: never[]) => void): void {
    const entry = this.bound.get(listener);
    if (entry === undefined || entry.type !== type) return;
    this.bound.delete(listener);
    if (type === "open" || type === "message" || type === "close" || type === "error") {
      this.socket.removeEventListener(type, entry.call);
    }
  }
}

function adaptListener(
  type: "open" | "message" | "close" | "error",
  listener: OpenListener | MessageListener | CloseListener | ErrorListener,
): BoundListener {
  if (type === "open") {
    const open = listener as OpenListener;
    return () => {
      open();
    };
  }
  if (type === "message") {
    const message = listener as MessageListener;
    return (event: unknown) => {
      message({ data: messageData(event) });
    };
  }
  if (type === "close") {
    const close = listener as CloseListener;
    return (event: unknown) => {
      close(closeEvent(event));
    };
  }
  const onError = listener as ErrorListener;
  return (event: unknown) => {
    onError(errorCause(event));
  };
}

function messageData(event: unknown): string | Uint8Array | ArrayBuffer {
  const data = field(event, "data");
  if (typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array) {
    return data;
  }
  if (isByteList(data)) {
    return Buffer.concat(data.map((part) => Buffer.from(part)));
  }
  return "";
}

function closeEvent(event: unknown): WeComWebSocketCloseEvent {
  const code = field(event, "code");
  const reason = field(event, "reason");
  return {
    ...(typeof code === "number" ? { code } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

function errorCause(event: unknown): unknown {
  const cause = field(event, "error");
  if (cause instanceof Error) return cause;
  if (event instanceof Error) return event;
  return event;
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Reflect.get(value, key);
}

function isByteList(value: unknown): value is readonly Uint8Array[] {
  return Array.isArray(value) && value.every((part) => part instanceof Uint8Array);
}
