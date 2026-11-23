import { ConnectorTransportError, ConnectorValidationError } from "@dsh-connector/core";
import {
  DINGTALK_DEFAULT_HTTP_TIMEOUT_MS,
  DINGTALK_MAX_CACHED_SESSION_WEBHOOKS,
  DINGTALK_STREAM_CONTENT_TYPE_JSON,
  DINGTALK_TRUSTED_DOMAIN,
  DINGTALK_TRUSTED_SUBDOMAIN_SUFFIX,
  HTTP_STATUS_SERVER_ERROR_MIN,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTPS_DEFAULT_PORT,
  HTTPS_PROTOCOL,
} from "./constants";
import type { DingTalkSessionWebhookRecord } from "./types";

export interface DingTalkHttpJsonOptions {
  readonly connectorName: string;
  readonly fetchFn: typeof fetch;
  readonly url: string;
  readonly method?: "POST" | "PUT" | "GET";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DingTalkHttpJsonResult {
  readonly status: number;
  readonly ok: boolean;
  readonly data: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSignalAborted(signal?: AbortSignal): signal is AbortSignal {
  return signal?.aborted === true;
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === HTTP_STATUS_TOO_MANY_REQUESTS || status >= HTTP_STATUS_SERVER_ERROR_MIN;
}

export function extractProviderErrorDetail(data: Record<string, unknown>): string | undefined {
  const code =
    typeof data["code"] === "string" || typeof data["code"] === "number"
      ? String(data["code"])
      : typeof data["errcode"] === "string" || typeof data["errcode"] === "number"
        ? String(data["errcode"])
        : undefined;
  const msg =
    typeof data["message"] === "string"
      ? data["message"]
      : typeof data["errmsg"] === "string"
        ? data["errmsg"]
        : undefined;

  if (code !== undefined && msg !== undefined) {
    return `${code}: ${msg}`;
  }
  return code ?? msg;
}

/**
 * Executes a JSON HTTP call against DingTalk OpenAPI or `sessionWebhook` with timeout and `AbortSignal` propagation.
 */
export async function requestDingTalkJson(
  options: DingTalkHttpJsonOptions,
): Promise<DingTalkHttpJsonResult> {
  const timeoutMs = options.timeoutMs ?? DINGTALK_DEFAULT_HTTP_TIMEOUT_MS;
  if (options.signal?.aborted === true) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new ConnectorTransportError("DingTalk HTTP request aborted before start.", {
          connectorName: options.connectorName,
          retryable: false,
        });
  }

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  try {
    const response = await options.fetchFn(options.url, {
      method: options.method ?? "POST",
      headers: {
        accept: DINGTALK_STREAM_CONTENT_TYPE_JSON,
        "content-type": DINGTALK_STREAM_CONTENT_TYPE_JSON,
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "error",
      signal: controller.signal,
    });

    const rawText = await response.text();
    let parsedData: Record<string, unknown> = {};
    if (rawText.trim().length > 0) {
      try {
        const json: unknown = JSON.parse(rawText);
        if (isPlainRecord(json)) {
          parsedData = json;
        }
      } catch (cause) {
        if (response.ok) {
          throw new ConnectorTransportError(
            `DingTalk endpoint returned non-JSON response (HTTP ${response.status}).`,
            {
              connectorName: options.connectorName,
              statusCode: response.status,
              retryable: false,
              cause,
            },
          );
        }
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      data: parsedData,
    };
  } catch (error) {
    if (isSignalAborted(options.signal)) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new ConnectorTransportError("DingTalk HTTP request aborted.", {
            connectorName: options.connectorName,
            retryable: false,
            cause: error,
          });
    }
    if (timedOut) {
      throw new ConnectorTransportError(`DingTalk HTTP request timed out after ${timeoutMs}ms.`, {
        connectorName: options.connectorName,
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof ConnectorTransportError) {
      throw error;
    }
    throw new ConnectorTransportError(
      `DingTalk HTTP network request failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        connectorName: options.connectorName,
        retryable: true,
        cause: error,
      },
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Validates and normalizes a DingTalk `sessionWebhook` URL so outbound webhook calls only
 * target trusted HTTPS `dingtalk.com` / `*.dingtalk.com` hosts without credentials or custom ports.
 *
 * @see https://open.dingtalk.com/document/orgapp/receive-message.md
 */
export function normalizeDingTalkSessionWebhook(rawUrl: string, connectorName?: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (cause) {
    throw new ConnectorValidationError("Invalid DingTalk sessionWebhook URL.", {
      connectorName,
      cause,
    });
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const isTrustedHost =
    host === DINGTALK_TRUSTED_DOMAIN || host.endsWith(DINGTALK_TRUSTED_SUBDOMAIN_SUFFIX);

  if (
    parsed.protocol !== HTTPS_PROTOCOL ||
    !isTrustedHost ||
    (parsed.port !== "" && parsed.port !== HTTPS_DEFAULT_PORT) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new ConnectorValidationError(
      `Untrusted DingTalk sessionWebhook URL "${trimmed}": must be an HTTPS *.dingtalk.com endpoint.`,
      { connectorName },
    );
  }

  parsed.hash = "";
  return parsed.toString();
}

export interface SessionWebhookCacheOptions {
  readonly now?: () => number;
  readonly maxEntries?: number;
}

/**
 * Bounded TTL cache storing unexpired `sessionWebhook` URLs received on inbound DingTalk robot messages.
 */
export class SessionWebhookCache {
  private readonly entries = new Map<string, DingTalkSessionWebhookRecord>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options?: SessionWebhookCacheOptions) {
    this.now = options?.now ?? (() => Date.now());
    this.maxEntries = Math.max(1, options?.maxEntries ?? DINGTALK_MAX_CACHED_SESSION_WEBHOOKS);
  }

  set(contextId: string, sessionWebhook: string, expiresAt: number): void {
    const normalized = normalizeDingTalkSessionWebhook(sessionWebhook);
    if (expiresAt <= this.now()) {
      this.entries.delete(contextId);
      return;
    }

    if (this.entries.has(contextId)) {
      this.entries.delete(contextId);
    }
    this.entries.set(contextId, { sessionWebhook: normalized, expiresAt });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string;
      this.entries.delete(oldestKey);
    }
  }

  get(contextId: string): DingTalkSessionWebhookRecord | undefined {
    const entry = this.entries.get(contextId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(contextId);
      return undefined;
    }
    return entry;
  }
}
