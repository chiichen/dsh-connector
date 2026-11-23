import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
  createConnectorContext,
  extractContextMarker,
  type ConnectorContext,
  type ConnectorInboundPrompt,
  type ConnectorLogger,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@dsh-connector/core";
import { verifyDingTalkWebhookSignature } from "./auth";
import {
  DINGTALK_API_BASE_URL,
  DINGTALK_CONVERSATION_GROUP,
  DINGTALK_CONVERSATION_SINGLE,
  DINGTALK_DEFAULT_HTTP_TIMEOUT_MS,
  DINGTALK_DEFAULT_RECONNECT_INITIAL_DELAY_MS,
  DINGTALK_DEFAULT_RECONNECT_MAX_DELAY_MS,
  DINGTALK_DEFAULT_SESSION_WEBHOOK_TTL_MS,
  DINGTALK_DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
  DINGTALK_GATEWAY_OPEN_PATH,
  DINGTALK_RECONNECT_BACKOFF_FACTOR,
  DINGTALK_STREAM_ACK_MESSAGE_OK,
  DINGTALK_STREAM_ACK_STATUS_OK,
  DINGTALK_STREAM_CONNECT_PATH,
  DINGTALK_STREAM_CONTENT_TYPE_JSON,
  DINGTALK_STREAM_EVENT_STATUS_LATER,
  DINGTALK_STREAM_EVENT_STATUS_SUCCESS,
  DINGTALK_STREAM_FRAME_CALLBACK,
  DINGTALK_STREAM_FRAME_EVENT,
  DINGTALK_STREAM_FRAME_SYSTEM,
  DINGTALK_STREAM_SUBSCRIPTION_CALLBACK,
  DINGTALK_STREAM_SYSTEM_DISCONNECT,
  DINGTALK_STREAM_SYSTEM_PING,
  DINGTALK_STREAM_TICKET_PARAM,
  DINGTALK_STREAM_TOPIC_ROBOT,
  DINGTALK_STREAM_USER_AGENT,
  DINGTALK_WEBHOOK_MAX_SKEW_MS,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
} from "./constants";
import {
  extractProviderErrorDetail,
  isRetryableHttpStatus,
  requestDingTalkJson,
  type SessionWebhookCache,
} from "./http";
import {
  dingTalkReceiveSchema,
  formatDingTalkEncryptedP2PContextId,
  formatDingTalkGroupContextId,
  formatDingTalkP2PContextId,
  type DingTalkCloseEventLike,
  type DingTalkCreateWebSocketFn,
  type DingTalkInboundMessage,
  type DingTalkMessageEventLike,
  type DingTalkRobotCallbackPayload,
  type DingTalkStreamSubscription,
  type DingTalkWebSocketLike,
} from "./types";

const WS_CLOSE_NORMAL = 1000 as const;
const HTTP_METHOD_POST = "POST" as const;

const NOOP_LOGGER: ConnectorLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
  }
  return undefined;
}

function parseMessageContentObject(
  content: DingTalkRobotCallbackPayload["content"],
): Record<string, unknown> | undefined {
  if (isPlainRecord(content)) {
    return content;
  }
  if (typeof content === "string" && content.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(content);
      return isPlainRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractRichTextBody(contentObj: Record<string, unknown> | undefined): string {
  const rawList = contentObj?.["richText"];
  if (!Array.isArray(rawList)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of rawList) {
    if (!isPlainRecord(item)) continue;
    const directText = nonEmptyTrimmed(item["text"]);
    if (directText !== undefined) {
      parts.push(directText);
      continue;
    }
    const nestedTextObj = item["text"];
    if (isPlainRecord(nestedTextObj)) {
      const nestedContent = nonEmptyTrimmed(nestedTextObj["content"]);
      if (nestedContent !== undefined) {
        parts.push(nestedContent);
        continue;
      }
    }
    const itemContent = nonEmptyTrimmed(item["content"]);
    if (itemContent !== undefined) {
      parts.push(itemContent);
      continue;
    }
    if (
      String(item["type"] ?? "").toLowerCase() === "picture" ||
      nonEmptyTrimmed(item["downloadCode"]) !== undefined ||
      nonEmptyTrimmed(item["pictureDownloadCode"]) !== undefined
    ) {
      parts.push("[picture]");
    }
  }
  return parts.join("\n").trim();
}

function extractInboundMainText(payload: DingTalkRobotCallbackPayload): string {
  const msgtype = (payload.msgtype ?? "text").trim().toLowerCase();
  if (msgtype === "text") {
    return payload.text?.content?.trim() ?? "";
  }

  const contentObj = parseMessageContentObject(payload.content);
  if (msgtype === "richtext") {
    return extractRichTextBody(contentObj);
  }
  if (msgtype === "audio" || msgtype === "voice") {
    return nonEmptyTrimmed(contentObj?.["recognition"]) ?? "";
  }
  if (msgtype === "picture") {
    return nonEmptyTrimmed(contentObj?.["downloadCode"]) !== undefined ? "[picture]" : "";
  }
  if (msgtype === "file") {
    const fileName = nonEmptyTrimmed(contentObj?.["fileName"]);
    return fileName !== undefined ? `[file: ${fileName}]` : "[file]";
  }
  if (msgtype === "video") {
    return "[video]";
  }
  return payload.text?.content?.trim() ?? "";
}

function extractQuotedText(payload: DingTalkRobotCallbackPayload): string | undefined {
  if (payload.text?.isReplyMsg !== true || payload.text.repliedMsg === undefined) {
    return undefined;
  }
  const rawContent = payload.text.repliedMsg.content;
  if (typeof rawContent === "string") {
    const trimmed = rawContent.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainRecord(parsed)) {
          const innerText = nonEmptyTrimmed(parsed["text"]) ?? nonEmptyTrimmed(parsed["content"]);
          if (innerText !== undefined) return innerText;
        }
      } catch {
        // Fall through to raw string
      }
    }
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isPlainRecord(rawContent)) {
    return nonEmptyTrimmed(rawContent["text"]) ?? nonEmptyTrimmed(rawContent["content"]);
  }
  return undefined;
}

/**
 * Builds the DingTalk Stream WebSocket connection URL from the `endpoint` and one-time `ticket`
 * returned by `POST /v1.0/gateway/connections/open`.
 *
 * @see https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
 */
export function buildDingTalkStreamWebSocketUrl(endpoint: string, ticket: string): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch (cause) {
    throw new ConnectorValidationError(`Invalid DingTalk Stream endpoint URL "${endpoint}".`, {
      cause,
    });
  }
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = DINGTALK_STREAM_CONNECT_PATH;
  }
  url.searchParams.set(DINGTALK_STREAM_TICKET_PARAM, ticket.trim());
  return url.toString();
}

interface DingTalkStreamDownlinkFrame {
  readonly specVersion?: string;
  readonly type: string;
  readonly headers: {
    readonly topic?: string;
    readonly messageId?: string;
    readonly contentType?: string;
    readonly time?: string | number;
    readonly eventId?: string;
  };
  readonly data?: string;
}

function buildStreamAckFrame(messageId: string, dataObject: Record<string, unknown>): string {
  return JSON.stringify({
    code: DINGTALK_STREAM_ACK_STATUS_OK,
    headers: {
      contentType: DINGTALK_STREAM_CONTENT_TYPE_JSON,
      messageId,
    },
    message: DINGTALK_STREAM_ACK_MESSAGE_OK,
    data: JSON.stringify(dataObject),
  });
}

function defaultCreateWebSocket(url: string): DingTalkWebSocketLike {
  return new globalThis.WebSocket(url) as unknown as DingTalkWebSocketLike;
}

export interface DingTalkReceiverOptions<TName extends string = string> {
  readonly connectorName: TName;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly webhookSigningSecret?: string;
  readonly outgoingToken?: string;
  readonly maxWebhookSkewMs?: number;
  readonly webhookCache?: SessionWebhookCache;
  readonly botUserIds?: readonly string[];
  readonly botStaffIds?: readonly string[];
  readonly requireAtInGroup?: boolean;
  readonly streamSubscriptions?: readonly DingTalkStreamSubscription[];
  readonly streamUserAgent?: string;
  readonly localIp?: string;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly autoReconnect?: boolean;
  readonly apiBaseUrl?: string;
  readonly httpTimeoutMs?: number;
  readonly wsHandshakeTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly createWebSocket?: DingTalkCreateWebSocketFn;
  readonly now?: () => number;
  readonly logger?: ConnectorLogger;
}

/**
 * Inbound DingTalk receiver supporting both:
 * 1. HTTP Outgoing Robot Webhook (`timestamp` + `sign` HMAC-SHA256 verification or Custom Robot `token`).
 * 2. Stream Mode WebSocket (`POST /v1.0/gateway/connections/open` + `GET /connect?ticket=...` + `SYSTEM` / `CALLBACK` / `EVENT` ACKs).
 *
 * @see https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 */
export class DingTalkReceiver<TName extends string = string> implements ConnectorReceiver<
  typeof dingTalkReceiveSchema,
  TName
> {
  readonly schema = dingTalkReceiveSchema;

  private readonly connectorName: TName;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly webhookSigningSecret: string | undefined;
  private readonly outgoingToken: string | undefined;
  private readonly maxWebhookSkewMs: number;
  private readonly webhookCache: SessionWebhookCache | undefined;
  private readonly botUserIds: ReadonlySet<string>;
  private readonly botStaffIds: ReadonlySet<string>;
  private readonly requireAtInGroup: boolean;
  private readonly streamSubscriptions: readonly DingTalkStreamSubscription[];
  private readonly streamUserAgent: string;
  private readonly localIp: string | undefined;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly autoReconnect: boolean;
  private readonly gatewayOpenUrl: string;
  private readonly httpTimeoutMs: number;
  private readonly wsHandshakeTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: DingTalkCreateWebSocketFn;
  private readonly now: () => number;
  private logger: ConnectorLogger;

  private receiverCtx?: ConnectorReceiverContext<typeof dingTalkReceiveSchema, TName>;
  private streamRunning = false;
  private streamAbort?: AbortController;
  private activeSocket?: DingTalkWebSocketLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private currentReconnectDelayMs: number;
  private readonly inFlightCallbacks = new Set<Promise<void>>();

  constructor(options: DingTalkReceiverOptions<TName>) {
    this.connectorName = options.connectorName;
    this.clientId = nonEmptyTrimmed(options.clientId);
    this.clientSecret = nonEmptyTrimmed(options.clientSecret);
    this.webhookSigningSecret = nonEmptyTrimmed(options.webhookSigningSecret) ?? this.clientSecret;
    this.outgoingToken = nonEmptyTrimmed(options.outgoingToken);
    this.maxWebhookSkewMs = options.maxWebhookSkewMs ?? DINGTALK_WEBHOOK_MAX_SKEW_MS;
    this.webhookCache = options.webhookCache;
    this.botUserIds = new Set(
      (options.botUserIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
    );
    this.botStaffIds = new Set(
      (options.botStaffIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
    );
    this.requireAtInGroup = options.requireAtInGroup ?? false;

    const mergedSubs: DingTalkStreamSubscription[] = [
      {
        type: DINGTALK_STREAM_SUBSCRIPTION_CALLBACK,
        topic: DINGTALK_STREAM_TOPIC_ROBOT,
      },
    ];
    for (const sub of options.streamSubscriptions ?? []) {
      const exists = mergedSubs.some((s) => s.type === sub.type && s.topic === sub.topic);
      if (!exists) {
        mergedSubs.push(sub);
      }
    }
    this.streamSubscriptions = mergedSubs;
    this.streamUserAgent = options.streamUserAgent ?? DINGTALK_STREAM_USER_AGENT;
    this.localIp = nonEmptyTrimmed(options.localIp);
    this.reconnectInitialDelayMs =
      options.reconnectInitialDelayMs ?? DINGTALK_DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    this.reconnectMaxDelayMs =
      options.reconnectMaxDelayMs ?? DINGTALK_DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.autoReconnect = options.autoReconnect ?? true;
    this.currentReconnectDelayMs = this.reconnectInitialDelayMs;

    const apiBase = (options.apiBaseUrl ?? DINGTALK_API_BASE_URL).replace(/\/+$/, "");
    this.gatewayOpenUrl = `${apiBase}${DINGTALK_GATEWAY_OPEN_PATH}`;
    this.httpTimeoutMs = options.httpTimeoutMs ?? DINGTALK_DEFAULT_HTTP_TIMEOUT_MS;
    this.wsHandshakeTimeoutMs =
      options.wsHandshakeTimeoutMs ?? DINGTALK_DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  init(ctx: ConnectorReceiverContext<typeof dingTalkReceiveSchema, TName>): void {
    this.receiverCtx = ctx;
    this.logger = ctx.logger;
  }

  formatInbound(
    params: DingTalkInboundMessage,
    _context: ConnectorContext<TName>,
  ): ConnectorInboundPrompt {
    const speaker = params.senderNick ?? params.senderStaffId ?? params.senderId;
    const isGroup = params.conversationType === DINGTALK_CONVERSATION_GROUP;
    const chatLabel = params.conversationTitle ?? params.conversationId;
    const title = isGroup ? `[DingTalk] ${chatLabel}` : `[DingTalk] ${speaker}`;

    const lines: string[] = [];
    if (params.quotedText !== undefined && params.quotedText.length > 0) {
      for (const qLine of params.quotedText.split(/\r?\n/)) {
        lines.push(`> ${qLine}`);
      }
    }
    if (isGroup) {
      lines.push(`[${chatLabel}] ${speaker}: ${params.text}`);
    } else {
      lines.push(
        params.senderNick !== undefined ? `${params.senderNick}: ${params.text}` : params.text,
      );
    }

    return {
      title,
      text: lines.join("\n"),
    };
  }

  async handleWebhook(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse> {
    if (req.method.toUpperCase() !== HTTP_METHOD_POST) {
      return {
        status: HTTP_STATUS_METHOD_NOT_ALLOWED,
        headers: { "content-type": DINGTALK_STREAM_CONTENT_TYPE_JSON },
        body: JSON.stringify({ error: "Method Not Allowed" }),
      };
    }

    const verification = verifyDingTalkWebhookSignature(req.headers, {
      ...(this.webhookSigningSecret !== undefined
        ? { signingSecret: this.webhookSigningSecret }
        : {}),
      ...(this.outgoingToken !== undefined ? { outgoingToken: this.outgoingToken } : {}),
      maxSkewMs: this.maxWebhookSkewMs,
      nowMs: this.now(),
    });

    if (!verification.ok) {
      return {
        status: HTTP_STATUS_UNAUTHORIZED,
        headers: { "content-type": DINGTALK_STREAM_CONTENT_TYPE_JSON },
        body: JSON.stringify({ error: "Unauthorized", reason: verification.reason }),
      };
    }

    let payload: DingTalkRobotCallbackPayload;
    try {
      const text = new TextDecoder().decode(req.rawBody);
      const parsed: unknown = JSON.parse(text);
      if (!isPlainRecord(parsed)) {
        return {
          status: HTTP_STATUS_BAD_REQUEST,
          headers: { "content-type": DINGTALK_STREAM_CONTENT_TYPE_JSON },
          body: JSON.stringify({ error: "Payload must be a JSON object" }),
        };
      }
      payload = parsed as DingTalkRobotCallbackPayload;
    } catch {
      return {
        status: HTTP_STATUS_BAD_REQUEST,
        headers: { "content-type": DINGTALK_STREAM_CONTENT_TYPE_JSON },
        body: JSON.stringify({ error: "Invalid JSON payload" }),
      };
    }

    const outcome = await this.ingestRobotPayload(payload);
    if (outcome === undefined) {
      return {
        status: HTTP_STATUS_OK,
        headers: { "content-type": DINGTALK_STREAM_CONTENT_TYPE_JSON },
        body: JSON.stringify({ ok: true, ignored: true }),
      };
    }

    return {
      status: HTTP_STATUS_OK,
      headers: { "content-type": DINGTALK_STREAM_CONTENT_TYPE_JSON },
      body: JSON.stringify({
        ok: true,
        sessionId: outcome.sessionId,
        deduplicated: outcome.deduplicated ?? false,
      }),
    };
  }

  async startStream(): Promise<void> {
    if (this.streamRunning) {
      return;
    }
    if (this.clientId === undefined || this.clientSecret === undefined) {
      throw new ConnectorAuthError(
        `Connector "${this.connectorName}" requires "clientId" and "clientSecret" to start DingTalk Stream mode.`,
        { connectorName: this.connectorName },
      );
    }

    this.streamRunning = true;
    this.streamAbort = new AbortController();
    this.currentReconnectDelayMs = this.reconnectInitialDelayMs;

    try {
      await this.openAndConnectOnce(this.streamAbort.signal);
    } catch (error) {
      this.streamRunning = false;
      this.streamAbort.abort();
      this.streamAbort = undefined;
      throw error;
    }
  }

  async stopStream(): Promise<void> {
    this.streamRunning = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.streamAbort?.abort();
    this.streamAbort = undefined;

    const sock = this.activeSocket;
    this.activeSocket = undefined;
    if (sock !== undefined) {
      try {
        sock.close(WS_CLOSE_NORMAL, "stopped");
      } catch {
        // Ignore close errors during teardown
      }
    }

    if (this.inFlightCallbacks.size > 0) {
      await Promise.allSettled(this.inFlightCallbacks);
      this.inFlightCallbacks.clear();
    }
  }

  private async openAndConnectOnce(signal: AbortSignal): Promise<void> {
    const result = await requestDingTalkJson({
      connectorName: this.connectorName,
      fetchFn: this.fetchFn,
      url: this.gatewayOpenUrl,
      method: "POST",
      body: {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions: this.streamSubscriptions,
        ua: this.streamUserAgent,
        ...(this.localIp !== undefined ? { localIp: this.localIp } : {}),
      },
      timeoutMs: this.httpTimeoutMs,
      signal,
    });

    if (!result.ok) {
      const detail = extractProviderErrorDetail(result.data);
      if (
        result.status === HTTP_STATUS_BAD_REQUEST ||
        result.status === HTTP_STATUS_UNAUTHORIZED ||
        result.status === HTTP_STATUS_FORBIDDEN
      ) {
        throw new ConnectorAuthError(
          `DingTalk Stream gateway/connections/open rejected credentials (HTTP ${result.status}${detail !== undefined ? ` - ${detail}` : ""}).`,
          { connectorName: this.connectorName },
        );
      }
      throw new ConnectorTransportError(
        `DingTalk Stream gateway/connections/open failed (HTTP ${result.status}${detail !== undefined ? ` - ${detail}` : ""}).`,
        {
          connectorName: this.connectorName,
          statusCode: result.status,
          retryable: isRetryableHttpStatus(result.status),
        },
      );
    }

    const endpoint = nonEmptyTrimmed(result.data["endpoint"]);
    const ticket = nonEmptyTrimmed(result.data["ticket"]);
    if (endpoint === undefined || ticket === undefined) {
      throw new ConnectorTransportError(
        "DingTalk Stream gateway/connections/open response missing endpoint or ticket.",
        {
          connectorName: this.connectorName,
          retryable: false,
        },
      );
    }

    const wsUrl = buildDingTalkStreamWebSocketUrl(endpoint, ticket);
    const socket = this.createWebSocket(wsUrl);
    await this.waitForSocketOpen(socket, signal);

    if (!this.streamRunning || signal.aborted) {
      socket.close(WS_CLOSE_NORMAL, "aborted");
      return;
    }

    this.activeSocket = socket;
    this.currentReconnectDelayMs = this.reconnectInitialDelayMs;
    this.attachSocketRuntimeListeners(socket, signal);
  }

  private waitForSocketOpen(socket: DingTalkWebSocketLike, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore
        }
        reject(
          new ConnectorTransportError(
            `DingTalk Stream WebSocket handshake timed out after ${this.wsHandshakeTimeoutMs}ms.`,
            {
              connectorName: this.connectorName,
              retryable: true,
            },
          ),
        );
      }, this.wsHandshakeTimeoutMs);

      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(
          new ConnectorTransportError(
            "DingTalk Stream WebSocket connection error during handshake.",
            {
              connectorName: this.connectorName,
              retryable: true,
            },
          ),
        );
      };
      const onClose = (event: DingTalkCloseEventLike): void => {
        cleanup();
        reject(
          new ConnectorTransportError(
            `DingTalk Stream WebSocket closed during handshake (code ${event.code ?? 0}).`,
            {
              connectorName: this.connectorName,
              retryable: true,
            },
          ),
        );
      };
      const onAbort = (): void => {
        cleanup();
        try {
          socket.close(WS_CLOSE_NORMAL, "aborted");
        } catch {
          // Ignore
        }
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new ConnectorTransportError("DingTalk Stream WebSocket connect aborted.", {
                connectorName: this.connectorName,
                retryable: false,
              }),
        );
      };

      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private attachSocketRuntimeListeners(socket: DingTalkWebSocketLike, signal: AbortSignal): void {
    let serverRequestedDisconnect = false;

    const onMessage = (event: DingTalkMessageEventLike): void => {
      if (this.activeSocket !== socket || !this.streamRunning) return;
      const rawText =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof Uint8Array
            ? new TextDecoder().decode(event.data)
            : String(event.data ?? "");
      this.handleStreamFrame(socket, rawText, () => {
        serverRequestedDisconnect = true;
      });
    };

    const onClose = (): void => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);

      if (this.activeSocket === socket) {
        this.activeSocket = undefined;
      }
      if (!this.streamRunning || signal.aborted || !this.autoReconnect) {
        return;
      }
      this.scheduleReconnect(signal, serverRequestedDisconnect ? 0 : this.currentReconnectDelayMs);
      if (!serverRequestedDisconnect) {
        this.currentReconnectDelayMs = Math.min(
          this.reconnectMaxDelayMs,
          this.currentReconnectDelayMs * DINGTALK_RECONNECT_BACKOFF_FACTOR,
        );
      }
    };

    const onError = (): void => {
      this.logger.warn("DingTalk Stream WebSocket error observed", {
        connectorName: this.connectorName,
      });
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  }

  private scheduleReconnect(signal: AbortSignal, delayMs: number): void {
    if (this.reconnectTimer !== undefined || !this.streamRunning || signal.aborted) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.streamRunning || signal.aborted) return;
      void this.openAndConnectOnce(signal).catch((error: unknown) => {
        if (!this.streamRunning || signal.aborted) return;
        this.logger.warn("DingTalk Stream reconnect attempt failed", {
          connectorName: this.connectorName,
          error: error instanceof Error ? error.message : String(error),
        });
        const nextDelay = this.currentReconnectDelayMs;
        this.currentReconnectDelayMs = Math.min(
          this.reconnectMaxDelayMs,
          this.currentReconnectDelayMs * DINGTALK_RECONNECT_BACKOFF_FACTOR,
        );
        this.scheduleReconnect(signal, nextDelay);
      });
    }, delayMs);
  }

  private handleStreamFrame(
    socket: DingTalkWebSocketLike,
    rawText: string,
    markDisconnect: () => void,
  ): void {
    let frame: DingTalkStreamDownlinkFrame;
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!isPlainRecord(parsed) || !isPlainRecord(parsed["headers"])) {
        return;
      }
      frame = parsed as unknown as DingTalkStreamDownlinkFrame;
    } catch {
      this.logger.warn("Ignored malformed DingTalk Stream JSON frame", {
        connectorName: this.connectorName,
      });
      return;
    }

    const frameType = frame.type;
    const topic = nonEmptyTrimmed(frame.headers.topic);
    const messageId = nonEmptyTrimmed(frame.headers.messageId);

    if (frameType === DINGTALK_STREAM_FRAME_SYSTEM) {
      if (topic === DINGTALK_STREAM_SYSTEM_PING && messageId !== undefined) {
        let echoPayload: Record<string, unknown> = {};
        if (typeof frame.data === "string" && frame.data.length > 0) {
          try {
            const parsedData: unknown = JSON.parse(frame.data);
            if (isPlainRecord(parsedData)) {
              echoPayload = parsedData;
            }
          } catch {
            // Keep empty object fallback
          }
        }
        this.safeSendFrame(socket, buildStreamAckFrame(messageId, echoPayload));
        return;
      }

      if (topic === DINGTALK_STREAM_SYSTEM_DISCONNECT) {
        // Per DingTalk Stream spec: do NOT send an ACK for `disconnect`; close and open a new ticketed connection.
        markDisconnect();
        try {
          socket.close(WS_CLOSE_NORMAL, "server_disconnect");
        } catch {
          // Ignore
        }
      }
      return;
    }

    if (frameType === DINGTALK_STREAM_FRAME_CALLBACK) {
      if (messageId !== undefined) {
        this.safeSendFrame(socket, buildStreamAckFrame(messageId, { response: {} }));
      }

      if (topic === DINGTALK_STREAM_TOPIC_ROBOT && typeof frame.data === "string") {
        const task = this.dispatchStreamRobotCallback(frame.data, messageId).finally(() => {
          this.inFlightCallbacks.delete(task);
        });
        this.inFlightCallbacks.add(task);
      }
      return;
    }

    if (frameType === DINGTALK_STREAM_FRAME_EVENT && messageId !== undefined) {
      this.safeSendFrame(
        socket,
        buildStreamAckFrame(messageId, {
          status: DINGTALK_STREAM_EVENT_STATUS_SUCCESS,
          message: DINGTALK_STREAM_ACK_MESSAGE_OK,
        }),
      );
    }
  }

  private safeSendFrame(socket: DingTalkWebSocketLike, payload: string): void {
    try {
      socket.send(payload);
    } catch (error) {
      this.logger.warn("Failed to send DingTalk Stream ACK frame", {
        connectorName: this.connectorName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatchStreamRobotCallback(
    rawData: string,
    fallbackFrameMessageId?: string,
  ): Promise<void> {
    let payload: DingTalkRobotCallbackPayload;
    try {
      const parsed: unknown = JSON.parse(rawData);
      if (!isPlainRecord(parsed)) return;
      payload = parsed as DingTalkRobotCallbackPayload;
    } catch {
      this.logger.warn("Ignored invalid DingTalk robot callback JSON in Stream frame", {
        connectorName: this.connectorName,
      });
      return;
    }

    try {
      await this.ingestRobotPayload(payload, fallbackFrameMessageId);
    } catch (error) {
      this.logger.error("Failed processing inbound DingTalk Stream robot message", {
        connectorName: this.connectorName,
        error: error instanceof Error ? error.message : String(error),
        status: DINGTALK_STREAM_EVENT_STATUS_LATER,
      });
    }
  }

  private async ingestRobotPayload(
    payload: DingTalkRobotCallbackPayload,
    fallbackMessageId?: string,
  ): Promise<{ readonly sessionId: string; readonly deduplicated?: boolean } | undefined> {
    if (this.receiverCtx === undefined) {
      throw new ConnectorValidationError(
        `DingTalkReceiver "${this.connectorName}" has not been initialized via init(ctx).`,
        { connectorName: this.connectorName },
      );
    }

    const senderId = nonEmptyTrimmed(payload.senderId);
    const senderStaffId = nonEmptyTrimmed(payload.senderStaffId);
    const chatbotUserId = nonEmptyTrimmed(payload.chatbotUserId);
    const conversationId = nonEmptyTrimmed(payload.conversationId);

    if (senderId === undefined || conversationId === undefined) {
      return undefined;
    }

    // Loop prevention: filter messages sent by the bot itself
    if (
      (chatbotUserId !== undefined && senderId === chatbotUserId) ||
      this.botUserIds.has(senderId) ||
      (senderStaffId !== undefined && this.botStaffIds.has(senderStaffId))
    ) {
      return undefined;
    }

    const rawConvType = String(payload.conversationType ?? DINGTALK_CONVERSATION_SINGLE).trim();
    const conversationType: "1" | "2" =
      rawConvType === DINGTALK_CONVERSATION_GROUP
        ? DINGTALK_CONVERSATION_GROUP
        : DINGTALK_CONVERSATION_SINGLE;

    if (
      conversationType === DINGTALK_CONVERSATION_GROUP &&
      this.requireAtInGroup &&
      payload.isInAtList !== true
    ) {
      return undefined;
    }

    const rawMainText = extractInboundMainText(payload);
    const { contextId: mainMarkerId, cleanedContent: cleanedMainText } =
      extractContextMarker(rawMainText);
    const normalizedText = cleanedMainText.trim();
    if (normalizedText.length === 0) {
      return undefined;
    }

    const rawQuoted = extractQuotedText(payload);
    let quotedMarkerId: string | undefined;
    let cleanedQuotedText: string | undefined;
    if (rawQuoted !== undefined) {
      const extractedQuote = extractContextMarker(rawQuoted);
      quotedMarkerId = extractedQuote.contextId;
      const trimmedQuote = extractedQuote.cleanedContent.trim();
      if (trimmedQuote.length > 0) {
        cleanedQuotedText = trimmedQuote;
      }
    }

    const canonicalBusinessContextId =
      conversationType === DINGTALK_CONVERSATION_GROUP
        ? formatDingTalkGroupContextId(conversationId)
        : senderStaffId !== undefined
          ? formatDingTalkP2PContextId(senderStaffId)
          : formatDingTalkEncryptedP2PContextId(senderId);

    const resolvedContextId = quotedMarkerId ?? mainMarkerId ?? canonicalBusinessContextId;
    const context = createConnectorContext(this.connectorName, resolvedContextId);

    const sessionWebhook = nonEmptyTrimmed(payload.sessionWebhook);
    if (sessionWebhook !== undefined && this.webhookCache !== undefined) {
      const expiresAt =
        parseOptionalEpochMs(payload.sessionWebhookExpiredTime) ??
        this.now() + DINGTALK_DEFAULT_SESSION_WEBHOOK_TTL_MS;
      try {
        this.webhookCache.set(resolvedContextId, sessionWebhook, expiresAt);
        if (canonicalBusinessContextId !== resolvedContextId) {
          this.webhookCache.set(canonicalBusinessContextId, sessionWebhook, expiresAt);
        }
      } catch {
        // Ignore untrusted/malformed sessionWebhook URLs without dropping the inbound message
      }
    }

    const msgId =
      nonEmptyTrimmed(payload.msgId) ?? fallbackMessageId ?? this.receiverCtx.allocateContextId();
    const createAt = parseOptionalEpochMs(payload.createAt);
    const conversationTitle = nonEmptyTrimmed(payload.conversationTitle);
    const senderNick = nonEmptyTrimmed(payload.senderNick);
    const senderCorpId = nonEmptyTrimmed(payload.senderCorpId);
    const robotCode = nonEmptyTrimmed(payload.robotCode);

    const inboundMessage: DingTalkInboundMessage = {
      msgId,
      msgtype: nonEmptyTrimmed(payload.msgtype) ?? "text",
      text: normalizedText,
      ...(cleanedQuotedText !== undefined ? { quotedText: cleanedQuotedText } : {}),
      conversationId,
      conversationType,
      ...(conversationTitle !== undefined ? { conversationTitle } : {}),
      senderId,
      ...(senderStaffId !== undefined ? { senderStaffId } : {}),
      ...(senderNick !== undefined ? { senderNick } : {}),
      ...(senderCorpId !== undefined ? { senderCorpId } : {}),
      ...(chatbotUserId !== undefined ? { chatbotUserId } : {}),
      ...(robotCode !== undefined ? { robotCode } : {}),
      ...(typeof payload.isInAtList === "boolean" ? { isInAtList: payload.isInAtList } : {}),
      ...(sessionWebhook !== undefined ? { sessionWebhook } : {}),
      ...(parseOptionalEpochMs(payload.sessionWebhookExpiredTime) !== undefined
        ? { sessionWebhookExpiredTime: parseOptionalEpochMs(payload.sessionWebhookExpiredTime) }
        : {}),
      ...(createAt !== undefined ? { createAt } : {}),
    };

    const suggestedTitle =
      conversationType === DINGTALK_CONVERSATION_GROUP
        ? (conversationTitle ?? `DingTalk Group ${conversationId}`)
        : (senderNick ?? `DingTalk ${senderStaffId ?? senderId}`);

    return this.receiverCtx.onReceive(context, inboundMessage, {
      idempotencyKey: msgId,
      suggestedTitle,
      receivedAt: createAt ?? this.now(),
    });
  }
}
