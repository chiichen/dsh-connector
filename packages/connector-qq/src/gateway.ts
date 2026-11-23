import { ConnectorAuthError, ConnectorTransportError } from "@dsh-connector/core";
import type { QqAccessTokenManager } from "./auth";
import {
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  QQ_DEFAULT_API_BASE_URL,
  QQ_DEFAULT_HEARTBEAT_INTERVAL_MS,
  QQ_DEFAULT_INTENTS,
  QQ_DEFAULT_RECONNECT_DELAYS_MS,
  QQ_DEFAULT_REQUEST_TIMEOUT_MS,
  QQ_DEFAULT_SHARD,
  QQ_EVENT_READY,
  QQ_EVENT_RESUMED,
  QQ_FALLBACK_RECONNECT_DELAY_MS,
  QQ_GATEWAY_PATH,
  QQ_OPCODE_DISPATCH,
  QQ_OPCODE_HEARTBEAT,
  QQ_OPCODE_HEARTBEAT_ACK,
  QQ_OPCODE_HELLO,
  QQ_OPCODE_IDENTIFY,
  QQ_OPCODE_INVALID_SESSION,
  QQ_OPCODE_RECONNECT,
  QQ_OPCODE_RESUME,
  QQ_WS_CLOSE_AUTH_FAILED,
  QQ_WS_CLOSE_INVALID_SEQ,
  QQ_WS_CLOSE_INVALID_SESSION,
  QQ_WS_CLOSE_NORMAL,
  QQ_WS_CLOSE_SESSION_EXPIRED,
  QQ_WS_FATAL_CLOSE_CODES,
} from "./constants";
import type { ConnectorLogger } from "@dsh-connector/core";
import type { QqRawGatewayEnvelope } from "./receiver";

export interface QqGatewayEventSink {
  registerBotUserId(botUserId: string): void;
  dispatchEnvelope(envelope: QqRawGatewayEnvelope): Promise<boolean>;
  getLogger(): ConnectorLogger | undefined;
}

const WS_READY_STATE_OPEN = 1 as const;
const WS_ZOMBIE_CLOSE_CODE = 4000 as const;

/**
 * Minimal injectable WebSocket interface compatible with standard Node.js / WHATWG `WebSocket`.
 */
export interface QqWebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type QqWebSocketFactory = (url: string) => QqWebSocketLike;

export interface QqGatewayClientOptions {
  readonly connectorName: string;
  readonly tokenManager: QqAccessTokenManager;
  readonly receiver: QqGatewayEventSink;
  readonly apiBaseUrl?: string;
  readonly gatewayUrl?: string;
  readonly intents?: number;
  readonly shard?: readonly [number, number];
  readonly reconnectDelaysMs?: readonly number[];
  readonly maxReconnectAttempts?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly createWebSocket?: QqWebSocketFactory;
}

interface GatewayDiscoveryResponse {
  readonly url?: unknown;
}

function defaultCreateWebSocket(url: string): QqWebSocketLike {
  return new WebSocket(url) as unknown as QqWebSocketLike;
}

function decodeWsMessageData(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * WebSocket Gateway client implementing the official QQ Bot Open Platform stateful lifecycle:
 * `GET /gateway` -> `OpCode 10 Hello` -> `OpCode 2 Identify` (`Authorization: QQBot <token>`) ->
 * `READY` -> periodic `OpCode 1 Heartbeat` / `OpCode 11 Heartbeat ACK` -> `OpCode 0 Dispatch` ->
 * `OpCode 6 Resume` on transient disconnect / `OpCode 7 Reconnect` / close `4009`, and fresh
 * `OpCode 2 Identify` on `OpCode 9 Invalid Session` / close `4006`/`4007`.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/opcode.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 */
export class QqGatewayClient {
  private readonly connectorName: string;
  private readonly tokenManager: QqAccessTokenManager;
  private readonly receiver: QqGatewayEventSink;
  private readonly apiBaseUrl: string;
  private readonly configuredGatewayUrl: string | undefined;
  private readonly intents: number;
  private readonly shard: readonly [number, number];
  private readonly reconnectDelaysMs: readonly number[];
  private readonly maxReconnectAttempts: number | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: QqWebSocketFactory;

  private running = false;
  private socket: QqWebSocketLike | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private awaitingHeartbeatAck = false;
  private sessionId: string | undefined;
  private lastSeq: number | null = null;
  private reconnectAttempt = 0;
  private startPromise: Promise<void> | undefined;

  constructor(options: QqGatewayClientOptions) {
    this.connectorName = options.connectorName;
    this.tokenManager = options.tokenManager;
    this.receiver = options.receiver;
    this.apiBaseUrl = (options.apiBaseUrl ?? QQ_DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.configuredGatewayUrl = options.gatewayUrl?.trim();
    this.intents = options.intents ?? QQ_DEFAULT_INTENTS;
    this.shard = options.shard ?? QQ_DEFAULT_SHARD;
    this.reconnectDelaysMs =
      options.reconnectDelaysMs !== undefined && options.reconnectDelaysMs.length > 0
        ? options.reconnectDelaysMs
        : QQ_DEFAULT_RECONNECT_DELAYS_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts;
    this.requestTimeoutMs = options.requestTimeoutMs ?? QQ_DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
  }

  /**
   * Connects to the QQ Bot WebSocket Gateway and resolves once `READY` or `RESUMED` is received.
   */
  async start(): Promise<void> {
    if (this.running && this.socket !== undefined) {
      return;
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.running = true;
    this.reconnectAttempt = 0;
    const promise = this.connectOnce(true).finally(() => {
      this.startPromise = undefined;
    });
    this.startPromise = promise;
    return promise;
  }

  /**
   * Stops heartbeat/reconnect timers and closes any active WebSocket connection.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.clearHeartbeat();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.socket;
    this.socket = undefined;
    if (ws !== undefined) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(QQ_WS_CLOSE_NORMAL, "Connector stopped");
      } catch {
        // Ignore close errors during shutdown
      }
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.awaitingHeartbeatAck = false;
  }

  private async discoverGatewayUrl(): Promise<string> {
    if (this.configuredGatewayUrl !== undefined && this.configuredGatewayUrl.length > 0) {
      return this.configuredGatewayUrl;
    }

    const authHeader = await this.tokenManager.getAuthorizationHeader();
    const url = `${this.apiBaseUrl}${QQ_GATEWAY_PATH}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          authorization: authHeader,
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      throw new ConnectorTransportError("Failed to fetch QQ Bot WebSocket gateway URL.", {
        connectorName: this.connectorName,
        retryable: true,
        cause,
      });
    }

    if (response.status === HTTP_STATUS_UNAUTHORIZED || response.status === HTTP_STATUS_FORBIDDEN) {
      this.tokenManager.invalidate();
      throw new ConnectorAuthError(
        `QQ Bot GET /gateway failed authorization with HTTP ${response.status}.`,
        { connectorName: this.connectorName },
      );
    }

    if (!response.ok) {
      throw new ConnectorTransportError(
        `QQ Bot GET /gateway failed with HTTP ${response.status}.`,
        {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable:
            response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
            response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
        },
      );
    }

    const parsed = (await response.json()) as GatewayDiscoveryResponse;
    const wsUrl = typeof parsed.url === "string" ? parsed.url.trim() : "";
    if (wsUrl.length === 0) {
      throw new ConnectorTransportError("QQ Bot GET /gateway response did not include a URL.", {
        connectorName: this.connectorName,
      });
    }
    return wsUrl;
  }

  private async connectOnce(isInitialStart: boolean): Promise<void> {
    if (!this.running) {
      return;
    }

    const [wsUrl, authToken] = await Promise.all([
      this.discoverGatewayUrl(),
      this.tokenManager.getAuthorizationHeader(),
    ]);

    if (!this.running) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleReject = (err: Error): void => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const ws = this.createWebSocket(wsUrl);
      this.socket = ws;

      ws.onmessage = (event) => {
        const text = decodeWsMessageData(event.data);
        if (text === undefined) {
          return;
        }
        let payload: QqRawGatewayEnvelope;
        try {
          const parsed: unknown = JSON.parse(text);
          if (!isPlainObject(parsed)) {
            return;
          }
          payload = parsed as QqRawGatewayEnvelope;
        } catch {
          return;
        }
        this.handleGatewayFrame(ws, payload, authToken, settleResolve);
      };

      ws.onerror = (err) => {
        this.receiver.getLogger()?.warn("QQ WebSocket Gateway error", {
          connectorName: this.connectorName,
          error: String(err),
        });
      };

      ws.onclose = (event) => {
        if (this.socket === ws) {
          this.socket = undefined;
        }
        this.clearHeartbeat();

        if (!this.running) {
          settleResolve();
          return;
        }

        if (event.code === QQ_WS_CLOSE_AUTH_FAILED) {
          this.tokenManager.invalidate();
          this.sessionId = undefined;
          this.lastSeq = null;
        }

        if (QQ_WS_FATAL_CLOSE_CODES.has(event.code)) {
          this.running = false;
          const fatalErr =
            event.code === QQ_WS_CLOSE_AUTH_FAILED
              ? new ConnectorAuthError(
                  `QQ WebSocket Gateway closed with fatal auth code ${event.code}: ${event.reason}`,
                  { connectorName: this.connectorName },
                )
              : new ConnectorTransportError(
                  `QQ WebSocket Gateway closed with fatal code ${event.code}: ${event.reason}`,
                  { connectorName: this.connectorName, retryable: false },
                );
          this.receiver.getLogger()?.error(fatalErr.message, { code: event.code });
          if (isInitialStart) {
            settleReject(fatalErr);
          }
          return;
        }

        if (event.code === QQ_WS_CLOSE_INVALID_SESSION || event.code === QQ_WS_CLOSE_INVALID_SEQ) {
          this.sessionId = undefined;
          this.lastSeq = null;
        } else if (event.code === QQ_WS_CLOSE_SESSION_EXPIRED) {
          // Official rule: 4009 preserves sessionId & lastSeq for RESUME
        }

        if (!settled && isInitialStart) {
          settleReject(
            new ConnectorTransportError(`QQ WebSocket closed before READY (code=${event.code}).`, {
              connectorName: this.connectorName,
              retryable: true,
            }),
          );
          return;
        }

        this.scheduleReconnect();
      };
    });
  }

  private handleGatewayFrame(
    ws: QqWebSocketLike,
    frame: QqRawGatewayEnvelope,
    authToken: string,
    onReadyOrResumed: () => void,
  ): void {
    if (typeof frame.s === "number") {
      this.lastSeq = frame.s;
    }

    switch (frame.op) {
      case QQ_OPCODE_HELLO: {
        const d = isPlainObject(frame.d) ? frame.d : undefined;
        const heartbeatIntervalMs =
          typeof d?.["heartbeat_interval"] === "number" && d["heartbeat_interval"] > 0
            ? d["heartbeat_interval"]
            : QQ_DEFAULT_HEARTBEAT_INTERVAL_MS;

        if (this.sessionId !== undefined && this.lastSeq !== null) {
          this.sendFrame(ws, {
            op: QQ_OPCODE_RESUME,
            d: {
              token: authToken,
              session_id: this.sessionId,
              seq: this.lastSeq,
            },
          });
        } else {
          this.sendFrame(ws, {
            op: QQ_OPCODE_IDENTIFY,
            d: {
              token: authToken,
              intents: this.intents,
              shard: [...this.shard],
              properties: {
                $os: process.platform,
                $browser: "@dsh-connector/connector-qq",
                $device: "@dsh-connector/connector-qq",
              },
            },
          });
        }

        this.startHeartbeatLoop(ws, heartbeatIntervalMs);
        break;
      }

      case QQ_OPCODE_HEARTBEAT: {
        this.sendFrame(ws, { op: QQ_OPCODE_HEARTBEAT, d: this.lastSeq });
        break;
      }

      case QQ_OPCODE_HEARTBEAT_ACK: {
        this.awaitingHeartbeatAck = false;
        break;
      }

      case QQ_OPCODE_RECONNECT: {
        ws.close(QQ_WS_CLOSE_SESSION_EXPIRED, "Server requested reconnect");
        break;
      }

      case QQ_OPCODE_INVALID_SESSION: {
        const resumable = frame.d === true;
        if (!resumable) {
          this.sessionId = undefined;
          this.lastSeq = null;
        }
        ws.close(
          resumable ? QQ_WS_CLOSE_SESSION_EXPIRED : QQ_WS_CLOSE_INVALID_SESSION,
          "Invalid session",
        );
        break;
      }

      case QQ_OPCODE_DISPATCH: {
        if (frame.t === QQ_EVENT_READY) {
          const d = isPlainObject(frame.d) ? frame.d : undefined;
          if (typeof d?.["session_id"] === "string" && d["session_id"].trim().length > 0) {
            this.sessionId = d["session_id"].trim();
          }
          const user = isPlainObject(d?.["user"]) ? d["user"] : undefined;
          if (typeof user?.["id"] === "string") {
            this.receiver.registerBotUserId(user["id"]);
          }
          this.reconnectAttempt = 0;
          onReadyOrResumed();
          return;
        }

        if (frame.t === QQ_EVENT_RESUMED) {
          this.reconnectAttempt = 0;
          onReadyOrResumed();
          return;
        }

        void this.receiver.dispatchEnvelope(frame).catch((err: unknown) => {
          this.receiver.getLogger()?.error("Failed to dispatch QQ Gateway message event", {
            connectorName: this.connectorName,
            eventType: String(frame.t),
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }

      default:
        break;
    }
  }

  private startHeartbeatLoop(ws: QqWebSocketLike, intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.running || this.socket !== ws) {
        this.clearHeartbeat();
        return;
      }
      if (this.awaitingHeartbeatAck) {
        // Missed Heartbeat ACK -> zombie connection; close to trigger RESUME
        this.clearHeartbeat();
        ws.close(WS_ZOMBIE_CLOSE_CODE, "Heartbeat ACK timeout");
        return;
      }
      this.awaitingHeartbeatAck = true;
      this.sendFrame(ws, {
        op: QQ_OPCODE_HEARTBEAT,
        d: this.lastSeq,
      });
    }, intervalMs);
  }

  private sendFrame(ws: QqWebSocketLike, payload: Record<string, unknown>): void {
    if (ws.readyState === WS_READY_STATE_OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== undefined) {
      return;
    }
    if (
      this.maxReconnectAttempts !== undefined &&
      this.reconnectAttempt >= this.maxReconnectAttempts
    ) {
      this.running = false;
      this.receiver.getLogger()?.error("QQ WebSocket Gateway max reconnect attempts exhausted", {
        connectorName: this.connectorName,
        attempts: this.reconnectAttempt,
      });
      return;
    }

    const delayIndex = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const delayMs = this.reconnectDelaysMs[delayIndex] ?? QQ_FALLBACK_RECONNECT_DELAY_MS;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.running) {
        return;
      }
      void this.connectOnce(false).catch((err: unknown) => {
        this.receiver.getLogger()?.warn("QQ WebSocket Gateway reconnect attempt failed", {
          connectorName: this.connectorName,
          attempt: this.reconnectAttempt,
          error: err instanceof Error ? err.message : String(err),
        });
        this.scheduleReconnect();
      });
    }, delayMs);
  }
}
