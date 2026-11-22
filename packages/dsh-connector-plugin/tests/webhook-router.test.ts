import { describe, expect, it } from "vitest";
import { DefaultContextSessionStore } from "../src/context-store";
import { ConnectorManager } from "../src/manager";
import { DshSessionDriver } from "../src/session-driver";
import { createStandaloneWebhookServer, mountConnectorWebhooks } from "../src/webhook-router";
import { MockAlertIngestConnector, MockWecomNotifyConnector } from "./mocks/mock-connectors";
import { MockDshHost } from "./mocks/mock-dsh-host";

describe("webhook-router", () => {
  it("registers prefix route with auth: 'anonymous' on DSH webServer", async () => {
    const host = new MockDshHost();
    const dshCtx = host.createContext();
    const manager = new ConnectorManager({
      connectors: [new MockAlertIngestConnector()],
      contextStore: new DefaultContextSessionStore(),
      sessionDriver: new DshSessionDriver(dshCtx),
    });
    await manager.startAll();

    const dispose = mountConnectorWebhooks(dshCtx.get("webServer")!, manager, {
      basePath: "/webhooks/connectors",
    });

    expect(host.registeredRoutes).toHaveLength(1);
    expect(host.registeredRoutes[0]?.auth).toBe("anonymous");
    expect(host.registeredRoutes[0]?.kind).toBe("prefix");
    expect(host.registeredRoutes[0]?.path).toBe("/webhooks/connectors");

    dispose();
    expect(host.registeredRoutes).toHaveLength(0);
    await manager.stopAll();
  });

  it("handles GET challenge (200), POST webhook (202), auth failure (401), unknown connector (404), and body limit (413) over real HTTP", async () => {
    const host = new MockDshHost();
    const dshCtx = host.createContext();
    const alerts = new MockAlertIngestConnector();
    const wecom = new MockWecomNotifyConnector();

    const manager = new ConnectorManager({
      connectors: [alerts, wecom],
      contextStore: new DefaultContextSessionStore(),
      sessionDriver: new DshSessionDriver(dshCtx, { defaultCwd: "/tmp/http-test" }),
    });
    await manager.startAll();

    const server = await createStandaloneWebhookServer(manager, {
      host: "127.0.0.1",
      port: 0,
      basePath: "/webhooks/connectors",
      maxBodyBytes: 256,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}/webhooks/connectors`;

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
    } finally {
      await server.close();
      await manager.stopAll();
    }
  });
});
