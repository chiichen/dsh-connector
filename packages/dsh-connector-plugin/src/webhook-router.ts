import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import type { ConnectorLogger, ConnectorWebhookRequest } from "@dsh-connector/core";
import {
  CONTENT_TYPE_TEXT_PLAIN,
  DEFAULT_WEBHOOK_BASE_PATH,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  WEBHOOK_OVERFLOW_DRAIN_MULTIPLIER,
} from "./constants";
import type { ConnectorManager } from "./manager";

const PLACEHOLDER_URL_ORIGIN = "http://localhost" as const;

export interface WebhookRouterOptions {
  readonly basePath?: string;
  readonly maxBodyBytes?: number;
  readonly logger?: ConnectorLogger;
}

class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`Webhook request body exceeds limit of ${limit} bytes.`);
    this.name = "PayloadTooLargeError";
  }
}

function normalizeBasePath(basePath: string): string {
  const withLeading = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return withLeading.length > 1 && withLeading.endsWith("/")
    ? withLeading.slice(0, -1)
    : withLeading;
}

async function readBoundedRawBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const declaredLenHeader = req.headers["content-length"];
  const declaredLen =
    typeof declaredLenHeader === "string" ? Number.parseInt(declaredLenHeader, 10) : Number.NaN;

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let exceeded = !Number.isNaN(declaredLen) && declaredLen > maxBytes;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      exceeded = true;
      if (totalBytes > maxBytes * WEBHOOK_OVERFLOW_DRAIN_MULTIPLIER) {
        break;
      }
      continue;
    }
    if (!exceeded) {
      chunks.push(buf);
    }
  }

  if (exceeded) {
    throw new PayloadTooLargeError(maxBytes);
  }

  return new Uint8Array(Buffer.concat(chunks, totalBytes));
}

function writeResponse(
  res: ServerResponse,
  status: number,
  headers?: Readonly<Record<string, string>>,
  body?: string | Uint8Array,
): void {
  if (headers !== undefined) {
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
  }
  res.statusCode = status;
  if (body !== undefined) {
    res.end(body);
  } else {
    res.end();
  }
}

export function createWebhookHttpHandler(
  manager: ConnectorManager,
  options?: WebhookRouterOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const basePath = normalizeBasePath(options?.basePath ?? DEFAULT_WEBHOOK_BASE_PATH);
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const rawUrl = req.url ?? "/";
      const parsedUrl = new URL(rawUrl, PLACEHOLDER_URL_ORIGIN);
      const pathname = parsedUrl.pathname;

      const prefixWithSlash = `${basePath}/`;
      if (!pathname.startsWith(prefixWithSlash)) {
        writeResponse(
          res,
          HTTP_STATUS_NOT_FOUND,
          { "content-type": CONTENT_TYPE_TEXT_PLAIN },
          "Not Found",
        );
        return;
      }

      const remainder = pathname.slice(prefixWithSlash.length);
      const slashIndex = remainder.indexOf("/");
      const connectorName = decodeURIComponent(
        slashIndex === -1 ? remainder : remainder.slice(0, slashIndex),
      );
      const subPath = slashIndex === -1 ? "/" : remainder.slice(slashIndex);

      if (connectorName.length === 0) {
        writeResponse(
          res,
          HTTP_STATUS_NOT_FOUND,
          { "content-type": CONTENT_TYPE_TEXT_PLAIN },
          "Not Found",
        );
        return;
      }

      const receiver = manager.getReceiver(connectorName);
      if (receiver?.handleWebhook === undefined) {
        writeResponse(
          res,
          HTTP_STATUS_NOT_FOUND,
          { "content-type": CONTENT_TYPE_TEXT_PLAIN },
          `Webhook connector "${connectorName}" not found.`,
        );
        return;
      }

      let rawBody: Uint8Array;
      try {
        rawBody = await readBoundedRawBody(req, maxBodyBytes);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          writeResponse(
            res,
            HTTP_STATUS_PAYLOAD_TOO_LARGE,
            { "content-type": CONTENT_TYPE_TEXT_PLAIN, connection: "close" },
            error.message,
          );
          return;
        }
        throw error;
      }

      const webhookReq: ConnectorWebhookRequest = {
        method: (req.method ?? "GET").toUpperCase(),
        pathname,
        subPath,
        query: parsedUrl.searchParams,
        headers: req.headers,
        rawBody,
      };

      const webhookRes = await receiver.handleWebhook(webhookReq);
      writeResponse(res, webhookRes.status, webhookRes.headers, webhookRes.body);
    } catch (error) {
      options?.logger?.error("Unhandled error in connector webhook router", {
        error: String(error),
      });
      if (!res.headersSent) {
        writeResponse(
          res,
          HTTP_STATUS_INTERNAL_SERVER_ERROR,
          { "content-type": CONTENT_TYPE_TEXT_PLAIN },
          "Internal Server Error",
        );
      } else {
        res.end();
      }
    }
  };
}

/**
 * Mounts connector webhook routes onto DSH's built-in `@deepseek-ai/dsh-host-webserver`
 * `WebServer` (`ctx.webServer`) as a prefix route.
 */
export function mountConnectorWebhooks(
  webServer: WebServer,
  manager: ConnectorManager,
  options?: WebhookRouterOptions,
): () => void {
  const basePath = normalizeBasePath(options?.basePath ?? DEFAULT_WEBHOOK_BASE_PATH);
  const handler = createWebhookHttpHandler(manager, options);

  return webServer.register({
    kind: "prefix",
    path: basePath,
    handler,
  });
}
