import {
  ConnectorAuthError,
  ConnectorTransportError,
  ConnectorValidationError,
} from "@dsh-connector/core";
import {
  DEFAULT_SLACK_API_BASE_URL,
  DEFAULT_SLACK_TIMEOUT_MS,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  MILLISECONDS_PER_SECOND,
  SLACK_APP_TOKEN_PREFIX,
  SLACK_AUTH_ERROR_CODES,
  SLACK_BOT_TOKEN_PREFIX,
  SLACK_DEFAULT_RETRY_AFTER_SEC,
  SLACK_HEADER_RETRY_AFTER,
  SLACK_MAX_RETRY_DELAY_MS,
  SLACK_METHOD_AUTH_TEST,
  SLACK_METHOD_OPEN_CONNECTION,
  SLACK_METHOD_POST_MESSAGE,
  SLACK_MIN_RETRY_DELAY_MS,
  SLACK_RETRYABLE_ERROR_CODES,
} from "./constants";
import { assertValidSlackChannelId, assertValidSlackTimestamp } from "./context-target";

const SLACK_BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,}$/;
const SLACK_APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]{10,}$/;
const BROADCAST_MENTION_RE = /<!(channel|here|everyone)(?:\|[^>]*)?>/gi;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=utf-8";
const JSON_CONTENT_TYPE = "application/json;charset=utf-8";
const SECURE_WS_PROTOCOL = "wss:";

export interface SlackApiClientOptions {
  readonly botToken?: string;
  readonly appToken?: string;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly connectorName?: string;
  readonly sanitizeBroadcastMentions?: boolean;
}

/**
 * Response from `POST https://slack.com/api/auth.test`.
 *
 * @see https://docs.slack.dev/reference/methods/auth.test
 */
export interface SlackAuthTestResponse {
  readonly ok: true;
  readonly url?: string;
  readonly team?: string;
  readonly user?: string;
  readonly team_id: string;
  readonly user_id: string;
  readonly bot_id?: string;
  readonly is_enterprise_install?: boolean;
}

/**
 * Response from `POST https://slack.com/api/apps.connections.open`.
 *
 * @see https://docs.slack.dev/reference/methods/apps.connections.open
 */
export interface SlackOpenConnectionResponse {
  readonly ok: true;
  readonly url: string;
}

/**
 * Request payload for `POST https://slack.com/api/chat.postMessage`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export interface SlackPostMessageRequest {
  readonly channel: string;
  readonly text: string;
  readonly thread_ts?: string;
  readonly reply_broadcast?: boolean;
  readonly mrkdwn?: boolean;
  readonly unfurl_links?: boolean;
  readonly unfurl_media?: boolean;
  readonly link_names?: boolean;
}

/**
 * Response from `POST https://slack.com/api/chat.postMessage`.
 *
 * @see https://docs.slack.dev/reference/methods/chat.postMessage/
 */
export interface SlackPostMessageResponse {
  readonly ok: true;
  readonly channel: string;
  readonly ts: string;
  readonly message?: Readonly<Record<string, unknown>>;
  readonly warning?: string;
}

interface SlackApiBaseEnvelope {
  readonly ok?: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export function isValidSlackBotToken(token: string): boolean {
  return SLACK_BOT_TOKEN_RE.test(token.trim());
}

export function isValidSlackAppToken(token: string): boolean {
  return SLACK_APP_TOKEN_RE.test(token.trim());
}

export function assertValidSlackBotToken(token: string, connectorName?: string): string {
  const trimmed = token.trim();
  if (!isValidSlackBotToken(trimmed)) {
    throw new ConnectorValidationError(
      `Invalid Slack botToken: expected a token starting with "${SLACK_BOT_TOKEN_PREFIX}".`,
      { connectorName },
    );
  }
  return trimmed;
}

export function assertValidSlackAppToken(token: string, connectorName?: string): string {
  const trimmed = token.trim();
  if (!isValidSlackAppToken(trimmed)) {
    throw new ConnectorValidationError(
      `Invalid Slack appToken: expected an app-level token starting with "${SLACK_APP_TOKEN_PREFIX}".`,
      { connectorName },
    );
  }
  return trimmed;
}

export function sanitizeSlackBroadcastMentions(text: string): string {
  return text.replace(BROADCAST_MENTION_RE, "@$1");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function toAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
}

function waitAbortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(toAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(toAbortError(signal));
      },
      { once: true },
    );
  });
}

function isAuthErrorCode(code: string): boolean {
  return (SLACK_AUTH_ERROR_CODES as readonly string[]).includes(code);
}

function isRetryableErrorCode(code: string): boolean {
  return (SLACK_RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Lightweight zero-dependency Slack Web API client built on native `fetch`.
 *
 * @see https://docs.slack.dev/apis/web-api/
 */
export class SlackApiClient {
  private readonly botToken: string | undefined;
  private readonly appToken: string | undefined;
  private readonly apiBaseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly connectorName: string | undefined;
  private readonly sanitizeBroadcastMentions: boolean;

  constructor(options: SlackApiClientOptions) {
    this.connectorName = options.connectorName;
    this.botToken =
      options.botToken !== undefined
        ? assertValidSlackBotToken(options.botToken, options.connectorName)
        : undefined;
    this.appToken =
      options.appToken !== undefined
        ? assertValidSlackAppToken(options.appToken, options.connectorName)
        : undefined;

    if (this.botToken === undefined && this.appToken === undefined) {
      throw new ConnectorValidationError(
        "SlackApiClient requires at least one of botToken or appToken.",
        { connectorName: options.connectorName },
      );
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ConnectorValidationError("SlackApiClient timeoutMs must be a positive integer.", {
        connectorName: options.connectorName,
      });
    }

    const baseRaw = options.apiBaseUrl ?? DEFAULT_SLACK_API_BASE_URL;
    this.apiBaseUrl = new URL(baseRaw.endsWith("/") ? baseRaw : `${baseRaw}/`);
    this.timeoutMs = timeoutMs;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sanitizeBroadcastMentions = options.sanitizeBroadcastMentions ?? true;
  }

  /**
   * Verifies bot token credentials and retrieves workspace/bot identity via `auth.test`.
   *
   * @see https://docs.slack.dev/reference/methods/auth.test
   */
  async authTest(options?: { readonly signal?: AbortSignal }): Promise<SlackAuthTestResponse> {
    const payload = await this.request(SLACK_METHOD_AUTH_TEST, {
      tokenKind: "bot",
      signal: options?.signal,
    });

    const teamId = typeof payload["team_id"] === "string" ? payload["team_id"] : "";
    const userId = typeof payload["user_id"] === "string" ? payload["user_id"] : "";
    if (teamId.length === 0 || userId.length === 0) {
      throw new ConnectorTransportError(
        "Slack auth.test response did not include team_id and user_id.",
        { connectorName: this.connectorName },
      );
    }

    return {
      ok: true,
      team_id: teamId,
      user_id: userId,
      ...(typeof payload["url"] === "string" ? { url: payload["url"] } : {}),
      ...(typeof payload["team"] === "string" ? { team: payload["team"] } : {}),
      ...(typeof payload["user"] === "string" ? { user: payload["user"] } : {}),
      ...(typeof payload["bot_id"] === "string" ? { bot_id: payload["bot_id"] } : {}),
      ...(typeof payload["is_enterprise_install"] === "boolean"
        ? { is_enterprise_install: payload["is_enterprise_install"] }
        : {}),
    };
  }

  /**
   * Requests a dynamic Socket Mode WebSocket URL using an app-level token (`xapp-`).
   * Per Slack documentation, the token MUST be passed in the `Authorization` HTTP header
   * with `application/x-www-form-urlencoded` content type.
   *
   * @see https://docs.slack.dev/reference/methods/apps.connections.open
   */
  async openSocketConnection(options?: {
    readonly signal?: AbortSignal;
  }): Promise<SlackOpenConnectionResponse> {
    const payload = await this.request(SLACK_METHOD_OPEN_CONNECTION, {
      tokenKind: "app",
      signal: options?.signal,
    });

    const rawUrl = typeof payload["url"] === "string" ? payload["url"].trim() : "";
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      parsedUrl = undefined;
    }

    if (parsedUrl === undefined || parsedUrl.protocol !== SECURE_WS_PROTOCOL) {
      throw new ConnectorTransportError(
        "Slack apps.connections.open did not return a valid wss:// WebSocket URL.",
        { connectorName: this.connectorName },
      );
    }

    return {
      ok: true,
      url: parsedUrl.href,
    };
  }

  /**
   * Sends a message to a Slack channel, group, or DM via `chat.postMessage`,
   * preserving `thread_ts` thread affinity when supplied.
   *
   * @see https://docs.slack.dev/reference/methods/chat.postMessage/
   */
  async postMessage(
    request: SlackPostMessageRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SlackPostMessageResponse> {
    const channel = assertValidSlackChannelId(request.channel, this.connectorName);
    const threadTs =
      request.thread_ts !== undefined
        ? assertValidSlackTimestamp(request.thread_ts, this.connectorName)
        : undefined;
    if (request.text.trim().length === 0) {
      throw new ConnectorValidationError(
        "Slack chat.postMessage text must be a non-empty string.",
        { connectorName: this.connectorName },
      );
    }

    const text = this.sanitizeBroadcastMentions
      ? sanitizeSlackBroadcastMentions(request.text)
      : request.text;

    const body: Record<string, unknown> = {
      channel,
      text,
      mrkdwn: request.mrkdwn ?? true,
      unfurl_links: request.unfurl_links ?? false,
      unfurl_media: request.unfurl_media ?? false,
      link_names: request.link_names ?? false,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
      ...(request.reply_broadcast !== undefined
        ? { reply_broadcast: request.reply_broadcast }
        : {}),
    };

    const payload = await this.request(SLACK_METHOD_POST_MESSAGE, {
      tokenKind: "bot",
      jsonBody: body,
      signal: options?.signal,
    });

    const responseChannel =
      typeof payload["channel"] === "string" && payload["channel"].length > 0
        ? payload["channel"]
        : channel;
    const responseTs = typeof payload["ts"] === "string" ? payload["ts"] : "";
    if (responseTs.length === 0) {
      throw new ConnectorTransportError(
        "Slack chat.postMessage response did not include message timestamp (ts).",
        { connectorName: this.connectorName },
      );
    }

    return {
      ok: true,
      channel: responseChannel,
      ts: responseTs,
      ...(isPlainObject(payload["message"]) ? { message: payload["message"] } : {}),
      ...(typeof payload["warning"] === "string" ? { warning: payload["warning"] } : {}),
    };
  }

  private async request(
    method: string,
    options: {
      readonly tokenKind: "bot" | "app";
      readonly jsonBody?: Readonly<Record<string, unknown>>;
      readonly signal?: AbortSignal | undefined;
      readonly allowRateLimitRetry?: boolean;
    },
  ): Promise<SlackApiBaseEnvelope> {
    const token = options.tokenKind === "app" ? this.appToken : this.botToken;
    if (token === undefined) {
      throw new ConnectorAuthError(
        `Slack ${options.tokenKind} token is required to call "${method}".`,
        { connectorName: this.connectorName },
      );
    }

    const url = new URL(method, this.apiBaseUrl);
    const hasJsonBody = options.jsonBody !== undefined;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": hasJsonBody ? JSON_CONTENT_TYPE : FORM_CONTENT_TYPE,
        },
        ...(hasJsonBody ? { body: JSON.stringify(options.jsonBody) } : {}),
        signal: createRequestSignal(options.signal, this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const aborted = Boolean(options.signal?.aborted);
      throw new ConnectorTransportError(
        aborted
          ? `Slack "${method}" request was aborted.`
          : `Slack "${method}" network request failed.`,
        {
          connectorName: this.connectorName,
          retryable: !aborted,
          cause: error,
        },
      );
    }

    if (
      response.status === HTTP_STATUS_TOO_MANY_REQUESTS &&
      (options.allowRateLimitRetry ?? true)
    ) {
      const retryAfterRaw = Number(response.headers.get(SLACK_HEADER_RETRY_AFTER));
      const retrySeconds =
        Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
          ? retryAfterRaw
          : SLACK_DEFAULT_RETRY_AFTER_SEC;
      const delayMs = Math.min(
        SLACK_MAX_RETRY_DELAY_MS,
        Math.max(SLACK_MIN_RETRY_DELAY_MS, Math.round(retrySeconds * MILLISECONDS_PER_SECOND)),
      );
      await waitAbortableDelay(delayMs, options.signal);
      return this.request(method, {
        ...options,
        allowRateLimitRetry: false,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ConnectorTransportError(
        `Slack "${method}" returned invalid JSON (HTTP ${response.status}).`,
        {
          connectorName: this.connectorName,
          statusCode: response.status,
          retryable: response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR,
          cause,
        },
      );
    }

    if (!isPlainObject(payload)) {
      throw new ConnectorTransportError(`Slack "${method}" returned a non-object JSON payload.`, {
        connectorName: this.connectorName,
        statusCode: response.status,
        retryable: false,
      });
    }

    const slackError = typeof payload["error"] === "string" ? payload["error"] : undefined;
    if (
      response.status === HTTP_STATUS_UNAUTHORIZED ||
      response.status === HTTP_STATUS_FORBIDDEN ||
      (slackError !== undefined && isAuthErrorCode(slackError))
    ) {
      throw new ConnectorAuthError(
        `Slack "${method}" authentication/authorization failed: ${slackError ?? `HTTP ${response.status}`}.`,
        { connectorName: this.connectorName },
      );
    }

    if (!response.ok || payload["ok"] !== true) {
      const reason = slackError ?? `http_${response.status}`;
      const retryable =
        response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
        response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR ||
        (slackError !== undefined && isRetryableErrorCode(slackError));
      throw new ConnectorTransportError(`Slack "${method}" failed: ${reason}.`, {
        connectorName: this.connectorName,
        statusCode: response.status,
        retryable,
      });
    }

    return payload as SlackApiBaseEnvelope;
  }
}
