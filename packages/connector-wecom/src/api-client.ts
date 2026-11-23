/**
 * Enterprise WeChat (WeCom) HTTP REST client for:
 * - Self-built application `access_token` management (`GET /cgi-bin/gettoken`)
 * - Self-built application outbound messages (`POST /cgi-bin/message/send`)
 * - Application group chat outbound messages (`POST /cgi-bin/appchat/send`)
 * - Group custom webhook bot outbound messages (`POST /cgi-bin/webhook/send?key=...`)
 * - Intelligent Bot active HTTP callback replies (`POST <response_url>`)
 *
 * @see https://developer.work.weixin.qq.com/document/path/91039 Access token acquisition
 * @see https://developer.work.weixin.qq.com/document/path/96458 Self-built app message sending
 * @see https://developer.work.weixin.qq.com/document/path/90248 App group chat message sending
 * @see https://developer.work.weixin.qq.com/document/path/99110 Group webhook bot message sending
 * @see https://developer.work.weixin.qq.com/document/path/101138 Intelligent Bot `response_url` active reply
 */

import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import {
  CONTENT_TYPE_JSON_UTF8,
  DEFAULT_WECOM_API_BASE_URL,
  DEFAULT_WECOM_CONNECTOR_NAME,
  DEFAULT_WECOM_HTTP_TIMEOUT_MS,
  DEFAULT_WECOM_TOKEN_FALLBACK_TTL_SECONDS,
  DEFAULT_WECOM_TOKEN_REFRESH_BUFFER_SECONDS,
  MIN_TOKEN_CACHE_TTL_SECONDS,
  SECONDS_TO_MS,
  SHORT_TOKEN_REFRESH_BUFFER_SECONDS,
  WECOM_APPCHAT_SEND_PATH,
  WECOM_APP_MESSAGE_SEND_PATH,
  WECOM_AUTH_ERRCODES,
  WECOM_ERRCODE_OK,
  WECOM_GETTOKEN_PATH,
  WECOM_TOKEN_INVALID_ERRCODES,
  WECOM_WEBHOOK_SEND_PATH,
} from "./constants";
import type { WeComAppCredentials, WeComWebhookCredentials } from "./types";

const HTTP_URL_RE = /^https?:\/\//i;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_SERVER_ERROR_MIN = 500;
const MAX_HTTP_ERROR_SNIPPET_LENGTH = 200;

export interface WeComApiResponse {
  readonly errcode: number;
  readonly errmsg: string;
  readonly msgid?: string;
  readonly response_code?: string;
  readonly invaliduser?: string;
  readonly invalidparty?: string;
  readonly invalidtag?: string;
  readonly unlicenseduser?: string;
  readonly [key: string]: unknown;
}

export type WeComAppSendPayload =
  | {
      readonly touser?: string;
      readonly toparty?: string;
      readonly totag?: string;
      readonly msgtype: "text";
      readonly text: { readonly content: string };
      readonly safe?: 0 | 1;
    }
  | {
      readonly touser?: string;
      readonly toparty?: string;
      readonly totag?: string;
      readonly msgtype: "markdown";
      readonly markdown: { readonly content: string };
    };

export type WeComAppChatSendPayload =
  | {
      readonly chatid: string;
      readonly msgtype: "text";
      readonly text: {
        readonly content: string;
        readonly mentioned_list?: readonly string[];
      };
      readonly safe?: 0 | 1;
    }
  | {
      readonly chatid: string;
      readonly msgtype: "markdown";
      readonly markdown: { readonly content: string };
    };

export type WeComWebhookSendPayload =
  | {
      readonly msgtype: "text";
      readonly text: {
        readonly content: string;
        readonly mentioned_list?: readonly string[];
        readonly mentioned_mobile_list?: readonly string[];
      };
    }
  | {
      readonly msgtype: "markdown";
      readonly markdown: { readonly content: string };
    }
  | {
      readonly msgtype: "markdown_v2";
      readonly markdown_v2: { readonly content: string };
    };

export interface WeComResponseUrlPayload {
  readonly msgtype: "markdown";
  readonly markdown: {
    readonly content: string;
    readonly feedback?: { readonly id: string };
  };
}

export interface WeComApiClientOptions {
  readonly connectorName?: string;
  readonly app?: WeComAppCredentials;
  readonly webhook?: WeComWebhookCredentials;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export function normalizeWeComApiBaseUrl(rawUrl?: string): string {
  const trimmed = rawUrl?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return DEFAULT_WECOM_API_BASE_URL;
  }
  if (!HTTP_URL_RE.test(trimmed)) {
    throw new ConnectorValidationError(
      `WeCom apiBaseUrl must start with http:// or https://, received "${trimmed}".`,
    );
  }
  return trimmed.replace(/\/+$/u, "");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumericAgentId(agentId: number | string, connectorName: string): number {
  const parsed = typeof agentId === "number" ? agentId : Number.parseInt(agentId.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConnectorValidationError(`Invalid WeCom agentId "${String(agentId)}".`, {
      connectorName,
    });
  }
  return parsed;
}

export class WeComApiClient {
  readonly connectorName: string;
  readonly app: WeComAppCredentials | undefined;
  readonly appApiBaseUrl: string;
  readonly webhookApiBaseUrl: string;
  private readonly agentIdNumber: number | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  private cachedToken: string | undefined;
  private tokenExpiresAtMs = 0;
  private pendingTokenPromise: Promise<string> | undefined;

  constructor(options: WeComApiClientOptions = {}) {
    this.connectorName = options.connectorName ?? DEFAULT_WECOM_CONNECTOR_NAME;
    this.app = options.app;
    this.appApiBaseUrl = normalizeWeComApiBaseUrl(options.app?.apiBaseUrl);
    this.webhookApiBaseUrl = normalizeWeComApiBaseUrl(
      options.webhook?.apiBaseUrl ?? options.app?.apiBaseUrl,
    );
    this.agentIdNumber =
      options.app !== undefined
        ? parseNumericAgentId(options.app.agentId, this.connectorName)
        : undefined;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WECOM_HTTP_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  invalidateAccessToken(): void {
    this.cachedToken = undefined;
    this.tokenExpiresAtMs = 0;
  }

  /**
   * Acquires and caches self-built app `access_token` via `GET /cgi-bin/gettoken`.
   *
   * @see https://developer.work.weixin.qq.com/document/path/91039
   */
  async getAccessToken(options?: {
    readonly forceRefresh?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    if (this.app === undefined) {
      throw new ConnectorValidationError(
        `Connector "${this.connectorName}" requires self-built app credentials (corpId, corpSecret, agentId) to acquire an access_token.`,
        { connectorName: this.connectorName },
      );
    }

    const forceRefresh = options?.forceRefresh ?? false;
    if (!forceRefresh && this.cachedToken !== undefined && this.now() < this.tokenExpiresAtMs) {
      return this.cachedToken;
    }

    if (!forceRefresh && this.pendingTokenPromise !== undefined) {
      return this.pendingTokenPromise;
    }

    const promise = this.fetchNewAccessToken(this.app, options?.signal).finally(() => {
      if (this.pendingTokenPromise === promise) {
        this.pendingTokenPromise = undefined;
      }
    });
    this.pendingTokenPromise = promise;
    return promise;
  }

  /**
   * Sends an application message via `POST /cgi-bin/message/send?access_token=...`,
   * automatically refreshing `access_token` once on `40001` / `40014` / `42001`.
   *
   * @see https://developer.work.weixin.qq.com/document/path/96458
   */
  async sendAppMessage(
    payload: WeComAppSendPayload,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WeComApiResponse> {
    if (this.app === undefined || this.agentIdNumber === undefined) {
      throw new ConnectorValidationError(
        `Connector "${this.connectorName}" is not configured with self-built app credentials.`,
        { connectorName: this.connectorName },
      );
    }

    const bodyRecord: Record<string, unknown> = {
      ...payload,
      agentid: this.agentIdNumber,
      ...(this.app.enableDuplicateCheck === true ? { enable_duplicate_check: 1 } : {}),
      ...(this.app.duplicateCheckIntervalSeconds !== undefined
        ? { duplicate_check_interval: this.app.duplicateCheckIntervalSeconds }
        : {}),
    };

    return this.postAuthenticatedJson(WECOM_APP_MESSAGE_SEND_PATH, bodyRecord, options?.signal);
  }

  /**
   * Sends a message to an app-created group chat via `POST /cgi-bin/appchat/send?access_token=...`.
   *
   * @see https://developer.work.weixin.qq.com/document/path/90248
   */
  async sendAppChatMessage(
    payload: WeComAppChatSendPayload,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WeComApiResponse> {
    return this.postAuthenticatedJson(WECOM_APPCHAT_SEND_PATH, { ...payload }, options?.signal);
  }

  /**
   * Sends a message to a group webhook bot via `POST /cgi-bin/webhook/send?key=...`.
   *
   * @see https://developer.work.weixin.qq.com/document/path/99110
   */
  async sendWebhookMessage(
    webhookKey: string,
    payload: WeComWebhookSendPayload,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WeComApiResponse> {
    const trimmedKey = webhookKey.trim();
    if (trimmedKey.length === 0) {
      throw new ConnectorValidationError("WeCom webhookKey must not be empty.", {
        connectorName: this.connectorName,
      });
    }

    const url = new URL(`${this.webhookApiBaseUrl}${WECOM_WEBHOOK_SEND_PATH}`);
    url.searchParams.set("key", trimmedKey);

    const parsed = await this.executeJsonFetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: options?.signal,
    });
    this.assertWeComOk(parsed);
    return parsed;
  }

  /**
   * Sends an active reply to an Intelligent Bot temporary `response_url` (valid 1 hour, single-use).
   *
   * @see https://developer.work.weixin.qq.com/document/path/101138
   */
  async sendResponseUrlMessage(
    responseUrl: string,
    payload: WeComResponseUrlPayload,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WeComApiResponse> {
    const trimmedUrl = responseUrl.trim();
    if (!HTTP_URL_RE.test(trimmedUrl)) {
      throw new ConnectorValidationError(
        `Invalid WeCom response_url "${trimmedUrl}": must be an http(s) URL.`,
        { connectorName: this.connectorName },
      );
    }

    const parsed = await this.executeJsonFetch(new URL(trimmedUrl), {
      method: "POST",
      body: JSON.stringify(payload),
      signal: options?.signal,
    });
    this.assertWeComOk(parsed);
    return parsed;
  }

  private async fetchNewAccessToken(
    app: WeComAppCredentials,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = new URL(`${this.appApiBaseUrl}${WECOM_GETTOKEN_PATH}`);
    url.searchParams.set("corpid", app.corpId.trim());
    url.searchParams.set("corpsecret", app.corpSecret.trim());

    const parsed = await this.executeJsonFetch(url, { method: "GET", signal });
    this.assertWeComOk(parsed);

    const token = parsed["access_token"];
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new ConnectorAuthError(
        `WeCom gettoken succeeded without returning a valid access_token.`,
        { connectorName: this.connectorName },
      );
    }

    const rawExpiresIn = parsed["expires_in"];
    const expiresInSec =
      typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
        ? rawExpiresIn
        : DEFAULT_WECOM_TOKEN_FALLBACK_TTL_SECONDS;
    const bufferSec =
      expiresInSec > DEFAULT_WECOM_TOKEN_REFRESH_BUFFER_SECONDS
        ? DEFAULT_WECOM_TOKEN_REFRESH_BUFFER_SECONDS
        : SHORT_TOKEN_REFRESH_BUFFER_SECONDS;
    const effectiveTtlSec = Math.max(expiresInSec - bufferSec, MIN_TOKEN_CACHE_TTL_SECONDS);

    this.cachedToken = token;
    this.tokenExpiresAtMs = this.now() + effectiveTtlSec * SECONDS_TO_MS;
    return token;
  }

  private async postAuthenticatedJson(
    pathname: string,
    bodyRecord: Record<string, unknown>,
    signal?: AbortSignal,
    allowTokenRetry = true,
  ): Promise<WeComApiResponse> {
    const token = await this.getAccessToken({ signal });
    const url = new URL(`${this.appApiBaseUrl}${pathname}`);
    url.searchParams.set("access_token", token);

    const parsed = await this.executeJsonFetch(url, {
      method: "POST",
      body: JSON.stringify(bodyRecord),
      signal,
    });

    if (allowTokenRetry && WECOM_TOKEN_INVALID_ERRCODES.has(parsed.errcode)) {
      this.invalidateAccessToken();
      return this.postAuthenticatedJson(pathname, bodyRecord, signal, false);
    }

    this.assertWeComOk(parsed);
    return parsed;
  }

  private assertWeComOk(response: WeComApiResponse): void {
    if (response.errcode === WECOM_ERRCODE_OK) {
      return;
    }

    const message = `WeCom API error ${response.errcode}: ${response.errmsg}`;
    if (WECOM_AUTH_ERRCODES.has(response.errcode)) {
      throw new ConnectorAuthError(message, { connectorName: this.connectorName });
    }

    throw new ConnectorTransportError(message, {
      connectorName: this.connectorName,
      retryable: false,
    });
  }

  private async executeJsonFetch(
    url: URL,
    init: {
      readonly method: "GET" | "POST";
      readonly body?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<WeComApiResponse> {
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(init.signal?.reason);
    };
    if (init.signal !== undefined) {
      if (init.signal.aborted) {
        onAbort();
      } else {
        init.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      controller.abort(new DOMException("WeCom HTTP request timed out", "TimeoutError"));
    }, this.timeoutMs);

    try {
      controller.signal.throwIfAborted();
      const response = await this.fetchFn(url, {
        method: init.method,
        ...(init.body !== undefined
          ? {
              body: init.body,
              headers: { "content-type": CONTENT_TYPE_JSON_UTF8 },
            }
          : {}),
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        const retryable =
          response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
          response.status >= HTTP_STATUS_SERVER_ERROR_MIN;
        throw new ConnectorTransportError(
          `WeCom HTTP ${response.status}: ${rawText.slice(0, MAX_HTTP_ERROR_SNIPPET_LENGTH)}`,
          {
            connectorName: this.connectorName,
            statusCode: response.status,
            retryable,
          },
        );
      }

      let parsedUnknown: unknown;
      try {
        parsedUnknown = rawText.length > 0 ? JSON.parse(rawText) : {};
      } catch (error) {
        throw new ConnectorTransportError("WeCom API returned invalid JSON payload.", {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable: false,
          cause: error,
        });
      }

      if (!isPlainRecord(parsedUnknown)) {
        throw new ConnectorTransportError("WeCom API returned non-object JSON payload.", {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable: false,
        });
      }

      const rawErrcode = parsedUnknown["errcode"];
      const rawErrmsg = parsedUnknown["errmsg"];
      const errcode = typeof rawErrcode === "number" ? rawErrcode : WECOM_ERRCODE_OK;
      const errmsg = typeof rawErrmsg === "string" ? rawErrmsg : "ok";

      return {
        ...parsedUnknown,
        errcode,
        errmsg,
      };
    } catch (error) {
      if (error instanceof ConnectorTransportError || error instanceof ConnectorAuthError) {
        throw error;
      }
      throw new ConnectorTransportError(
        `WeCom HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          connectorName: this.connectorName,
          retryable: true,
          cause: error,
        },
      );
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }
}
