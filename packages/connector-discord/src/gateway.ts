/**
 * Discord Gateway v10 WebSocket client (`Hello`, jittered `Heartbeat`, `Identify`,
 * `Resume` on `resume_gateway_url`, `Reconnect`, `Invalid Session`, and close-code classification).
 *
 * @see https://discord.com/developers/docs/events/gateway
 * @see https://discord.com/developers/docs/events/gateway#connection-lifecycle
 * @see https://discord.com/developers/docs/events/gateway#heartbeating
 * @see https://discord.com/developers/docs/events/gateway#resuming
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes
 */

import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  type ConnectorLogger,
} from "@dsh-connector/core";
import type { DiscordRestClient } from "./api";
import {
  DISCORD_API_VERSION_STRING,
  DISCORD_CHANNEL_CACHE_MAX_SIZE,
  DISCORD_CONNECTOR_DEFAULT_NAME,
  DISCORD_DEFAULT_INTENTS,
  DISCORD_FATAL_CLOSE_CODES,
  DISCORD_GATEWAY_CLOSE_CODES,
  DISCORD_GATEWAY_ENCODING_JSON,
  DISCORD_GATEWAY_EVENTS,
  DISCORD_GATEWAY_IDENTIFY_PROPERTIES,
  DISCORD_GATEWAY_OPCODES,
  DISCORD_GATEWAY_RECONNECT_DELAYS_MS,
  DISCORD_MIN_HEARTBEAT_INTERVAL_MS,
  DISCORD_SESSION_RESET_CLOSE_CODES,
  DISCORD_WSS_PROTOCOL,
  DISCORD_WS_NORMAL_CLOSE_CODE,
  DISCORD_WS_RESUMABLE_RESTART_CLOSE_CODE,
} from "./constants";
import type {
  CreateWebSocketFn,
  DiscordApiMessage,
  DiscordChannel,
  DiscordGatewayHelloData,
  DiscordGatewayPacket,
  DiscordGatewayReadyData,
  WebSocketLike,
} from "./types";

export interface DiscordGatewayDispatchContext {
  readonly botUserId: string | undefined;
  readonly applicationId: string | undefined;
  getCachedChannel(channelId: string): DiscordChannel | undefined;
  rememberChannel(channel: DiscordChannel): void;
}

export interface DiscordGatewayClientOptions {
  readonly connectorName?: string;
  readonly botToken: string;
  readonly api: DiscordRestClient;
  readonly intents?: number;
  readonly gatewayUrl?: string;
  readonly botUserId?: string;
  readonly shard?: readonly [number, number];
  readonly createWebSocket?: CreateWebSocketFn;
  readonly reconnectDelaysMs?: readonly number[];
  readonly randomFn?: () => number;
  readonly logger?: ConnectorLogger;
  readonly onMessageCreate: (
    message: DiscordApiMessage,
    context: DiscordGatewayDispatchContext,
  ) => Promise<void> | void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultCreateWebSocket(url: string): WebSocketLike {
  if (typeof globalThis.WebSocket !== "function") {
    throw new ConnectorTransportError(
      "Global WebSocket is unavailable; pass createWebSocket in DiscordConnectorOptions",
      { connectorName: DISCORD_CONNECTOR_DEFAULT_NAME, retryable: false },
    );
  }
  return new globalThis.WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Formats a Discord Gateway base URL into a v10 JSON WebSocket endpoint (`?v=10&encoding=json`).
 *
 * @see https://discord.com/developers/docs/events/gateway#connecting-gateway-url-query-string-params
 */
export function buildDiscordGatewayUrl(
  rawBaseUrl: string,
  connectorName: string = DISCORD_CONNECTOR_DEFAULT_NAME,
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl.trim());
  } catch (cause) {
    throw new ConnectorValidationError(`Invalid Discord Gateway URL: ${rawBaseUrl}`, {
      connectorName,
      cause,
    });
  }
  if (parsed.protocol !== DISCORD_WSS_PROTOCOL) {
    throw new ConnectorValidationError(
      `Discord Gateway URL must use wss:// protocol (received ${parsed.protocol})`,
      { connectorName },
    );
  }
  if (!parsed.pathname) {
    parsed.pathname = "/";
  }
  parsed.searchParams.set("v", DISCORD_API_VERSION_STRING);
  parsed.searchParams.set("encoding", DISCORD_GATEWAY_ENCODING_JSON);
  return parsed.toString();
}

/**
 * Stateful Discord Gateway v10 WebSocket session manager.
 *
 * @see https://discord.com/developers/docs/events/gateway
 */
export class DiscordGatewayClient {
  readonly #connectorName: string;
  readonly #botToken: string;
  readonly #api: DiscordRestClient;
  readonly #intents: number;
  readonly #configuredGatewayUrl: string | undefined;
  readonly #shard: readonly [number, number] | undefined;
  readonly #createWebSocket: CreateWebSocketFn;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #randomFn: () => number;
  readonly #logger: ConnectorLogger | undefined;
  readonly #onMessageCreate: DiscordGatewayClientOptions["onMessageCreate"];

  readonly #channelCache = new Map<string, DiscordChannel>();

  #initialGatewayUrl: string | null = null;
  #resumeGatewayUrl: string | null = null;
  #sessionId: string | null = null;
  #sequence: number | null = null;
  #botUserId: string | undefined;
  #applicationId: string | undefined;

  #ws: WebSocketLike | null = null;
  #heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatAcked = true;
  #reconnectAttempt = 0;
  #generation = 0;
  #running = false;

  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;

  constructor(options: DiscordGatewayClientOptions) {
    this.#connectorName = options.connectorName ?? DISCORD_CONNECTOR_DEFAULT_NAME;
    this.#botToken = options.botToken.trim();
    this.#api = options.api;
    this.#intents = options.intents ?? DISCORD_DEFAULT_INTENTS;
    this.#configuredGatewayUrl = options.gatewayUrl?.trim();
    this.#botUserId = options.botUserId?.trim() || undefined;
    this.#shard = options.shard;
    this.#createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
    this.#reconnectDelaysMs =
      options.reconnectDelaysMs && options.reconnectDelaysMs.length > 0
        ? options.reconnectDelaysMs
        : DISCORD_GATEWAY_RECONNECT_DELAYS_MS;
    this.#randomFn = options.randomFn ?? Math.random;
    this.#logger = options.logger;
    this.#onMessageCreate = options.onMessageCreate;
  }

  getBotUserId(): string | undefined {
    return this.#botUserId;
  }

  getApplicationId(): string | undefined {
    return this.#applicationId;
  }

  getCachedChannel(channelId: string): DiscordChannel | undefined {
    return this.#channelCache.get(channelId);
  }

  rememberChannel(channel: DiscordChannel): void {
    if (!channel.id) {
      return;
    }
    if (
      !this.#channelCache.has(channel.id) &&
      this.#channelCache.size >= DISCORD_CHANNEL_CACHE_MAX_SIZE
    ) {
      const oldestKey = this.#channelCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.#channelCache.delete(oldestKey);
      }
    }
    this.#channelCache.set(channel.id, channel);
  }

  /**
   * Opens the Gateway v10 WebSocket and resolves once the initial `READY` (or `RESUMED`)
   * dispatch has been received.
   */
  async start(): Promise<void> {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#generation += 1;
    const currentGen = this.#generation;

    try {
      if (!this.#initialGatewayUrl) {
        if (this.#configuredGatewayUrl) {
          this.#initialGatewayUrl = buildDiscordGatewayUrl(
            this.#configuredGatewayUrl,
            this.#connectorName,
          );
        } else {
          const gatewayInfo = await this.#api.getGatewayBot();
          this.#initialGatewayUrl = buildDiscordGatewayUrl(gatewayInfo.url, this.#connectorName);
        }
      }

      if (!this.#botUserId) {
        const me = await this.#api.getCurrentUser();
        this.#botUserId = me.id;
      }
    } catch (err) {
      this.#running = false;
      throw err;
    }

    if (!this.#running || currentGen !== this.#generation) {
      return;
    }

    return await new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
      this.#openSocket(currentGen);
    });
  }

  /**
   * Cleanly closes the Gateway WebSocket (`1000`) and cancels all heartbeat/reconnect timers.
   */
  async stop(): Promise<void> {
    this.#running = false;
    this.#generation += 1;
    this.#clearHeartbeatTimer();
    this.#clearReconnectTimer();

    const activeWs = this.#ws;
    this.#ws = null;
    if (activeWs) {
      try {
        activeWs.close(DISCORD_WS_NORMAL_CLOSE_CODE, "Connector stopped");
      } catch {
        // Ignore close errors during shutdown
      }
    }

    if (this.#readyReject) {
      const reject = this.#readyReject;
      this.#readyResolve = null;
      this.#readyReject = null;
      reject(
        new ConnectorTransportError("Discord Gateway stopped before READY", {
          connectorName: this.#connectorName,
          retryable: false,
        }),
      );
    }
  }

  #openSocket(expectedGen: number): void {
    if (!this.#running || expectedGen !== this.#generation || !this.#initialGatewayUrl) {
      return;
    }

    const targetUrl =
      this.#sessionId && this.#resumeGatewayUrl ? this.#resumeGatewayUrl : this.#initialGatewayUrl;

    let ws: WebSocketLike;
    try {
      ws = this.#createWebSocket(targetUrl);
    } catch (cause) {
      this.#failOrScheduleReconnect(
        expectedGen,
        new ConnectorTransportError(
          `Failed to create Discord Gateway WebSocket: ${cause instanceof Error ? cause.message : String(cause)}`,
          { connectorName: this.#connectorName, retryable: true, cause },
        ),
      );
      return;
    }

    this.#ws = ws;
    this.#heartbeatAcked = true;

    ws.addEventListener("open", () => {
      if (!this.#running || expectedGen !== this.#generation || this.#ws !== ws) {
        return;
      }
      this.#logger?.debug("Discord Gateway WebSocket opened", { url: targetUrl });
    });

    ws.addEventListener("message", (event) => {
      if (!this.#running || expectedGen !== this.#generation || this.#ws !== ws) {
        return;
      }
      this.#handleRawFrame(ws, expectedGen, event.data);
    });

    ws.addEventListener("error", (event) => {
      if (!this.#running || expectedGen !== this.#generation || this.#ws !== ws) {
        return;
      }
      this.#logger?.warn("Discord Gateway WebSocket error event", {
        message: event.message ?? (event.error instanceof Error ? event.error.message : "unknown"),
      });
    });

    ws.addEventListener("close", (event) => {
      if (this.#ws === ws) {
        this.#ws = null;
      }
      this.#clearHeartbeatTimer();
      if (!this.#running || expectedGen !== this.#generation) {
        return;
      }
      this.#handleSocketClose(expectedGen, event.code ?? 1006, event.reason ?? "");
    });
  }

  #handleRawFrame(ws: WebSocketLike, expectedGen: number, rawData: unknown): void {
    let text: string;
    if (typeof rawData === "string") {
      text = rawData;
    } else if (rawData instanceof Uint8Array) {
      text = new TextDecoder().decode(rawData);
    } else if (rawData instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(rawData));
    } else {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#logger?.warn("Ignored malformed JSON frame from Discord Gateway");
      return;
    }

    if (!isPlainRecord(parsed) || typeof parsed["op"] !== "number") {
      return;
    }

    const packet = parsed as unknown as DiscordGatewayPacket;
    switch (packet.op) {
      case DISCORD_GATEWAY_OPCODES.HELLO: {
        this.#handleHello(ws, expectedGen, packet.d);
        break;
      }
      case DISCORD_GATEWAY_OPCODES.HEARTBEAT: {
        this.#sendHeartbeat(ws);
        break;
      }
      case DISCORD_GATEWAY_OPCODES.HEARTBEAT_ACK: {
        this.#heartbeatAcked = true;
        break;
      }
      case DISCORD_GATEWAY_OPCODES.RECONNECT: {
        this.#logger?.info("Discord Gateway requested RECONNECT (op 7)");
        ws.close(DISCORD_WS_RESUMABLE_RESTART_CLOSE_CODE, "Gateway op 7 reconnect");
        break;
      }
      case DISCORD_GATEWAY_OPCODES.INVALID_SESSION: {
        const canResume = packet.d === true;
        this.#logger?.warn("Discord Gateway sent INVALID_SESSION (op 9)", { canResume });
        if (!canResume) {
          this.#resetSessionState();
        }
        ws.close(DISCORD_WS_RESUMABLE_RESTART_CLOSE_CODE, "Gateway op 9 invalid session");
        break;
      }
      case DISCORD_GATEWAY_OPCODES.DISPATCH: {
        if (typeof packet.s === "number" && Number.isInteger(packet.s)) {
          this.#sequence = packet.s;
        }
        if (typeof packet.t === "string") {
          this.#handleDispatch(packet.t, packet.d);
        }
        break;
      }
      default:
        break;
    }
  }

  #handleHello(ws: WebSocketLike, expectedGen: number, data: unknown): void {
    if (!isPlainRecord(data) || typeof data["heartbeat_interval"] !== "number") {
      ws.close(DISCORD_WS_RESUMABLE_RESTART_CLOSE_CODE, "Malformed HELLO payload");
      return;
    }
    const hello = data as unknown as DiscordGatewayHelloData;
    const intervalMs = Math.max(DISCORD_MIN_HEARTBEAT_INTERVAL_MS, hello.heartbeat_interval);

    this.#scheduleHeartbeatLoop(ws, expectedGen, intervalMs, true);

    if (this.#sessionId) {
      this.#sendPacket(ws, {
        op: DISCORD_GATEWAY_OPCODES.RESUME,
        d: {
          token: this.#botToken,
          session_id: this.#sessionId,
          seq: this.#sequence ?? 0,
        },
      });
    } else {
      this.#sendPacket(ws, {
        op: DISCORD_GATEWAY_OPCODES.IDENTIFY,
        d: {
          token: this.#botToken,
          intents: this.#intents,
          properties: DISCORD_GATEWAY_IDENTIFY_PROPERTIES,
          ...(this.#shard ? { shard: this.#shard } : {}),
        },
      });
    }
  }

  #scheduleHeartbeatLoop(
    ws: WebSocketLike,
    expectedGen: number,
    intervalMs: number,
    initialJitter: boolean,
  ): void {
    this.#clearHeartbeatTimer();
    const delay = initialJitter
      ? Math.max(1, Math.floor(intervalMs * Math.min(1, Math.max(0, this.#randomFn()))))
      : intervalMs;

    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = null;
      if (!this.#running || expectedGen !== this.#generation || this.#ws !== ws) {
        return;
      }
      if (!this.#heartbeatAcked) {
        this.#logger?.warn("Discord Gateway heartbeat ACK timeout; closing zombie socket");
        ws.close(DISCORD_WS_RESUMABLE_RESTART_CLOSE_CODE, "Heartbeat ACK timeout");
        return;
      }
      this.#sendHeartbeat(ws);
      this.#scheduleHeartbeatLoop(ws, expectedGen, intervalMs, false);
    }, delay);
  }

  #sendHeartbeat(ws: WebSocketLike): void {
    this.#heartbeatAcked = false;
    this.#sendPacket(ws, {
      op: DISCORD_GATEWAY_OPCODES.HEARTBEAT,
      d: this.#sequence,
    });
  }

  #sendPacket(ws: WebSocketLike, packet: DiscordGatewayPacket): void {
    try {
      ws.send(JSON.stringify(packet));
    } catch (err) {
      this.#logger?.warn("Failed to send packet to Discord Gateway", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #handleDispatch(eventName: string, data: unknown): void {
    switch (eventName) {
      case DISCORD_GATEWAY_EVENTS.READY: {
        if (isPlainRecord(data)) {
          const ready = data as unknown as DiscordGatewayReadyData;
          if (typeof ready.session_id === "string" && ready.session_id) {
            this.#sessionId = ready.session_id;
          }
          if (typeof ready.resume_gateway_url === "string" && ready.resume_gateway_url) {
            this.#resumeGatewayUrl = buildDiscordGatewayUrl(
              ready.resume_gateway_url,
              this.#connectorName,
            );
          }
          if (ready.user?.id) {
            this.#botUserId = ready.user.id;
          }
          if (ready.application?.id) {
            this.#applicationId = ready.application.id;
          }
        }
        this.#reconnectAttempt = 0;
        this.#resolveReady();
        break;
      }
      case DISCORD_GATEWAY_EVENTS.RESUMED: {
        this.#reconnectAttempt = 0;
        this.#resolveReady();
        break;
      }
      case DISCORD_GATEWAY_EVENTS.GUILD_CREATE: {
        if (isPlainRecord(data)) {
          const channels = data["channels"];
          if (Array.isArray(channels)) {
            for (const ch of channels) {
              if (
                isPlainRecord(ch) &&
                typeof ch["id"] === "string" &&
                typeof ch["type"] === "number"
              ) {
                this.rememberChannel(ch as unknown as DiscordChannel);
              }
            }
          }
          const threads = data["threads"];
          if (Array.isArray(threads)) {
            for (const th of threads) {
              if (
                isPlainRecord(th) &&
                typeof th["id"] === "string" &&
                typeof th["type"] === "number"
              ) {
                this.rememberChannel(th as unknown as DiscordChannel);
              }
            }
          }
        }
        break;
      }
      case DISCORD_GATEWAY_EVENTS.CHANNEL_CREATE:
      case DISCORD_GATEWAY_EVENTS.CHANNEL_UPDATE:
      case DISCORD_GATEWAY_EVENTS.THREAD_CREATE:
      case DISCORD_GATEWAY_EVENTS.THREAD_UPDATE: {
        if (
          isPlainRecord(data) &&
          typeof data["id"] === "string" &&
          typeof data["type"] === "number"
        ) {
          this.rememberChannel(data as unknown as DiscordChannel);
        }
        break;
      }
      case DISCORD_GATEWAY_EVENTS.THREAD_LIST_SYNC: {
        if (isPlainRecord(data) && Array.isArray(data["threads"])) {
          for (const th of data["threads"]) {
            if (
              isPlainRecord(th) &&
              typeof th["id"] === "string" &&
              typeof th["type"] === "number"
            ) {
              this.rememberChannel(th as unknown as DiscordChannel);
            }
          }
        }
        break;
      }
      case DISCORD_GATEWAY_EVENTS.CHANNEL_DELETE:
      case DISCORD_GATEWAY_EVENTS.THREAD_DELETE: {
        if (isPlainRecord(data) && typeof data["id"] === "string") {
          this.#channelCache.delete(data["id"]);
        }
        break;
      }
      case DISCORD_GATEWAY_EVENTS.MESSAGE_CREATE: {
        if (
          isPlainRecord(data) &&
          typeof data["id"] === "string" &&
          typeof data["channel_id"] === "string"
        ) {
          const message = data as unknown as DiscordApiMessage;
          const dispatchCtx: DiscordGatewayDispatchContext = {
            botUserId: this.#botUserId,
            applicationId: this.#applicationId,
            getCachedChannel: (channelId) => this.getCachedChannel(channelId),
            rememberChannel: (channel) => this.rememberChannel(channel),
          };
          void Promise.resolve(this.#onMessageCreate(message, dispatchCtx)).catch(
            (err: unknown) => {
              this.#logger?.error("Unhandled error processing Discord MESSAGE_CREATE", {
                messageId: message.id,
                error: err instanceof Error ? err.message : String(err),
              });
            },
          );
        }
        break;
      }
      default:
        break;
    }
  }

  #handleSocketClose(expectedGen: number, code: number, reason: string): void {
    if (code === DISCORD_GATEWAY_CLOSE_CODES.AUTHENTICATION_FAILED) {
      this.#running = false;
      this.#resetSessionState();
      const authError = new ConnectorAuthError(
        `Discord Gateway authentication failed (close code 4004)${reason ? `: ${reason}` : ""}`,
        { connectorName: this.#connectorName },
      );
      this.#rejectReadyOrLog(authError);
      return;
    }

    if (DISCORD_FATAL_CLOSE_CODES.has(code)) {
      this.#running = false;
      this.#resetSessionState();
      const fatalError = new ConnectorTransportError(
        `Discord Gateway closed with fatal non-recoverable code ${code}${reason ? `: ${reason}` : ""}`,
        { connectorName: this.#connectorName, statusCode: code, retryable: false },
      );
      this.#rejectReadyOrLog(fatalError);
      return;
    }

    if (DISCORD_SESSION_RESET_CLOSE_CODES.has(code)) {
      this.#resetSessionState();
    }

    this.#scheduleReconnect(expectedGen);
  }

  #failOrScheduleReconnect(expectedGen: number, error: Error): void {
    this.#logger?.warn("Discord Gateway connection attempt failed; scheduling reconnect", {
      error: error.message,
    });
    this.#scheduleReconnect(expectedGen);
  }

  #scheduleReconnect(expectedGen: number): void {
    if (!this.#running || expectedGen !== this.#generation) {
      return;
    }
    this.#clearReconnectTimer();
    const index = Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1);
    const delayMs = this.#reconnectDelaysMs[index] ?? 1_000;
    this.#reconnectAttempt += 1;

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#running || expectedGen !== this.#generation) {
        return;
      }
      this.#openSocket(expectedGen);
    }, delayMs);
  }

  #resolveReady(): void {
    if (this.#readyResolve) {
      const resolve = this.#readyResolve;
      this.#readyResolve = null;
      this.#readyReject = null;
      resolve();
    }
  }

  #rejectReadyOrLog(error: Error): void {
    if (this.#readyReject) {
      const reject = this.#readyReject;
      this.#readyResolve = null;
      this.#readyReject = null;
      reject(error);
    } else {
      this.#logger?.error("Fatal Discord Gateway session termination", {
        error: error.message,
      });
    }
  }

  #resetSessionState(): void {
    this.#sessionId = null;
    this.#resumeGatewayUrl = null;
    this.#sequence = null;
  }

  #clearHeartbeatTimer(): void {
    if (this.#heartbeatTimer !== null) {
      clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }
}
