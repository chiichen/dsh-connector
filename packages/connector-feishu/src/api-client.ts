/**
 * Feishu (Lark) OpenAPI HTTP client with automatic `tenant_access_token`
 * acquisition, early refresh, single-flight concurrency deduplication, and
 * structured `ConnectorError` mapping.
 *
 * @see https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/reply
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/get
 * @see https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 */

import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import {
  DEFAULT_FEISHU_CONNECTOR_NAME,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TOKEN_EXPIRE_SECONDS,
  DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS,
  FEISHU_API_SUCCESS_CODE,
  FEISHU_APP_AUTH_ERROR_CODES,
  FEISHU_BOT_INFO_PATH,
  FEISHU_MESSAGES_PATH,
  FEISHU_RATE_LIMIT_ERROR_CODES,
  FEISHU_TENANT_ACCESS_TOKEN_PATH,
  FEISHU_TOKEN_INVALID_ERROR_CODES,
  FEISHU_WS_ENDPOINT_PATH,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  MIN_TOKEN_CACHE_TTL_MS,
  MS_PER_SECOND,
  WS_ENDPOINT_INTERNAL_ERROR_CODE,
  WS_ENDPOINT_SYSTEM_BUSY_CODE,
  WS_LOCALE_HEADER_VALUE,
} from "./constants";
import { resolveFeishuApiBaseUrl, type FeishuReceiveIdType } from "./context";

export type FeishuOutboundMsgType = "text" | "interactive";

export interface FeishuApiClientOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain?: string;
  readonly connectorName?: string;
  readonly requestTimeoutMs?: number;
  readonly tokenRefreshBufferSeconds?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

export interface FeishuRequestCallOptions {
  readonly signal?: AbortSignal;
}

export interface FeishuSendMessageApiRequest {
  readonly receiveIdType: FeishuReceiveIdType;
  readonly receiveId: string;
  readonly msgType: FeishuOutboundMsgType;
  readonly content: string;
  readonly uuid?: string;
}

export interface FeishuReplyMessageApiRequest {
  readonly messageId: string;
  readonly msgType: FeishuOutboundMsgType;
  readonly content: string;
  readonly replyInThread?: boolean;
  readonly uuid?: string;
}

export interface FeishuSendMessageApiData {
  readonly message_id: string;
  readonly root_id?: string;
  readonly parent_id?: string;
  readonly thread_id?: string;
  readonly chat_id?: string;
  readonly msg_type?: string;
  readonly create_time?: string;
}

export interface FeishuFetchedMessageItem {
  readonly message_id?: string;
  readonly root_id?: string;
  readonly parent_id?: string;
  readonly thread_id?: string;
  readonly msg_type?: string;
  readonly chat_id?: string;
  readonly deleted?: boolean;
  readonly sender?: {
    readonly id?: string;
    readonly id_type?: string;
    readonly sender_type?: string;
  };
  readonly body?: {
    readonly content?: string;
  };
  readonly mentions?: ReadonlyArray<{
    readonly key?: string;
    readonly id?: string;
    readonly id_type?: string;
    readonly name?: string;
  }>;
}

export interface FeishuBotInfo {
  readonly openId: string;
  readonly appName?: string;
  readonly activateStatus?: number;
}

export interface FeishuWsServerClientConfig {
  readonly PingInterval?: number;
  readonly ReconnectCount?: number;
  readonly ReconnectInterval?: number;
  readonly ReconnectNonce?: number;
}

export interface FeishuWsEndpointInfo {
  readonly url: string;
  readonly clientConfig?: FeishuWsServerClientConfig;
}

interface CachedTenantToken {
  readonly token: string;
  readonly refreshAfterMs: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenInvalidErrorCode(code: number): boolean {
  return (FEISHU_TOKEN_INVALID_ERROR_CODES as readonly number[]).includes(code);
}

function isAppAuthErrorCode(code: number): boolean {
  return (FEISHU_APP_AUTH_ERROR_CODES as readonly number[]).includes(code);
}

function isRateLimitErrorCode(code: number): boolean {
  return (FEISHU_RATE_LIMIT_ERROR_CODES as readonly number[]).includes(code);
}

function combineTimeoutSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal !== undefined
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Lightweight Feishu OpenAPI v1/v3 client built on native `fetch`.
 */
export class FeishuApiClient {
  readonly baseUrl: string;
  readonly connectorName: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly requestTimeoutMs: number;
  private readonly tokenRefreshBufferMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  private cachedToken: CachedTenantToken | undefined;
  private inflightTokenPromise: Promise<string> | undefined;

  constructor(options: FeishuApiClientOptions) {
    const connectorName = options.connectorName ?? DEFAULT_FEISHU_CONNECTOR_NAME;
    if (options.appId.trim().length === 0) {
      throw new ConnectorValidationError("Feishu appId must be a non-empty string.", {
        connectorName,
      });
    }
    if (options.appSecret.trim().length === 0) {
      throw new ConnectorValidationError("Feishu appSecret must be a non-empty string.", {
        connectorName,
      });
    }
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new ConnectorValidationError("Feishu requestTimeoutMs must be a positive number.", {
        connectorName,
      });
    }

    this.connectorName = connectorName;
    this.appId = options.appId.trim();
    this.appSecret = options.appSecret.trim();
    this.baseUrl = resolveFeishuApiBaseUrl(options.domain);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.tokenRefreshBufferMs =
      Math.max(0, options.tokenRefreshBufferSeconds ?? DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS) *
      MS_PER_SECOND;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * Invalidate cached `tenant_access_token` so the next call fetches a fresh token.
   */
  invalidateToken(): void {
    this.cachedToken = undefined;
  }

  /**
   * Obtain a valid `tenant_access_token`, refreshing early before expiry and
   * coalescing concurrent requests into a single network call.
   *
   * @see https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
   */
  async getTenantAccessToken(options?: FeishuRequestCallOptions): Promise<string> {
    const nowMs = this.now();
    if (this.cachedToken !== undefined && nowMs < this.cachedToken.refreshAfterMs) {
      return this.cachedToken.token;
    }

    if (this.inflightTokenPromise !== undefined) {
      return this.inflightTokenPromise;
    }

    const promise = this.fetchFreshTenantAccessToken(options).finally(() => {
      if (this.inflightTokenPromise === promise) {
        this.inflightTokenPromise = undefined;
      }
    });
    this.inflightTokenPromise = promise;
    return promise;
  }

  /**
   * Send a message via `POST /open-apis/im/v1/messages?receive_id_type=...`.
   *
   * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
   */
  async sendMessage(
    request: FeishuSendMessageApiRequest,
    options?: FeishuRequestCallOptions,
  ): Promise<FeishuSendMessageApiData> {
    const query = new URLSearchParams({ receive_id_type: request.receiveIdType });
    const path = `${FEISHU_MESSAGES_PATH}?${query.toString()}`;
    const body: Record<string, unknown> = {
      receive_id: request.receiveId,
      msg_type: request.msgType,
      content: request.content,
      ...(request.uuid !== undefined ? { uuid: request.uuid } : {}),
    };

    const payload = await this.authenticatedJsonRequest({ method: "POST", path, body }, options);
    return this.extractMessageSendData(payload);
  }

  /**
   * Reply to an existing message via `POST /open-apis/im/v1/messages/:message_id/reply`.
   *
   * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/reply
   */
  async replyMessage(
    request: FeishuReplyMessageApiRequest,
    options?: FeishuRequestCallOptions,
  ): Promise<FeishuSendMessageApiData> {
    const encodedId = encodeURIComponent(request.messageId);
    const path = `${FEISHU_MESSAGES_PATH}/${encodedId}/reply`;
    const body: Record<string, unknown> = {
      msg_type: request.msgType,
      content: request.content,
      ...(request.replyInThread !== undefined ? { reply_in_thread: request.replyInThread } : {}),
      ...(request.uuid !== undefined ? { uuid: request.uuid } : {}),
    };

    const payload = await this.authenticatedJsonRequest({ method: "POST", path, body }, options);
    return this.extractMessageSendData(payload);
  }

  /**
   * Query a single message by ID via `GET /open-apis/im/v1/messages/:message_id`.
   *
   * @see https://open.feishu.cn/document/server-docs/im-v1/message/get
   */
  async getMessage(
    messageId: string,
    options?: FeishuRequestCallOptions,
  ): Promise<FeishuFetchedMessageItem | undefined> {
    const encodedId = encodeURIComponent(messageId);
    const payload = await this.authenticatedJsonRequest(
      { method: "GET", path: `${FEISHU_MESSAGES_PATH}/${encodedId}` },
      options,
    );
    const data = isPlainObject(payload["data"]) ? payload["data"] : undefined;
    const items = Array.isArray(data?.["items"]) ? data["items"] : [];
    for (const candidate of items) {
      if (isPlainObject(candidate)) {
        const candidateId = candidate["message_id"];
        if (typeof candidateId === "string" && candidateId === messageId) {
          return candidate as FeishuFetchedMessageItem;
        }
      }
    }
    const first = items[0];
    return isPlainObject(first) ? (first as FeishuFetchedMessageItem) : undefined;
  }

  /**
   * Retrieve bot identity metadata (`open_id`, `app_name`) via `GET /open-apis/bot/v3/info`.
   *
   * @see https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info
   */
  async getBotInfo(options?: FeishuRequestCallOptions): Promise<FeishuBotInfo> {
    const payload = await this.authenticatedJsonRequest(
      { method: "GET", path: FEISHU_BOT_INFO_PATH },
      options,
    );
    const bot = isPlainObject(payload["bot"]) ? payload["bot"] : undefined;
    const openId = typeof bot?.["open_id"] === "string" ? bot["open_id"].trim() : "";
    if (openId.length === 0) {
      throw new ConnectorTransportError(
        "Feishu bot/v3/info response did not contain a valid bot.open_id.",
        { connectorName: this.connectorName },
      );
    }
    const appName = typeof bot?.["app_name"] === "string" ? bot["app_name"] : undefined;
    const activateStatus =
      typeof bot?.["activate_status"] === "number" ? bot["activate_status"] : undefined;
    return {
      openId,
      ...(appName !== undefined ? { appName } : {}),
      ...(activateStatus !== undefined ? { activateStatus } : {}),
    };
  }

  /**
   * Discover the Feishu WebSocket long-connection endpoint URL and server-controlled
   * keepalive/reconnect parameters via `POST /callback/ws/endpoint`.
   *
   * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
   */
  async pullWsEndpoint(options?: FeishuRequestCallOptions): Promise<FeishuWsEndpointInfo> {
    const url = `${this.baseUrl}${FEISHU_WS_ENDPOINT_PATH}`;
    const { status, json } = await this.rawJsonFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          locale: WS_LOCALE_HEADER_VALUE,
        },
        body: JSON.stringify({
          AppID: this.appId,
          AppSecret: this.appSecret,
        }),
      },
      options,
    );

    const code = typeof json["code"] === "number" ? json["code"] : -1;
    const msg = typeof json["msg"] === "string" ? json["msg"] : "unknown error";

    if (code !== FEISHU_API_SUCCESS_CODE) {
      if (
        isAppAuthErrorCode(code) ||
        status === HTTP_STATUS_UNAUTHORIZED ||
        status === HTTP_STATUS_FORBIDDEN
      ) {
        throw new ConnectorAuthError(
          `Feishu WebSocket endpoint authentication failed (code=${code}): ${msg}`,
          { connectorName: this.connectorName },
        );
      }
      const retryable =
        code === WS_ENDPOINT_INTERNAL_ERROR_CODE ||
        code === WS_ENDPOINT_SYSTEM_BUSY_CODE ||
        status === HTTP_STATUS_TOO_MANY_REQUESTS ||
        status >= HTTP_STATUS_INTERNAL_SERVER_ERROR;
      throw new ConnectorTransportError(
        `Feishu WebSocket endpoint discovery failed (code=${code}): ${msg}`,
        { connectorName: this.connectorName, statusCode: status, retryable },
      );
    }

    const data = isPlainObject(json["data"]) ? json["data"] : undefined;
    const wsUrl = typeof data?.["URL"] === "string" ? data["URL"].trim() : "";
    if (wsUrl.length === 0) {
      throw new ConnectorTransportError(
        "Feishu WebSocket endpoint discovery returned an empty URL.",
        { connectorName: this.connectorName, statusCode: status },
      );
    }
    const clientConfig = isPlainObject(data?.["ClientConfig"])
      ? (data["ClientConfig"] as FeishuWsServerClientConfig)
      : undefined;

    return {
      url: wsUrl,
      ...(clientConfig !== undefined ? { clientConfig } : {}),
    };
  }

  private async fetchFreshTenantAccessToken(options?: FeishuRequestCallOptions): Promise<string> {
    const url = `${this.baseUrl}${FEISHU_TENANT_ACCESS_TOKEN_PATH}`;
    const { status, json } = await this.rawJsonFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      },
      options,
    );

    const code = typeof json["code"] === "number" ? json["code"] : -1;
    const msg = typeof json["msg"] === "string" ? json["msg"] : "unknown error";
    const token =
      typeof json["tenant_access_token"] === "string" ? json["tenant_access_token"].trim() : "";

    if (code !== FEISHU_API_SUCCESS_CODE || token.length === 0) {
      if (status >= HTTP_STATUS_INTERNAL_SERVER_ERROR || status === HTTP_STATUS_TOO_MANY_REQUESTS) {
        throw new ConnectorTransportError(
          `Feishu tenant_access_token request failed (HTTP ${status}, code=${code}): ${msg}`,
          { connectorName: this.connectorName, statusCode: status, retryable: true },
        );
      }
      throw new ConnectorAuthError(
        `Failed to obtain Feishu tenant_access_token (code=${code}): ${msg}`,
        { connectorName: this.connectorName },
      );
    }

    const expireSeconds =
      typeof json["expire"] === "number" && json["expire"] > 0
        ? json["expire"]
        : DEFAULT_TOKEN_EXPIRE_SECONDS;
    const ttlMs = Math.max(
      MIN_TOKEN_CACHE_TTL_MS,
      expireSeconds * MS_PER_SECOND - this.tokenRefreshBufferMs,
    );
    this.cachedToken = {
      token,
      refreshAfterMs: this.now() + ttlMs,
    };

    return token;
  }

  private async authenticatedJsonRequest(
    req: {
      readonly method: "GET" | "POST" | "PUT" | "PATCH";
      readonly path: string;
      readonly body?: Record<string, unknown>;
    },
    options?: FeishuRequestCallOptions,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.getTenantAccessToken(options);
      const url = `${this.baseUrl}${req.path}`;
      const { status, json } = await this.rawJsonFetch(
        url,
        {
          method: req.method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        },
        options,
      );

      const code = typeof json["code"] === "number" ? json["code"] : -1;
      if (code === FEISHU_API_SUCCESS_CODE) {
        return json;
      }

      if (attempt === 0 && isTokenInvalidErrorCode(code)) {
        this.invalidateToken();
        continue;
      }

      const msg = typeof json["msg"] === "string" ? json["msg"] : "unknown Feishu API error";
      if (
        isTokenInvalidErrorCode(code) ||
        isAppAuthErrorCode(code) ||
        status === HTTP_STATUS_UNAUTHORIZED ||
        status === HTTP_STATUS_FORBIDDEN
      ) {
        throw new ConnectorAuthError(
          `Feishu OpenAPI authentication error on ${req.method} ${req.path} (code=${code}): ${msg}`,
          { connectorName: this.connectorName },
        );
      }

      const retryable =
        isRateLimitErrorCode(code) ||
        status === HTTP_STATUS_TOO_MANY_REQUESTS ||
        status >= HTTP_STATUS_INTERNAL_SERVER_ERROR;
      throw new ConnectorTransportError(
        `Feishu OpenAPI error on ${req.method} ${req.path} (code=${code}): ${msg}`,
        { connectorName: this.connectorName, statusCode: status, retryable },
      );
    }

    throw new ConnectorAuthError("Feishu OpenAPI request exhausted token refresh retry.", {
      connectorName: this.connectorName,
    });
  }

  private extractMessageSendData(payload: Record<string, unknown>): FeishuSendMessageApiData {
    const data = isPlainObject(payload["data"]) ? payload["data"] : undefined;
    const messageId = typeof data?.["message_id"] === "string" ? data["message_id"].trim() : "";
    if (messageId.length === 0) {
      throw new ConnectorTransportError(
        "Feishu im/v1/messages response did not return a valid data.message_id.",
        { connectorName: this.connectorName },
      );
    }

    const rootId = typeof data?.["root_id"] === "string" ? data["root_id"] : undefined;
    const parentId = typeof data?.["parent_id"] === "string" ? data["parent_id"] : undefined;
    const threadId = typeof data?.["thread_id"] === "string" ? data["thread_id"] : undefined;
    const chatId = typeof data?.["chat_id"] === "string" ? data["chat_id"] : undefined;
    const msgType = typeof data?.["msg_type"] === "string" ? data["msg_type"] : undefined;
    const createTime = typeof data?.["create_time"] === "string" ? data["create_time"] : undefined;

    return {
      message_id: messageId,
      ...(rootId !== undefined ? { root_id: rootId } : {}),
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
      ...(threadId !== undefined ? { thread_id: threadId } : {}),
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      ...(msgType !== undefined ? { msg_type: msgType } : {}),
      ...(createTime !== undefined ? { create_time: createTime } : {}),
    };
  }

  private async rawJsonFetch(
    url: string,
    init: RequestInit,
    options?: FeishuRequestCallOptions,
  ): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
    const signal = combineTimeoutSignal(options?.signal, this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(url, { ...init, signal });
    } catch (cause) {
      throw new ConnectorTransportError(`Feishu HTTP request failed for ${url}.`, {
        connectorName: this.connectorName,
        retryable: true,
        cause,
      });
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch (cause) {
      throw new ConnectorTransportError(`Failed reading Feishu HTTP response body from ${url}.`, {
        connectorName: this.connectorName,
        statusCode: response.status,
        retryable: response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
        cause,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (cause) {
      throw new ConnectorTransportError(
        `Feishu HTTP response from ${url} was not valid JSON (HTTP ${response.status}).`,
        {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable:
            response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
            response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
          cause,
        },
      );
    }

    if (!isPlainObject(parsed)) {
      throw new ConnectorTransportError(
        `Feishu HTTP response from ${url} did not return a JSON object (HTTP ${response.status}).`,
        {
          connectorName: this.connectorName,
          statusCode: response.status,
        },
      );
    }

    return { status: response.status, json: parsed };
  }
}
