import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import {
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  QQ_AUTH_SCHEME,
  QQ_DEFAULT_CONNECTOR_NAME,
  QQ_DEFAULT_REQUEST_TIMEOUT_MS,
  QQ_DEFAULT_TOKEN_EXPIRES_IN_SECONDS,
  QQ_DEFAULT_TOKEN_URL,
  QQ_ERR_CODE_APPID_INVALID,
  QQ_ERR_CODE_BOT_NOT_FOUND,
  QQ_ERR_CODE_INVALID_SECRET,
  QQ_ERR_CODE_RATE_LIMITED,
  QQ_MS_PER_SECOND,
  QQ_TOKEN_REFRESH_BUFFER_MS,
} from "./constants";

const AUTH_BUSINESS_ERROR_CODES: ReadonlySet<number> = new Set([
  QQ_ERR_CODE_BOT_NOT_FOUND,
  QQ_ERR_CODE_APPID_INVALID,
  QQ_ERR_CODE_INVALID_SECRET,
]);

export interface QqAccessTokenManagerOptions {
  readonly appId: string;
  readonly clientSecret: string;
  readonly connectorName?: string;
  readonly tokenUrl?: string;
  readonly refreshBufferMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

interface QqAccessTokenResponseBody {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

interface CachedAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

function parseExpiresInSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return QQ_DEFAULT_TOKEN_EXPIRES_IN_SECONDS;
}

/**
 * Dynamic `access_token` manager for the official QQ Bot Open Platform.
 *
 * Exchanges `{ appId, clientSecret }` at `POST https://bots.qq.com/app/getAppAccessToken`
 * (or `https://api.bot.qq.com/app/getAppAccessToken`), formats `Authorization: QQBot <token>`,
 * deduplicates concurrent refreshes, and refreshes 60 seconds prior to expiry.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
 */
export class QqAccessTokenManager {
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly connectorName: string;
  private readonly tokenUrl: string;
  private readonly refreshBufferMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  private cached: CachedAccessToken | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(options: QqAccessTokenManagerOptions) {
    const appId = options.appId.trim();
    const clientSecret = options.clientSecret.trim();
    const connectorName = options.connectorName ?? QQ_DEFAULT_CONNECTOR_NAME;

    if (appId.length === 0) {
      throw new ConnectorValidationError("QQ connector requires a non-empty appId.", {
        connectorName,
      });
    }
    if (clientSecret.length === 0) {
      throw new ConnectorValidationError("QQ connector requires a non-empty clientSecret.", {
        connectorName,
      });
    }

    this.appId = appId;
    this.clientSecret = clientSecret;
    this.connectorName = connectorName;
    this.tokenUrl = (options.tokenUrl ?? QQ_DEFAULT_TOKEN_URL).trim();
    this.refreshBufferMs = options.refreshBufferMs ?? QQ_TOKEN_REFRESH_BUFFER_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? QQ_DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * Invalidates the cached token so the next request fetches a fresh credential.
   */
  invalidate(): void {
    this.cached = undefined;
  }

  /**
   * Returns a valid `access_token`, fetching or refreshing when absent or near expiry.
   *
   * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
   */
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();

    const nowMs = this.now();
    if (this.cached !== undefined && nowMs + this.refreshBufferMs < this.cached.expiresAtMs) {
      return this.cached.token;
    }

    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    const promise = this.fetchFreshToken(signal).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = promise;
    return promise;
  }

  /**
   * Formats the official `Authorization: QQBot <access_token>` HTTP/WebSocket header value.
   *
   * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
   */
  async getAuthorizationHeader(signal?: AbortSignal): Promise<string> {
    const token = await this.getAccessToken(signal);
    return `${QQ_AUTH_SCHEME} ${token}`;
  }

  private async fetchFreshToken(callerSignal?: AbortSignal): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal =
      callerSignal !== undefined ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchFn(this.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          appId: this.appId,
          clientSecret: this.clientSecret,
        }),
        signal: requestSignal,
      });
    } catch (cause) {
      if (callerSignal?.aborted === true) {
        throw callerSignal.reason ?? cause;
      }
      throw new ConnectorTransportError(
        "Failed to request QQ Bot access_token due to network error.",
        {
          connectorName: this.connectorName,
          retryable: true,
          cause,
        },
      );
    }

    let body: QqAccessTokenResponseBody;
    try {
      body = (await response.json()) as QqAccessTokenResponseBody;
    } catch (cause) {
      throw new ConnectorTransportError("QQ Bot getAppAccessToken returned invalid JSON.", {
        connectorName: this.connectorName,
        statusCode: response.status,
        retryable: response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
        cause,
      });
    }

    if (response.status === HTTP_STATUS_UNAUTHORIZED || response.status === HTTP_STATUS_FORBIDDEN) {
      throw new ConnectorAuthError(`QQ Bot authentication failed with HTTP ${response.status}.`, {
        connectorName: this.connectorName,
      });
    }

    const bizCode = typeof body.code === "number" ? body.code : undefined;
    const bizMessage = typeof body.message === "string" ? body.message : undefined;

    if (bizCode !== undefined && bizCode !== 0) {
      if (AUTH_BUSINESS_ERROR_CODES.has(bizCode)) {
        throw new ConnectorAuthError(
          `QQ Bot getAppAccessToken rejected credentials (code=${bizCode}${bizMessage !== undefined ? `: ${bizMessage}` : ""}).`,
          { connectorName: this.connectorName },
        );
      }
      throw new ConnectorTransportError(
        `QQ Bot getAppAccessToken returned business error (code=${bizCode}${bizMessage !== undefined ? `: ${bizMessage}` : ""}).`,
        {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable:
            bizCode === QQ_ERR_CODE_RATE_LIMITED ||
            response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
            response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
        },
      );
    }

    if (!response.ok) {
      throw new ConnectorTransportError(
        `QQ Bot getAppAccessToken failed with HTTP ${response.status}.`,
        {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable:
            response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
            response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
        },
      );
    }

    const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
    if (token.length === 0) {
      throw new ConnectorAuthError(
        "QQ Bot getAppAccessToken response did not contain a non-empty access_token.",
        { connectorName: this.connectorName },
      );
    }

    const expiresInSeconds = parseExpiresInSeconds(body.expires_in);
    this.cached = {
      token,
      expiresAtMs: this.now() + expiresInSeconds * QQ_MS_PER_SECOND,
    };
    return token;
  }
}
