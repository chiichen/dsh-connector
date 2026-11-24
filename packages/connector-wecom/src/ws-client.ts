/**
 * Enterprise WeChat (WeCom) Intelligent Bot (`智能机器人`) WebSocket long-connection client.
 *
 * Implements the official `wss://openws.work.weixin.qq.com` frame protocol:
 * - Handshake authentication via `aibot_subscribe` (`bot_id` + `secret`)
 * - Periodic keep-alive via `ping` frames (default every 30s)
 * - Inbound message (`aibot_msg_callback`) and event (`aibot_event_callback`) dispatch
 * - `disconnected_event` detection (suppresses reconnect war when superseded by a newer instance)
 * - Outbound proactive (`aibot_send_msg`) and callback-correlated (`aibot_respond_msg`) frames
 * - Exponential backoff auto-reconnection on transient network drops
 *
 * @see https://developer.work.weixin.qq.com/document/path/101463
 */

import { randomUUID } from "node:crypto";
import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  type ConnectorLogger,
  type ConnectorSendOptions,
} from "@dsh-connector/core";
import {
  DEFAULT_WECOM_AIBOT_WS_URL,
  DEFAULT_WECOM_CONNECTOR_NAME,
  DEFAULT_WECOM_WS_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WECOM_WS_RECONNECT_INITIAL_DELAY_MS,
  DEFAULT_WECOM_WS_RECONNECT_MAX_DELAY_MS,
  DEFAULT_WECOM_WS_REQUEST_TIMEOUT_MS,
  WECOM_AIBOT_CHAT_TYPE_GROUP,
  WECOM_AIBOT_CHAT_TYPE_SINGLE,
  WECOM_AIBOT_CMD_EVENT_CALLBACK,
  WECOM_AIBOT_CMD_MSG_CALLBACK,
  WECOM_AIBOT_CMD_PING,
  WECOM_AIBOT_CMD_RESPOND_MSG,
  WECOM_AIBOT_CMD_SEND_MSG,
  WECOM_AIBOT_CMD_SUBSCRIBE,
  WECOM_AIBOT_EVENT_DISCONNECTED,
  WECOM_AUTH_ERRCODES,
  WECOM_LOG_DISCONNECTED,
  WECOM_LOG_HANDSHAKE_FAILED,
  WECOM_LOG_MESSAGE_FAILED,
  WECOM_LOG_MESSAGE_RECEIVED,
  WECOM_ERRCODE_OK,
  WECOM_WS_RECONNECT_BACKOFF_FACTOR,
} from "./constants";
import type { WeComAibotOutboundTransport } from "./sender";
import type {
  CreateWeComWebSocket,
  WeComAibotWsConfig,
  WeComWebSocketLike,
  WeComWebSocketMessageEvent,
} from "./types";

const WS_READY_STATE_OPEN = 1;
const WS_NORMAL_CLOSE_CODE = 1000;
const WS_URL_RE = /^wss?:\/\//i;

export interface WeComAibotWsCallbackFrame {
  readonly cmd: string;
  readonly headers: {
    readonly req_id: string;
  };
  readonly body: Readonly<Record<string, unknown>>;
}

interface PendingWsRequest {
  readonly resolve: (frame: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanupAbort?: () => void;
}

export interface WeComAibotWsClientOptions {
  readonly connectorName?: string;
  readonly config: WeComAibotWsConfig;
  readonly logger?: ConnectorLogger;
  readonly onMessageCallback?: (frame: WeComAibotWsCallbackFrame) => Promise<void> | void;
  readonly onEventCallback?: (frame: WeComAibotWsCallbackFrame) => Promise<void> | void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeWsMessageData(data: WeComWebSocketMessageEvent["data"]): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  return new TextDecoder().decode(new Uint8Array(data));
}

function defaultCreateWebSocket(url: string): WeComWebSocketLike {
  return new WebSocket(url) as unknown as WeComWebSocketLike;
}

export class WeComAibotWsClient implements WeComAibotOutboundTransport {
  readonly connectorName: string;
  readonly wsUrl: string;
  private readonly botId: string;
  private readonly secret: string;
  private readonly heartbeatIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly createWebSocket: CreateWeComWebSocket;
  private readonly logger: ConnectorLogger | undefined;
  private readonly onMessageCallback:
    | ((frame: WeComAibotWsCallbackFrame) => Promise<void> | void)
    | undefined;
  private readonly onEventCallback:
    | ((frame: WeComAibotWsCallbackFrame) => Promise<void> | void)
    | undefined;

  private socket: WeComWebSocketLike | undefined;
  private subscribed = false;
  private stopped = false;
  private kickedByNewConnection = false;
  private currentReconnectDelayMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly pendingRequests = new Map<string, PendingWsRequest>();

  constructor(options: WeComAibotWsClientOptions) {
    this.connectorName = options.connectorName ?? DEFAULT_WECOM_CONNECTOR_NAME;
    this.botId = options.config.botId.trim();
    this.secret = options.config.secret.trim();
    if (this.botId.length === 0 || this.secret.length === 0) {
      throw new ConnectorValidationError(
        "WeCom Intelligent Bot WebSocket requires non-empty botId and secret.",
        { connectorName: this.connectorName },
      );
    }

    const rawUrl = options.config.wsUrl?.trim() ?? DEFAULT_WECOM_AIBOT_WS_URL;
    if (!WS_URL_RE.test(rawUrl)) {
      throw new ConnectorValidationError(
        `WeCom wsUrl must start with ws:// or wss://, received "${rawUrl}".`,
        { connectorName: this.connectorName },
      );
    }
    this.wsUrl = rawUrl;
    this.heartbeatIntervalMs =
      options.config.heartbeatIntervalMs ?? DEFAULT_WECOM_WS_HEARTBEAT_INTERVAL_MS;
    this.requestTimeoutMs = options.config.requestTimeoutMs ?? DEFAULT_WECOM_WS_REQUEST_TIMEOUT_MS;
    this.autoReconnect = options.config.autoReconnect ?? true;
    this.reconnectInitialDelayMs =
      options.config.reconnectInitialDelayMs ?? DEFAULT_WECOM_WS_RECONNECT_INITIAL_DELAY_MS;
    this.reconnectMaxDelayMs =
      options.config.reconnectMaxDelayMs ?? DEFAULT_WECOM_WS_RECONNECT_MAX_DELAY_MS;
    this.currentReconnectDelayMs = this.reconnectInitialDelayMs;
    this.createWebSocket = options.config.createWebSocket ?? defaultCreateWebSocket;
    this.logger = options.logger;
    this.onMessageCallback = options.onMessageCallback;
    this.onEventCallback = options.onEventCallback;
  }

  isConnected(): boolean {
    return (
      this.subscribed && this.socket !== undefined && this.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.kickedByNewConnection = false;
    if (this.isConnected()) {
      return;
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    const run = this.connectAndSubscribe()
      .catch((error: unknown) => {
        this.logger?.error(WECOM_LOG_HANDSHAKE_FAILED, {
          connector: this.connectorName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        if (this.startPromise === run) {
          this.startPromise = undefined;
        }
      });
    this.startPromise = run;
    return run;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.subscribed = false;
    this.clearTimers();
    this.rejectAllPending(
      new ConnectorTransportError("WeCom Intelligent Bot WebSocket client stopped.", {
        connectorName: this.connectorName,
        retryable: false,
      }),
    );

    const activeSocket = this.socket;
    this.socket = undefined;
    if (activeSocket !== undefined) {
      activeSocket.close(WS_NORMAL_CLOSE_CODE, "connector stopped");
    }
  }

  /**
   * Sends a proactive Markdown message via `aibot_send_msg`.
   *
   * @see https://developer.work.weixin.qq.com/document/path/101463
   */
  async sendProactiveMarkdown(
    input: {
      readonly chatId: string;
      readonly chatType: typeof WECOM_AIBOT_CHAT_TYPE_SINGLE | typeof WECOM_AIBOT_CHAT_TYPE_GROUP;
      readonly content: string;
    },
    options?: ConnectorSendOptions,
  ): Promise<{ readonly reqId: string; readonly raw: Readonly<Record<string, unknown>> }> {
    const reqId = randomUUID();
    const raw = await this.sendCommandAndWaitAck(
      {
        cmd: WECOM_AIBOT_CMD_SEND_MSG,
        headers: { req_id: reqId },
        body: {
          chatid: input.chatId,
          chat_type: input.chatType,
          msgtype: "markdown",
          markdown: { content: input.content },
        },
      },
      reqId,
      options?.signal,
    );
    return { reqId, raw };
  }

  /**
   * Replies to an inbound callback `req_id` via `aibot_respond_msg`.
   *
   * @see https://developer.work.weixin.qq.com/document/path/101463
   */
  async respondMarkdown(
    input: {
      readonly reqId: string;
      readonly content: string;
    },
    options?: ConnectorSendOptions,
  ): Promise<{ readonly reqId: string; readonly raw: Readonly<Record<string, unknown>> }> {
    const raw = await this.sendCommandAndWaitAck(
      {
        cmd: WECOM_AIBOT_CMD_RESPOND_MSG,
        headers: { req_id: input.reqId },
        body: {
          msgtype: "markdown",
          markdown: { content: input.content },
        },
      },
      input.reqId,
      options?.signal,
    );
    return { reqId: input.reqId, raw };
  }

  private async connectAndSubscribe(): Promise<void> {
    const ws = this.createWebSocket(this.wsUrl);
    this.socket = ws;
    this.subscribed = false;

    ws.addEventListener("message", (event) => {
      this.handleRawMessage(event);
    });

    ws.addEventListener("close", () => {
      if (this.socket === ws) {
        this.handleSocketClosed();
      }
    });

    ws.addEventListener("error", (err) => {
      this.logger?.warn("WeCom Intelligent Bot WebSocket error", {
        connector: this.connectorName,
        error: String(err),
      });
    });

    await this.waitForOpen(ws);

    const subscribeReqId = randomUUID();
    try {
      await this.sendFrameOnSocket(
        ws,
        {
          cmd: WECOM_AIBOT_CMD_SUBSCRIBE,
          headers: { req_id: subscribeReqId },
          body: {
            bot_id: this.botId,
            secret: this.secret,
          },
        },
        subscribeReqId,
        true,
      );
    } catch (error) {
      this.stopped = error instanceof ConnectorAuthError ? true : this.stopped;
      if (this.socket === ws) {
        this.socket = undefined;
      }
      ws.close(WS_NORMAL_CLOSE_CODE, "subscribe failed");
      throw error;
    }

    this.subscribed = true;
    this.currentReconnectDelayMs = this.reconnectInitialDelayMs;
    this.startHeartbeat();
  }

  private waitForOpen(ws: WeComWebSocketLike): Promise<void> {
    if (ws.readyState === WS_READY_STATE_OPEN) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ConnectorTransportError("Timed out opening WeCom Intelligent Bot WebSocket.", {
            connectorName: this.connectorName,
            retryable: true,
          }),
        );
      }, this.requestTimeoutMs);

      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );

      ws.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(
            new ConnectorTransportError(
              "WeCom Intelligent Bot WebSocket closed before handshake.",
              {
                connectorName: this.connectorName,
                retryable: true,
              },
            ),
          );
        },
        { once: true },
      );
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected() || this.socket === undefined) {
        return;
      }
      const pingReqId = randomUUID();
      this.sendFrameOnSocket(
        this.socket,
        {
          cmd: WECOM_AIBOT_CMD_PING,
          headers: { req_id: pingReqId },
        },
        pingReqId,
        false,
      ).catch((error) => {
        this.logger?.warn("WeCom Intelligent Bot WebSocket ping failed", {
          connector: this.connectorName,
          error: String(error),
        });
      });
    }, this.heartbeatIntervalMs);
  }

  private handleSocketClosed(): void {
    const wasSubscribed = this.subscribed;
    this.subscribed = false;
    this.socket = undefined;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.rejectAllPending(
      new ConnectorTransportError("WeCom Intelligent Bot WebSocket connection closed.", {
        connectorName: this.connectorName,
        retryable: true,
      }),
    );

    if (wasSubscribed && !this.stopped && !this.kickedByNewConnection) {
      this.logger?.warn(WECOM_LOG_DISCONNECTED, {
        connector: this.connectorName,
      });
    }

    if (this.stopped || this.kickedByNewConnection || !this.autoReconnect) {
      return;
    }

    const delayMs = this.currentReconnectDelayMs;
    this.currentReconnectDelayMs = Math.min(
      this.currentReconnectDelayMs * WECOM_WS_RECONNECT_BACKOFF_FACTOR,
      this.reconnectMaxDelayMs,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped || this.kickedByNewConnection) {
        return;
      }
      this.connectAndSubscribe().catch((error: unknown) => {
        this.logger?.error(WECOM_LOG_HANDSHAKE_FAILED, {
          connector: this.connectorName,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger?.warn("WeCom Intelligent Bot WebSocket reconnect attempt failed", {
          connector: this.connectorName,
          error: String(error),
        });
      });
    }, delayMs);
  }

  private handleRawMessage(event: WeComWebSocketMessageEvent): void {
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(decodeWsMessageData(event.data));
    } catch {
      this.logger?.warn("Ignoring non-JSON WeCom WebSocket frame", {
        connector: this.connectorName,
      });
      return;
    }

    if (!isPlainRecord(parsedUnknown)) {
      return;
    }

    const headers = isPlainRecord(parsedUnknown["headers"]) ? parsedUnknown["headers"] : undefined;
    const reqId = typeof headers?.["req_id"] === "string" ? headers["req_id"] : undefined;
    const cmd = typeof parsedUnknown["cmd"] === "string" ? parsedUnknown["cmd"] : undefined;

    if (cmd === undefined && reqId !== undefined) {
      const pending = this.pendingRequests.get(reqId);
      if (pending !== undefined) {
        this.pendingRequests.delete(reqId);
        clearTimeout(pending.timer);
        pending.cleanupAbort?.();

        const errcode =
          typeof parsedUnknown["errcode"] === "number"
            ? parsedUnknown["errcode"]
            : WECOM_ERRCODE_OK;
        const errmsg = typeof parsedUnknown["errmsg"] === "string" ? parsedUnknown["errmsg"] : "ok";
        if (errcode === WECOM_ERRCODE_OK) {
          pending.resolve(parsedUnknown);
        } else if (WECOM_AUTH_ERRCODES.has(errcode)) {
          pending.reject(
            new ConnectorAuthError(`WeCom WebSocket auth error ${errcode}: ${errmsg}`, {
              connectorName: this.connectorName,
            }),
          );
        } else {
          pending.reject(
            new ConnectorTransportError(`WeCom WebSocket error ${errcode}: ${errmsg}`, {
              connectorName: this.connectorName,
              retryable: false,
            }),
          );
        }
      }
      return;
    }

    if (cmd === undefined) {
      return;
    }

    const body = isPlainRecord(parsedUnknown["body"]) ? parsedUnknown["body"] : {};
    const callbackFrame: WeComAibotWsCallbackFrame = {
      cmd,
      headers: { req_id: reqId ?? "" },
      body,
    };

    if (cmd === WECOM_AIBOT_CMD_MSG_CALLBACK) {
      this.logger?.info(WECOM_LOG_MESSAGE_RECEIVED, {
        connector: this.connectorName,
        reqId: callbackFrame.headers.req_id,
      });
      Promise.resolve(this.onMessageCallback?.(callbackFrame)).catch((error) => {
        this.logger?.error(WECOM_LOG_MESSAGE_FAILED, {
          connector: this.connectorName,
          error: String(error),
        });
      });
      return;
    }

    if (cmd === WECOM_AIBOT_CMD_EVENT_CALLBACK) {
      const eventObj = isPlainRecord(body["event"]) ? body["event"] : undefined;
      if (eventObj?.["eventtype"] === WECOM_AIBOT_EVENT_DISCONNECTED) {
        this.kickedByNewConnection = true;
        this.logger?.warn(
          "WeCom Intelligent Bot WebSocket superseded by a newer connection (disconnected_event); auto-reconnect disabled.",
          { connector: this.connectorName },
        );
      }
      Promise.resolve(this.onEventCallback?.(callbackFrame)).catch((error) => {
        this.logger?.error("Failed handling WeCom aibot_event_callback frame", {
          connector: this.connectorName,
          error: String(error),
        });
      });
    }
  }

  private async sendCommandAndWaitAck(
    frame: Record<string, unknown>,
    reqId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.isConnected() || this.socket === undefined) {
      throw new ConnectorTransportError(
        `WeCom Intelligent Bot WebSocket is not connected (${this.connectorName}).`,
        { connectorName: this.connectorName, retryable: true },
      );
    }
    return this.sendFrameOnSocket(this.socket, frame, reqId, false, signal);
  }

  private sendFrameOnSocket(
    ws: WeComWebSocketLike,
    frame: Record<string, unknown>,
    reqId: string,
    treatNonZeroAsAuthError: boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) {
      return Promise.reject(
        new ConnectorTransportError("WeCom WebSocket request aborted before send.", {
          connectorName: this.connectorName,
          retryable: true,
          cause: signal.reason,
        }),
      );
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        cleanupAbort?.();
        reject(
          new ConnectorTransportError(
            `WeCom WebSocket request "${reqId}" timed out after ${this.requestTimeoutMs}ms.`,
            { connectorName: this.connectorName, retryable: true },
          ),
        );
      }, this.requestTimeoutMs);

      let cleanupAbort: (() => void) | undefined;
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.pendingRequests.delete(reqId);
          clearTimeout(timer);
          reject(
            new ConnectorTransportError("WeCom WebSocket request aborted.", {
              connectorName: this.connectorName,
              retryable: true,
              cause: signal.reason,
            }),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pendingRequests.set(reqId, {
        resolve,
        reject: (err) => {
          if (treatNonZeroAsAuthError && !(err instanceof ConnectorAuthError)) {
            reject(
              new ConnectorAuthError(err.message, {
                connectorName: this.connectorName,
                cause: err,
              }),
            );
            return;
          }
          reject(err);
        },
        timer,
        cleanupAbort,
      });

      try {
        ws.send(JSON.stringify(frame));
      } catch (error) {
        this.pendingRequests.delete(reqId);
        clearTimeout(timer);
        cleanupAbort?.();
        reject(
          new ConnectorTransportError(
            `Failed sending WeCom WebSocket frame: ${error instanceof Error ? error.message : String(error)}`,
            { connectorName: this.connectorName, retryable: true, cause: error },
          ),
        );
      }
    });
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [reqId, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(reqId);
      clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      pending.reject(error);
    }
  }
}
