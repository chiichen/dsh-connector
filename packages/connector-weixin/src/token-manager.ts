import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import {
  CONTENT_TYPE_APPLICATION_JSON,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_TOKEN_FALLBACK_TTL_SECONDS,
  DEFAULT_TOKEN_REFRESH_MARGIN_MS,
  HTTP_STATUS_SERVER_ERROR_MIN,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  MILLISECONDS_PER_SECOND,
  WEIXIN_AUTH_ERRCODES,
  WEIXIN_CLASSIC_TOKEN_PATH,
  WEIXIN_ERRCODE_OK,
  WEIXIN_ERRCODE_SYSTEM_BUSY,
  WEIXIN_GRANT_TYPE_CLIENT_CREDENTIAL,
  WEIXIN_OFFICIAL_API_BASE_URL,
  WEIXIN_RATE_LIMIT_ERRCODE,
  WEIXIN_STABLE_TOKEN_PATH,
} from "./constants";
import type {
  WeixinAccessTokenProvider,
  WeixinAccessTokenProviderOptions,
  WeixinTokenStrategy,
} from "./types";

export interface WeixinAccessTokenManagerOptions {
  readonly connectorName?: string;
  readonly appId?: string;
  readonly appSecret?: string;
  readonly accessToken?: string;
  readonly accessTokenProvider?: WeixinAccessTokenProvider;
  readonly tokenStrategy?: WeixinTokenStrategy;
  readonly refreshMarginMs?: number;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly nowFn?: () => number;
}

interface CachedAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Manages WeChat Official Account / Service Account `access_token` lifecycle with TTL caching,
 * concurrent refresh coalescing, and support for both the recommended Stable Access Token API
 * (`POST /cgi-bin/stable_token`) and Classic Access Token API (`GET /cgi-bin/token`).
 *
 * @see https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html
 * @see https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken.html
 */
export class WeixinAccessTokenManager {
  private readonly connectorName: string | undefined;
  private readonly appId: string | undefined;
  private readonly appSecret: string | undefined;
  private readonly staticToken: string | undefined;
  private readonly customProvider: WeixinAccessTokenProvider | undefined;
  private readonly strategy: WeixinTokenStrategy;
  private readonly refreshMarginMs: number;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly nowFn: () => number;

  private cached: CachedAccessToken | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(options: WeixinAccessTokenManagerOptions) {
    this.connectorName = options.connectorName;
    this.appId = options.appId?.trim();
    this.appSecret = options.appSecret?.trim();
    const staticToken = options.accessToken?.trim();
    this.staticToken =
      staticToken !== undefined && staticToken.length > 0 ? staticToken : undefined;
    this.customProvider = options.accessTokenProvider;
    this.strategy = options.tokenStrategy ?? "stable";
    this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_TOKEN_REFRESH_MARGIN_MS;
    this.apiBaseUrl = (options.apiBaseUrl ?? WEIXIN_OFFICIAL_API_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.nowFn = options.nowFn ?? Date.now;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async getAccessToken(options?: WeixinAccessTokenProviderOptions): Promise<string> {
    if (this.customProvider !== undefined) {
      const provided = (await this.customProvider(options)).trim();
      if (provided.length === 0) {
        throw new ConnectorAuthError(
          "Custom accessTokenProvider returned an empty Weixin access_token.",
          this.errOpts(),
        );
      }
      return provided;
    }

    if (this.staticToken !== undefined) {
      return this.staticToken;
    }

    const forceRefresh = options?.forceRefresh === true;
    if (!forceRefresh && this.cached !== undefined && this.nowFn() < this.cached.expiresAtMs) {
      return this.cached.token;
    }

    if (!forceRefresh && this.inFlight !== undefined) {
      return this.inFlight;
    }

    const task = this.fetchRemoteToken(forceRefresh, options?.signal).finally(() => {
      if (this.inFlight === task) {
        this.inFlight = undefined;
      }
    });

    if (!forceRefresh) {
      this.inFlight = task;
    }

    return task;
  }

  private errOpts(): { readonly connectorName?: string } {
    return this.connectorName !== undefined ? { connectorName: this.connectorName } : {};
  }

  private async fetchRemoteToken(
    forceRefresh: boolean,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    if (
      this.appId === undefined ||
      this.appId.length === 0 ||
      this.appSecret === undefined ||
      this.appSecret.length === 0
    ) {
      throw new ConnectorValidationError(
        "Weixin official-account outbound messaging requires either (appId + appSecret), accessToken, or accessTokenProvider.",
        this.errOpts(),
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort(callerSignal?.reason);
    };
    if (callerSignal?.aborted === true) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new ConnectorTransportError("Weixin token request was aborted.", {
            ...this.errOpts(),
            retryable: false,
          });
    }
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      if (this.strategy === "classic") {
        const url = new URL(`${this.apiBaseUrl}${WEIXIN_CLASSIC_TOKEN_PATH}`);
        url.searchParams.set("grant_type", WEIXIN_GRANT_TYPE_CLIENT_CREDENTIAL);
        url.searchParams.set("appid", this.appId);
        url.searchParams.set("secret", this.appSecret);
        response = await this.fetchFn(url.toString(), {
          method: "GET",
          signal: controller.signal,
        });
      } else {
        const url = `${this.apiBaseUrl}${WEIXIN_STABLE_TOKEN_PATH}`;
        response = await this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": CONTENT_TYPE_APPLICATION_JSON },
          body: JSON.stringify({
            grant_type: WEIXIN_GRANT_TYPE_CLIENT_CREDENTIAL,
            appid: this.appId,
            secret: this.appSecret,
            force_refresh: forceRefresh,
          }),
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (callerAborted) {
        throw callerSignal?.reason instanceof Error ? callerSignal.reason : error;
      }
      throw new ConnectorTransportError(
        timedOut
          ? "Weixin access_token request timed out."
          : "Network error while requesting Weixin access_token.",
        {
          ...this.errOpts(),
          cause: error,
          retryable: true,
        },
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    if (!response.ok) {
      throw new ConnectorTransportError(`Weixin access_token HTTP ${response.status} error.`, {
        ...this.errOpts(),
        statusCode: response.status,
        retryable:
          response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
          response.status >= HTTP_STATUS_SERVER_ERROR_MIN,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ConnectorTransportError("Invalid JSON response from Weixin token endpoint.", {
        ...this.errOpts(),
        cause: error,
        retryable: false,
      });
    }

    if (!isRecord(body)) {
      throw new ConnectorTransportError(
        "Unexpected non-object response from Weixin token endpoint.",
        this.errOpts(),
      );
    }

    const errcode = typeof body["errcode"] === "number" ? body["errcode"] : WEIXIN_ERRCODE_OK;
    if (errcode !== WEIXIN_ERRCODE_OK) {
      const errmsg = typeof body["errmsg"] === "string" ? body["errmsg"] : "unknown error";
      if (WEIXIN_AUTH_ERRCODES.includes(errcode)) {
        throw new ConnectorAuthError(
          `Weixin access_token rejected (errcode=${errcode}): ${errmsg}`,
          this.errOpts(),
        );
      }
      throw new ConnectorTransportError(
        `Weixin access_token failed (errcode=${errcode}): ${errmsg}`,
        {
          ...this.errOpts(),
          retryable:
            errcode === WEIXIN_ERRCODE_SYSTEM_BUSY || errcode === WEIXIN_RATE_LIMIT_ERRCODE,
        },
      );
    }

    const token = typeof body["access_token"] === "string" ? body["access_token"].trim() : "";
    if (token.length === 0) {
      throw new ConnectorTransportError(
        "Weixin token endpoint returned an empty access_token.",
        this.errOpts(),
      );
    }

    const expiresInSec =
      typeof body["expires_in"] === "number" && body["expires_in"] > 0
        ? body["expires_in"]
        : DEFAULT_TOKEN_FALLBACK_TTL_SECONDS;
    const ttlMs = Math.max(
      MILLISECONDS_PER_SECOND,
      expiresInSec * MILLISECONDS_PER_SECOND - this.refreshMarginMs,
    );

    this.cached = {
      token,
      expiresAtMs: this.nowFn() + ttlMs,
    };

    return token;
  }
}
