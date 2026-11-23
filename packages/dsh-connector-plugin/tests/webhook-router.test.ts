import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector, type ConnectorLogger } from "@dsh-connector/core";
import { DefaultContextSessionStore } from "../src/context-store";
import { ConnectorManager } from "../src/manager";
import { DshSessionDriver } from "../src/session-driver";
import { createWebhookHttpHandler, mountConnectorWebhooks } from "../src/webhook-router";
import { MockAlertIngestConnector, MockWecomNotifyConnector } from "./mocks/mock-connectors";
import { TestDshHost } from "./mocks/mock-dsh-host";

interface MockHttpCapture {
  readonly res: ServerResponse;
  statusCode: number;
  readonly headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function createMockServerResponse(options?: { readonly headersSent?: boolean }): MockHttpCapture {
  const capture: MockHttpCapture = {
    res: undefined as unknown as ServerResponse,
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
  };

  const res = {
    headersSent: options?.headersSent ?? false,
    get statusCode() {
      return capture.statusCode;
    },
    set statusCode(code: number) {
      capture.statusCode = code;
    },
    setHeader(key: string, value: string) {
      capture.headers[key.toLowerCase()] = value;
      return res;
    },
    end(chunk?: string | Uint8Array) {
      capture.ended = true;
      if (typeof chunk === "string") {
        capture.body += chunk;
      } else if (chunk instanceof Uint8Array) {
        capture.body += Buffer.from(chunk).toString("utf8");
      }
      return res;
    },
  } as unknown as ServerResponse;

  (capture as { res: ServerResponse }).res = res;
  return capture;
}

function createMockIncomingRequest(options: {
  readonly url?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chunks?: ReadonlyArray<Buffer | Uint8Array>;
  readonly streamError?: Error;
}): IncomingMessage {
  const chunks = options.chunks ?? [];
  return {
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.method !== undefined ? { method: options.method } : {}),
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
      if (options.streamError !== undefined) {
        throw options.streamError;
      }
    },
  } as unknown as IncomingMessage;
}

describe("webhook-router over real @deepseek-ai/dsh-host-webserver", () => {
  it("reuses DSH built-in WebServer for GET challenge (200), POST webhook (202), auth failure (401), unknown connector (404), body limit (413), and route disposal", async () => {
    const host = await TestDshHost.start({ withWebServer: true });
    const alerts = new MockAlertIngestConnector();
    const wecom = new MockWecomNotifyConnector();

    const manager = new ConnectorManager({
      connectors: [alerts, wecom],
      contextStore: new DefaultContextSessionStore(),
      sessionDriver: new DshSessionDriver(host.ctx, { defaultCwd: "/tmp/http-test" }),
    });
    await manager.startAll();

    const disposeRoute = mountConnectorWebhooks(host.ctx.webServer, manager, {
      basePath: "/webhooks/connectors",
      maxBodyBytes: 256,
    });

    try {
      const baseUrl = `${host.ctx.webServer.getOrigin()}/webhooks/connectors`;

      // 1. Synchronous GET Challenge verification (200)
      const challengeRes = await fetch(`${baseUrl}/alertmanager?echostr=challenge-xyz`);
      expect(challengeRes.status).toBe(200);
      expect(await challengeRes.text()).toBe("challenge-xyz");

      // 2. Unauthorized signature/token (401)
      const unauthRes = await fetch(`${baseUrl}/alertmanager`, {
        method: "POST",
        body: JSON.stringify({ severity: "warning", message: "disk" }),
      });
      expect(unauthRes.status).toBe(401);

      // 3. Valid signed webhook (202) -> creates DSH session and delivers prompt
      const okRes = await fetch(`${baseUrl}/alertmanager/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-alert-token": "secret-token",
          "x-delivery-id": "evt-http-1",
        },
        body: JSON.stringify({
          severity: "critical",
          fingerprint: "oom-node-1",
          message: "Node memory > 95%",
        }),
      });
      expect(okRes.status).toBe(202);
      const okJson = (await okRes.json()) as { sessionId: string };
      expect(okJson.sessionId).toMatch(/^session-/);
      expect(host.prompts).toHaveLength(1);

      // 4. Unknown connector or send-only connector without handleWebhook -> 404
      const notFound1 = await fetch(`${baseUrl}/non-existent`, { method: "POST", body: "{}" });
      expect(notFound1.status).toBe(404);
      const notFound2 = await fetch(`${baseUrl}/wecom`, { method: "POST", body: "{}" });
      expect(notFound2.status).toBe(404);

      // 5. Oversized payload exceeding maxBodyBytes (256 bytes) -> 413
      const hugeRes = await fetch(`${baseUrl}/alertmanager`, {
        method: "POST",
        headers: { "x-alert-token": "secret-token" },
        body: "x".repeat(512),
      });
      expect(hugeRes.status).toBe(413);

      // 6. Disposing the route unregisters from WebServer while keeping DSH WebServer alive
      disposeRoute();
      const afterDispose = await fetch(`${baseUrl}/alertmanager?echostr=challenge-xyz`);
      expect(afterDispose.status).toBe(404);

      // 7. Default options mount (/webhooks/connectors)
      const disposeDefaultRoute = mountConnectorWebhooks(host.ctx.webServer, manager);
      const defaultRes = await fetch(`${baseUrl}/alertmanager?echostr=default-ok`);
      expect(defaultRes.status).toBe(200);
      disposeDefaultRoute();
    } finally {
      await manager.stopAll();
      await host.stop();
    }
  });

  it("handles normalizeBasePath variants, missing url/method, empty connector segment, 204 empty responses, Uint8Array overflow drain, stream errors, and headersSent 500 guard", async () => {
    const host = await TestDshHost.start();
    try {
      const loggedErrors: Array<{ message: string; meta?: Readonly<Record<string, unknown>> }> = [];
      const logger: ConnectorLogger = {
        debug() {},
        info() {},
        warn() {},
        error(message, meta) {
          loggedErrors.push({ message, ...(meta !== undefined ? { meta } : {}) });
        },
      };

      let handlerMode: "204-empty" | "uint8-echo" | "throw-error" = "204-empty";
      const customWebhookConnector = defineConnector({
        name: "hook-svc",
        getSender: () => undefined,
        getReceiver: () => ({
          schema: z.object({}),
          async handleWebhook(req) {
            if (handlerMode === "throw-error") {
              throw new Error("handler crashed");
            }
            if (handlerMode === "uint8-echo") {
              return {
                status: 200,
                body: req.rawBody,
              };
            }
            return { status: 204 };
          },
        }),
      });

      const manager = new ConnectorManager({
        connectors: [customWebhookConnector],
        contextStore: new DefaultContextSessionStore(),
        sessionDriver: new DshSessionDriver(host.ctx),
      });
      await manager.startAll();

      // Custom basePath without leading slash and with trailing slash -> normalized to "/custom-hooks"
      const handler = createWebhookHttpHandler(manager, {
        basePath: "custom-hooks/",
        maxBodyBytes: 10,
        logger,
      });

      // Missing req.url -> defaults to "/" -> outside "/custom-hooks/" -> 404
      const missingUrlRes = createMockServerResponse();
      await handler(createMockIncomingRequest({}), missingUrlRes.res);
      expect(missingUrlRes.statusCode).toBe(404);

      // Empty connector segment ("/custom-hooks//events") -> 404
      const emptySegRes = createMockServerResponse();
      await handler(createMockIncomingRequest({ url: "/custom-hooks//events" }), emptySegRes.res);
      expect(emptySegRes.statusCode).toBe(404);

      // Undefined req.method (defaults to GET) + 204 response with undefined headers and body
      const empty204Res = createMockServerResponse();
      await handler(createMockIncomingRequest({ url: "/custom-hooks/hook-svc" }), empty204Res.res);
      expect(empty204Res.statusCode).toBe(204);
      expect(empty204Res.ended).toBe(true);
      expect(empty204Res.body).toBe("");

      // Non-Buffer Uint8Array body chunks within maxBodyBytes
      handlerMode = "uint8-echo";
      const uint8Res = createMockServerResponse();
      await handler(
        createMockIncomingRequest({
          url: "/custom-hooks/hook-svc",
          method: "post",
          chunks: [new Uint8Array([104, 105])],
        }),
        uint8Res.res,
      );
      expect(uint8Res.statusCode).toBe(200);
      expect(uint8Res.body).toBe("hi");

      // Declared content-length > maxBytes with small body chunk -> skips buffering (!exceeded false branch) and returns 413
      const declaredOverflowRes = createMockServerResponse();
      await handler(
        createMockIncomingRequest({
          url: "/custom-hooks/hook-svc",
          method: "POST",
          headers: { "content-length": "999" },
          chunks: [Buffer.from("ab")],
        }),
        declaredOverflowRes.res,
      );
      expect(declaredOverflowRes.statusCode).toBe(413);
      // Streaming overflow without content-length exceeding maxBytes * WEBHOOK_OVERFLOW_DRAIN_MULTIPLIER
      const drainBreakRes = createMockServerResponse();
      await handler(
        createMockIncomingRequest({
          url: "/custom-hooks/hook-svc",
          method: "POST",
          chunks: [Buffer.from("123456"), Buffer.from("789012"), Buffer.from("x".repeat(30))],
        }),
        drainBreakRes.res,
      );
      expect(drainBreakRes.statusCode).toBe(413);

      // Request stream throws non-PayloadTooLargeError -> 500 Internal Server Error + logger.error
      const streamErrRes = createMockServerResponse();
      await handler(
        createMockIncomingRequest({
          url: "/custom-hooks/hook-svc",
          method: "POST",
          streamError: new Error("socket reset by peer"),
        }),
        streamErrRes.res,
      );
      expect(streamErrRes.statusCode).toBe(500);
      expect(streamErrRes.body).toBe("Internal Server Error");
      expect(loggedErrors).toHaveLength(1);

      // Handler throws when res.headersSent is already true -> calls res.end() without 500 status override
      handlerMode = "throw-error";
      const headersSentRes = createMockServerResponse({ headersSent: true });
      await handler(
        createMockIncomingRequest({ url: "/custom-hooks/hook-svc" }),
        headersSentRes.res,
      );
      expect(headersSentRes.statusCode).toBe(200);
      expect(headersSentRes.ended).toBe(true);

      // Root basePath "/" normalization check + default options handler
      const rootHandler = createWebhookHttpHandler(manager, { basePath: "/" });
      const rootNotFound = createMockServerResponse();
      await rootHandler(createMockIncomingRequest({ url: "//missing" }), rootNotFound.res);
      expect(rootNotFound.statusCode).toBe(404);

      const defaultHandler = createWebhookHttpHandler(manager);
      const defaultNotFound = createMockServerResponse();
      await defaultHandler(createMockIncomingRequest({ url: "/other" }), defaultNotFound.res);
      expect(defaultNotFound.statusCode).toBe(404);

      await manager.stopAll();
    } finally {
      await host.stop();
    }
  });
});
