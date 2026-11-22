import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectorLogger, ConnectorWebhookRequest } from "@dsh-connector/core";
import type { DshWebServerLike } from "./dsh-types";
import type { ConnectorManager } from "./manager";

const DEFAULT_BASE_PATH = "/webhooks/connectors";
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface WebhookRouterOptions {
  readonly basePath?: string;
  readonly maxBodyBytes?: number;
  readonly logger?: ConnectorLogger;
}

export interface StandaloneWebhookServerOptions extends WebhookRouterOptions {
  readonly host?: string;
  readonly port: number;
}

export interface StandaloneWebhookServerHandle {
  readonly port: number;
  close(): Promise<void>;
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
      if (totalBytes > maxBytes * 4) {
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
  const basePath = normalizeBasePath(options?.basePath ?? DEFAULT_BASE_PATH);
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const rawUrl = req.url ?? "/";
      const parsedUrl = new URL(rawUrl, "http://localhost");
      const pathname = parsedUrl.pathname;

      const prefixWithSlash = `${basePath}/`;
      if (!pathname.startsWith(prefixWithSlash)) {
        writeResponse(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not Found");
        return;
      }

      const remainder = pathname.slice(prefixWithSlash.length);
      const slashIndex = remainder.indexOf("/");
      const connectorName = decodeURIComponent(
        slashIndex === -1 ? remainder : remainder.slice(0, slashIndex),
      );
      const subPath = slashIndex === -1 ? "/" : remainder.slice(slashIndex);

      if (connectorName.length === 0) {
        writeResponse(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not Found");
        return;
      }

      const receiver = manager.getReceiver(connectorName);
      if (receiver?.handleWebhook === undefined) {
        writeResponse(
          res,
          404,
          { "content-type": "text/plain; charset=utf-8" },
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
            413,
            { "content-type": "text/plain; charset=utf-8", connection: "close" },
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
          500,
          { "content-type": "text/plain; charset=utf-8" },
          "Internal Server Error",
        );
      } else {
        res.end();
      }
    }
  };
}

export function mountConnectorWebhooks(
  webServer: DshWebServerLike,
  manager: ConnectorManager,
  options?: WebhookRouterOptions,
): () => void {
  const basePath = normalizeBasePath(options?.basePath ?? DEFAULT_BASE_PATH);
  const handler = createWebhookHttpHandler(manager, options);

  return webServer.register({
    kind: "prefix",
    path: basePath,
    auth: "anonymous",
    handler,
  });
}

export async function createStandaloneWebhookServer(
  manager: ConnectorManager,
  options: StandaloneWebhookServerOptions,
): Promise<StandaloneWebhookServerHandle> {
  const handler = createWebhookHttpHandler(manager, options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  const host = options.host ?? "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined && err !== null) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
  };
}
