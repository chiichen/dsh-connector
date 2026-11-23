import { ConnectorTransportError, type ConnectorLogger } from "@dsh-connector/core";
import type { SlackApiClient } from "./api-client";
import {
  DEFAULT_SLACK_CONNECT_TIMEOUT_MS,
  SLACK_RECONNECT_DELAYS_MS,
  SLACK_SOCKET_PACKET_DISCONNECT,
  SLACK_SOCKET_PACKET_EVENTS_API,
  SLACK_SOCKET_PACKET_HELLO,
  SLACK_WS_CLOSE_NORMAL,
  SLACK_WS_CLOSE_RECONNECT,
  SLACK_WS_READY_STATE_CLOSING,
  SLACK_WS_READY_STATE_OPEN,
} from "./constants";

export type SlackWebSocketEventType = "open" | "message" | "close" | "error";

/**
 * Minimal WebSocket contract satisfied by Node.js 24 native global `WebSocket`
 * as well as `ws`-compatible clients for deterministic test injection.
 *
 * @see https://docs.slack.dev/apis/events-api/using-socket-mode/
 */
export interface SlackWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: SlackWebSocketEventType, listener: (event: unknown) => void): void;
  on?(event: SlackWebSocketEventType, listener: (event: unknown) => void): void;
}

export interface SlackSocketModeClientOptions {
  readonly connectorName: string;
  readonly apiClient: SlackApiClient;
  readonly onEventCallback: (payload: unknown) => Promise<void>;
  readonly onHelloAppId?: (appId: string) => void;
  readonly getLogger?: () => ConnectorLogger | undefined;
  readonly createWebSocket?: (url: string) => SlackWebSocketLike;
  readonly connectTimeoutMs?: number;
  readonly reconnectDelaysMs?: readonly number[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachSocketListener(
  socket: SlackWebSocketLike,
  type: SlackWebSocketEventType,
  listener: (event: unknown) => void,
): void {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(type, listener);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(type, listener);
    return;
  }
  throw new ConnectorTransportError(
    "Provided Slack WebSocket implementation supports neither addEventListener nor on.",
  );
}

function extractFrameText(event: unknown): string | undefined {
  const raw = isPlainRecord(event) && "data" in event ? event["data"] : event;
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return undefined;
}

/**
 * Slack Socket Mode WebSocket connection manager:
 * 1. Requests a dynamic `wss://` ticket URL via `apps.connections.open`
 * 2. Establishes WebSocket and awaits Slack's `{"type":"hello"}` frame
 * 3. Immediately acknowledges all frames carrying `envelope_id` (`{"envelope_id":"..."}`)
 * 4. Handles `disconnect` (`refresh_requested` / `warning`) and unexpected socket closes
 *    with bounded exponential backoff reconnection.
 *
 * @see https://docs.slack.dev/apis/events-api/using-socket-mode/
 * @see https://docs.slack.dev/reference/methods/apps.connections.open
 */
export class SlackSocketModeClient {
  private readonly connectorName: string;
  private readonly apiClient: SlackApiClient;
  private readonly onEventCallback: (payload: unknown) => Promise<void>;
  private readonly onHelloAppId: ((appId: string) => void) | undefined;
  private readonly getLogger: (() => ConnectorLogger | undefined) | undefined;
  private readonly createWebSocket: (url: string) => SlackWebSocketLike;
  private readonly connectTimeoutMs: number;
  private readonly reconnectDelaysMs: readonly number[];

  private stopped = true;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private abortController: AbortController | undefined;
  private socket: SlackWebSocketLike | undefined;
  private startingPromise: Promise<void> | undefined;
  private readonly inFlightTasks = new Set<Promise<void>>();

  constructor(options: SlackSocketModeClientOptions) {
    this.connectorName = options.connectorName;
    this.apiClient = options.apiClient;
    this.onEventCallback = options.onEventCallback;
    this.onHelloAppId = options.onHelloAppId;
    this.getLogger = options.getLogger;
    this.createWebSocket = options.createWebSocket ?? ((url: string) => new WebSocket(url));
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_SLACK_CONNECT_TIMEOUT_MS;
    this.reconnectDelaysMs =
      options.reconnectDelaysMs !== undefined && options.reconnectDelaysMs.length > 0
        ? options.reconnectDelaysMs
        : SLACK_RECONNECT_DELAYS_MS;
  }

  get isConnected(): boolean {
    return !this.stopped && this.socket?.readyState === SLACK_WS_READY_STATE_OPEN;
  }

  async start(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    if (this.startingPromise !== undefined) {
      return this.startingPromise;
    }

    this.startingPromise = this.startInternal().finally(() => {
      this.startingPromise = undefined;
    });
    return this.startingPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = undefined;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const currentSocket = this.socket;
    this.socket = undefined;
    if (currentSocket !== undefined && currentSocket.readyState < SLACK_WS_READY_STATE_CLOSING) {
      try {
        currentSocket.close(SLACK_WS_CLOSE_NORMAL, "Connector stopped");
      } catch (err) {
        this.getLogger?.()?.warn("Failed to close Slack Socket Mode WebSocket cleanly", {
          connector: this.connectorName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.inFlightTasks.size > 0) {
      await Promise.allSettled(this.inFlightTasks);
    }
  }

  private async startInternal(): Promise<void> {
    await this.stop();
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.abortController = new AbortController();

    try {
      await this.connectOnce();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async connectOnce(): Promise<void> {
    const { url } = await this.apiClient.openSocketConnection({
      signal: this.abortController?.signal,
    });

    if (this.stopped) {
      return;
    }

    await this.openWebSocketAndAwaitHello(url);
  }

  private openWebSocketAndAwaitHello(url: string): Promise<void> {
    const currentGen = ++this.generation;
    const socket = this.createWebSocket(url);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const connectTimer = setTimeout(() => {
        settled = true;
        try {
          socket.close(SLACK_WS_CLOSE_RECONNECT, "Socket Mode hello timeout");
        } catch {
          // Ignore close error on timed-out socket.
        }
        reject(
          new ConnectorTransportError(
            `Slack Socket Mode did not receive "hello" within ${this.connectTimeoutMs}ms.`,
            {
              connectorName: this.connectorName,
              retryable: true,
            },
          ),
        );
      }, this.connectTimeoutMs);
      connectTimer.unref?.();

      const finish = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        if (err !== undefined) {
          reject(err);
        } else {
          resolve();
        }
      };

      attachSocketListener(socket, "message", (event) => {
        if (this.stopped || currentGen !== this.generation) {
          return;
        }
        const frameText = extractFrameText(event);
        if (frameText === undefined || frameText.length === 0) {
          return;
        }

        let packet: unknown;
        try {
          packet = JSON.parse(frameText) as unknown;
        } catch {
          this.getLogger?.()?.warn("Ignored malformed Slack Socket Mode JSON frame", {
            connector: this.connectorName,
          });
          return;
        }

        if (!isPlainRecord(packet)) {
          return;
        }

        if (packet["type"] === SLACK_SOCKET_PACKET_HELLO) {
          const connInfo = packet["connection_info"];
          if (isPlainRecord(connInfo) && typeof connInfo["app_id"] === "string") {
            this.onHelloAppId?.(connInfo["app_id"]);
          }
          this.reconnectAttempt = 0;
          finish();
          return;
        }

        // Immediately ACK every envelope_id over the pre-authenticated Socket Mode connection.
        const envelopeId = packet["envelope_id"];
        if (
          typeof envelopeId === "string" &&
          envelopeId.length > 0 &&
          socket.readyState === SLACK_WS_READY_STATE_OPEN
        ) {
          socket.send(JSON.stringify({ envelope_id: envelopeId }));
        }

        if (packet["type"] === SLACK_SOCKET_PACKET_DISCONNECT) {
          const reason = typeof packet["reason"] === "string" ? packet["reason"] : "disconnect";
          this.getLogger?.()?.info("Slack Socket Mode requested connection refresh", {
            connector: this.connectorName,
            reason,
          });
          socket.close(SLACK_WS_CLOSE_RECONNECT, `Slack disconnect: ${reason}`);
          return;
        }

        if (packet["type"] === SLACK_SOCKET_PACKET_EVENTS_API) {
          const task = this.onEventCallback(packet["payload"]).catch((err) => {
            this.getLogger?.()?.error("Failed handling Slack Socket Mode events_api payload", {
              connector: this.connectorName,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          this.inFlightTasks.add(task);
          void task.finally(() => {
            this.inFlightTasks.delete(task);
          });
        }
      });

      attachSocketListener(socket, "close", (event) => {
        if (currentGen !== this.generation) {
          return;
        }
        if (this.socket === socket) {
          this.socket = undefined;
        }

        const closeCode =
          isPlainRecord(event) && typeof event["code"] === "number" ? event["code"] : 0;
        finish(
          new ConnectorTransportError(
            `Slack Socket Mode WebSocket closed (${closeCode || "unknown"}).`,
            {
              connectorName: this.connectorName,
              retryable: true,
            },
          ),
        );
        this.scheduleReconnect();
      });

      attachSocketListener(socket, "error", (event) => {
        if (this.stopped || currentGen !== this.generation) {
          return;
        }
        const errMsg =
          isPlainRecord(event) && event["error"] instanceof Error
            ? event["error"].message
            : "Slack WebSocket error";
        this.getLogger?.()?.warn("Slack Socket Mode WebSocket error", {
          connector: this.connectorName,
          error: errMsg,
        });
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) {
      return;
    }

    const delayIndex = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const delayMs = this.reconnectDelaysMs[delayIndex]!;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectOnce().catch((err) => {
        if (this.stopped) {
          return;
        }
        this.getLogger?.()?.warn("Slack Socket Mode reconnect attempt failed", {
          connector: this.connectorName,
          attempt: this.reconnectAttempt,
          error: err instanceof Error ? err.message : String(err),
        });
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }
}
