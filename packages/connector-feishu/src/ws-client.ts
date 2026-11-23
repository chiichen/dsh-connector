/**
 * Feishu (Lark) persistent WebSocket long-connection client (`POST /callback/ws/endpoint`
 * + `pbbp2.Frame` control/data loop) built on standard `WebSocket`.
 *
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 * @see https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events
 */

import { ConnectorTransportError, type ConnectorLogger } from "@dsh-connector/core";
import {
  DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_WS_PING_INTERVAL_MS,
  DEFAULT_WS_RECONNECT_COUNT,
  DEFAULT_WS_RECONNECT_INTERVAL_MS,
  DEFAULT_WS_RECONNECT_NONCE_MS,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  MS_PER_SECOND,
  PBBP2_FRAME_METHOD_CONTROL,
  PBBP2_FRAME_METHOD_DATA,
  PBBP2_HEADER_BIZ_RT,
  PBBP2_HEADER_MESSAGE_ID,
  PBBP2_HEADER_SEQ,
  PBBP2_HEADER_SUM,
  PBBP2_HEADER_TYPE,
  PBBP2_MESSAGE_TYPE_EVENT,
  PBBP2_MESSAGE_TYPE_PING,
  PBBP2_MESSAGE_TYPE_PONG,
} from "./constants";
import type { FeishuApiClient, FeishuWsServerClientConfig } from "./api-client";
import {
  FeishuWsFragmentAssembler,
  decodePbbp2Frame,
  encodePbbp2Frame,
  type DecodedFeishuPbbp2Frame,
  type FeishuPbbp2Header,
} from "./ws-protocol";

const WS_READY_STATE_OPEN = 1 as const;

/**
 * Minimal standard `WebSocket` subset enabling deterministic test injection
 * while directly matching Node.js >=24 global `WebSocket`.
 */
export interface FeishuWebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type FeishuWebSocketFactory = (url: string) => FeishuWebSocketLike;

export interface FeishuWsClientOptions {
  readonly apiClient: FeishuApiClient;
  readonly onEventEnvelope: (envelope: Record<string, unknown>) => Promise<void>;
  readonly createWebSocket?: FeishuWebSocketFactory;
  readonly handshakeTimeoutMs?: number;
  readonly autoReconnect?: boolean;
  readonly logger?: ConnectorLogger;
  readonly now?: () => number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractBinaryBytes(event: unknown): Uint8Array | undefined {
  if (!isPlainRecord(event)) return undefined;
  const raw = event["data"];
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return undefined;
}

function findHeader(headers: readonly FeishuPbbp2Header[], key: string): string | undefined {
  return headers.find((h) => h.key === key)?.value;
}

function defaultWebSocketFactory(url: string): FeishuWebSocketLike {
  const ws = new globalThis.WebSocket(url);
  ws.binaryType = "arraybuffer";
  return ws as unknown as FeishuWebSocketLike;
}

export class FeishuWsLongConnectionClient {
  private readonly apiClient: FeishuApiClient;
  private readonly onEventEnvelope: (envelope: Record<string, unknown>) => Promise<void>;
  private readonly createWebSocket: FeishuWebSocketFactory;
  private readonly handshakeTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly logger: ConnectorLogger | undefined;
  private readonly now: () => number;
  private readonly assembler: FeishuWsFragmentAssembler;

  private activeSocket: FeishuWebSocketLike | undefined;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = true;
  private generation = 0;

  private serviceId = 0;
  private pingIntervalMs: number = DEFAULT_WS_PING_INTERVAL_MS;
  private reconnectIntervalMs: number = DEFAULT_WS_RECONNECT_INTERVAL_MS;
  private reconnectNonceMs: number = DEFAULT_WS_RECONNECT_NONCE_MS;
  private reconnectCount: number = DEFAULT_WS_RECONNECT_COUNT;

  constructor(options: FeishuWsClientOptions) {
    this.apiClient = options.apiClient;
    this.onEventEnvelope = options.onEventEnvelope;
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
    this.autoReconnect = options.autoReconnect ?? true;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.assembler = new FeishuWsFragmentAssembler({ now: this.now });
  }

  async start(): Promise<void> {
    if (!this.closed && this.activeSocket?.readyState === WS_READY_STATE_OPEN) {
      return;
    }
    this.closed = false;
    const gen = ++this.generation;
    await this.connectOnce(gen);
  }

  stop(): void {
    this.closed = true;
    this.generation += 1;
    this.clearTimers();
    this.assembler.clear();
    const sock = this.activeSocket;
    this.activeSocket = undefined;
    if (sock !== undefined) {
      try {
        sock.close();
      } catch {
        // Ignore close errors during shutdown
      }
    }
  }

  private clearTimers(): void {
    if (this.pingTimer !== undefined) {
      clearTimeout(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private applyServerClientConfig(cfg: FeishuWsServerClientConfig | undefined): void {
    if (cfg === undefined) return;
    if (typeof cfg.PingInterval === "number" && cfg.PingInterval > 0) {
      this.pingIntervalMs = cfg.PingInterval * MS_PER_SECOND;
    }
    if (typeof cfg.ReconnectInterval === "number" && cfg.ReconnectInterval > 0) {
      this.reconnectIntervalMs = cfg.ReconnectInterval * MS_PER_SECOND;
    }
    if (typeof cfg.ReconnectNonce === "number" && cfg.ReconnectNonce >= 0) {
      this.reconnectNonceMs = cfg.ReconnectNonce * MS_PER_SECOND;
    }
    if (typeof cfg.ReconnectCount === "number" && Number.isInteger(cfg.ReconnectCount)) {
      this.reconnectCount = cfg.ReconnectCount;
    }
  }

  private async connectOnce(expectedGen: number): Promise<void> {
    const endpoint = await this.apiClient.pullWsEndpoint();
    if (this.closed || expectedGen !== this.generation) {
      return;
    }

    this.applyServerClientConfig(endpoint.clientConfig);
    const parsedUrl = new URL(endpoint.url);
    const rawServiceId = Number(parsedUrl.searchParams.get("service_id") ?? "0");
    this.serviceId = Number.isSafeInteger(rawServiceId) ? rawServiceId : 0;

    const socket = this.createWebSocket(endpoint.url);
    if (socket.binaryType !== undefined) {
      socket.binaryType = "arraybuffer";
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        try {
          socket.close();
        } catch {
          // best effort
        }
        reject(
          new ConnectorTransportError(
            `Feishu WebSocket handshake timed out after ${this.handshakeTimeoutMs}ms.`,
            { connectorName: this.apiClient.connectorName, retryable: true },
          ),
        );
      }, this.handshakeTimeoutMs);
      timer.unref?.();

      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        reject(
          new ConnectorTransportError("Feishu WebSocket connection handshake failed.", {
            connectorName: this.apiClient.connectorName,
            retryable: true,
          }),
        );
      };

      const cleanupHandshake = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });

    if (this.closed || expectedGen !== this.generation) {
      try {
        socket.close();
      } catch {
        // best effort
      }
      return;
    }

    this.activeSocket = socket;
    this.bindSocketListeners(socket, expectedGen);
    this.sendPingAndScheduleNext(expectedGen);
  }

  private bindSocketListeners(socket: FeishuWebSocketLike, expectedGen: number): void {
    socket.addEventListener("message", (event) => {
      if (this.closed || expectedGen !== this.generation) return;
      const bytes = extractBinaryBytes(event);
      if (bytes === undefined) return;
      void this.handleInboundFrameBytes(socket, bytes);
    });

    socket.addEventListener("error", (event) => {
      this.logger?.warn("Feishu WebSocket connection error", {
        connectorName: this.apiClient.connectorName,
        event: String(event),
      });
    });

    socket.addEventListener("close", () => {
      if (this.closed || expectedGen !== this.generation) return;
      this.clearTimers();
      this.activeSocket = undefined;
      if (this.autoReconnect) {
        this.scheduleReconnect(expectedGen, 0);
      }
    });
  }

  private scheduleReconnect(expectedGen: number, attempt: number): void {
    if (this.closed || expectedGen !== this.generation) return;
    if (this.reconnectCount >= 0 && attempt >= this.reconnectCount) {
      this.logger?.error("Feishu WebSocket exhausted maximum reconnect attempts", {
        connectorName: this.apiClient.connectorName,
        attempts: attempt,
      });
      return;
    }

    const jitterMs =
      attempt === 0 && this.reconnectNonceMs > 0 ? Math.random() * this.reconnectNonceMs : 0;
    const delayMs = attempt === 0 ? jitterMs : this.reconnectIntervalMs;

    this.reconnectTimer = setTimeout(() => {
      if (this.closed || expectedGen !== this.generation) return;
      this.connectOnce(expectedGen).catch((error: unknown) => {
        this.logger?.warn("Feishu WebSocket reconnect attempt failed", {
          connectorName: this.apiClient.connectorName,
          attempt: attempt + 1,
          error: String(error),
        });
        this.scheduleReconnect(expectedGen, attempt + 1);
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private sendPingAndScheduleNext(expectedGen: number): void {
    if (this.closed || expectedGen !== this.generation) return;
    const sock = this.activeSocket;
    if (sock !== undefined && sock.readyState === WS_READY_STATE_OPEN) {
      const pingBytes = encodePbbp2Frame({
        seqId: 0,
        logId: 0,
        service: this.serviceId,
        method: PBBP2_FRAME_METHOD_CONTROL,
        headers: [{ key: PBBP2_HEADER_TYPE, value: PBBP2_MESSAGE_TYPE_PING }],
      });
      try {
        sock.send(pingBytes);
      } catch (error) {
        this.logger?.warn("Failed sending Feishu WebSocket ping frame", {
          connectorName: this.apiClient.connectorName,
          error: String(error),
        });
      }
    }

    this.pingTimer = setTimeout(() => {
      this.sendPingAndScheduleNext(expectedGen);
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private async handleInboundFrameBytes(
    socket: FeishuWebSocketLike,
    bytes: Uint8Array,
  ): Promise<void> {
    let frame: DecodedFeishuPbbp2Frame;
    try {
      frame = decodePbbp2Frame(bytes);
    } catch (error) {
      this.logger?.error("Failed decoding Feishu pbbp2 WebSocket frame", {
        connectorName: this.apiClient.connectorName,
        error: String(error),
      });
      return;
    }

    if (frame.method === PBBP2_FRAME_METHOD_CONTROL) {
      this.handleControlFrame(frame);
      return;
    }

    if (frame.method === PBBP2_FRAME_METHOD_DATA) {
      await this.handleDataFrame(socket, frame);
    }
  }

  private handleControlFrame(frame: DecodedFeishuPbbp2Frame): void {
    const type = findHeader(frame.headers, PBBP2_HEADER_TYPE);
    if (type !== PBBP2_MESSAGE_TYPE_PONG || frame.payload.byteLength === 0) {
      return;
    }
    try {
      const text = new TextDecoder("utf-8").decode(frame.payload);
      const parsed: unknown = JSON.parse(text);
      if (isPlainRecord(parsed)) {
        this.applyServerClientConfig(parsed as FeishuWsServerClientConfig);
      }
    } catch (error) {
      this.logger?.warn("Invalid JSON payload in Feishu WebSocket pong frame", {
        connectorName: this.apiClient.connectorName,
        error: String(error),
      });
    }
  }

  private async handleDataFrame(
    socket: FeishuWebSocketLike,
    frame: DecodedFeishuPbbp2Frame,
  ): Promise<void> {
    const type = findHeader(frame.headers, PBBP2_HEADER_TYPE);
    if (type !== PBBP2_MESSAGE_TYPE_EVENT) {
      return;
    }

    const messageId = findHeader(frame.headers, PBBP2_HEADER_MESSAGE_ID) ?? String(frame.seqId);
    const sum = Number(findHeader(frame.headers, PBBP2_HEADER_SUM) ?? "1");
    const seq = Number(findHeader(frame.headers, PBBP2_HEADER_SEQ) ?? "0");

    let mergedPayload: Uint8Array | undefined;
    try {
      mergedPayload = this.assembler.push({
        messageId,
        sum,
        seq,
        chunk: frame.payload,
      });
    } catch (error) {
      this.logger?.error("Failed reassembling Feishu WebSocket event fragments", {
        connectorName: this.apiClient.connectorName,
        messageId,
        error: String(error),
      });
      return;
    }

    if (mergedPayload === undefined) {
      return;
    }

    const startTimeMs = this.now();
    let ackCode: number = HTTP_STATUS_OK;

    try {
      const rawJson = new TextDecoder("utf-8").decode(mergedPayload);
      const parsed: unknown = JSON.parse(rawJson);
      if (!isPlainRecord(parsed)) {
        throw new Error("Decoded Feishu WebSocket event payload is not a JSON object.");
      }
      await this.onEventEnvelope(parsed);
    } catch (error) {
      ackCode = HTTP_STATUS_INTERNAL_SERVER_ERROR;
      this.logger?.error("Failed handling Feishu WebSocket event payload", {
        connectorName: this.apiClient.connectorName,
        messageId,
        error: String(error),
      });
    }

    const elapsedMs = Math.max(0, this.now() - startTimeMs);
    if (socket.readyState === WS_READY_STATE_OPEN) {
      const ackHeaders: FeishuPbbp2Header[] = [
        ...frame.headers.filter((h) => h.key !== PBBP2_HEADER_BIZ_RT),
        { key: PBBP2_HEADER_BIZ_RT, value: String(elapsedMs) },
      ];
      const ackBytes = encodePbbp2Frame({
        seqId: frame.seqId,
        logId: frame.logId,
        service: frame.service,
        method: PBBP2_FRAME_METHOD_DATA,
        headers: ackHeaders,
        payloadEncoding: frame.payloadEncoding,
        payloadType: frame.payloadType,
        payload: new TextEncoder().encode(JSON.stringify({ code: ackCode })),
        logIdNew: frame.logIdNew,
      });
      try {
        socket.send(ackBytes);
      } catch (error) {
        this.logger?.warn("Failed sending Feishu WebSocket event ack frame", {
          connectorName: this.apiClient.connectorName,
          messageId,
          error: String(error),
        });
      }
    }
  }
}
