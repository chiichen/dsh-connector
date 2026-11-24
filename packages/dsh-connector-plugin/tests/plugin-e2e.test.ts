import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONNECTOR_CORE_VERSION,
  createDefaultContextIdGenerator,
  defineConnector,
  type ConnectorLogger,
  type ConnectorReceiverContext,
} from "@dsh-connector/core";
import {
  apply,
  Config,
  createConnectorPlugin,
  DefaultContextSessionStore,
  DSH_CONNECTOR_PLUGIN_VERSION,
  inject,
  mountConnectorPlugin,
  name,
} from "../src";
import {
  MockAlertIngestConnector,
  MockGithubPrConnector,
  MockWecomBotConnector,
} from "./mocks/mock-connectors";
import { createTestToolRunContext, TestDshHost } from "./mocks/mock-dsh-host";

describe("dsh-connector-plugin Cordis E2E integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exposes standard Cordis plugin metadata (name, inject, Config, apply) and runs full WebServer + ToolsService + Quote closed loop", async () => {
    expect(name).toBe("dsh-connector-plugin");
    expect(inject).toEqual(["agents", "sessions", "tools", "storageDomain"]);
    expect(typeof Config).toBe("function");
    expect(typeof apply).toBe("function");

    const host = await TestDshHost.start({ withWebServer: true });
    const github = new MockGithubPrConnector();
    const wecom = new MockWecomBotConnector();
    const alerts = new MockAlertIngestConnector();

    const plugin = createConnectorPlugin({
      connectors: [github, wecom, alerts],
    });

    await plugin.apply(host.ctx);

    const registeredTools = host.ctx.tools
      .definitions()
      .map((def) => def.name)
      .sort();
    expect(registeredTools).toEqual(["connector_send_github", "connector_send_wecom"]);

    const origin = host.ctx.webServer.getOrigin();

    const ghResp = await fetch(`${origin}/webhooks/connectors/github/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "deepseek/dsh",
        prNumber: 88,
        eventId: "gh-evt-88-1",
        author: "alice",
        commentBody: "Investigate pod OOMKilled",
      }),
    });
    expect(ghResp.status).toBe(202);

    expect(host.prompts).toHaveLength(1);
    const sessionId = host.prompts[0]!.sessionId;
    expect(sessionId.startsWith("session-")).toBe(true);
    expect(host.persistedSessions.get(sessionId)?.title).toBe("PR deepseek/dsh#88");

    const ghTool = host.ctx.tools.get("connector_send_github")!;
    const wecomTool = host.ctx.tools.get("connector_send_wecom")!;

    await ghTool.execute(
      { body: "Acknowledge #88, investigating now." },
      createTestToolRunContext({ sessionId }),
    );
    await ghTool.execute(
      { repo: "deepseek/dsh", prNumber: 89, body: "Linking related incident #89." },
      createTestToolRunContext({ sessionId }),
    );
    await wecomTool.execute(
      { text: "Alerting SRE channel: investigating GitHub #88." },
      createTestToolRunContext({ sessionId }),
    );

    expect(github.postedComments).toHaveLength(2);
    expect(github.postedComments[0]).toMatchObject({
      repo: "deepseek/dsh",
      prNumber: 88,
    });
    expect(github.postedComments[0]!.encodedBody).toContain("Acknowledge #88, investigating now.");
    expect(github.postedComments[1]).toMatchObject({
      repo: "deepseek/dsh",
      prNumber: 89,
    });

    expect(wecom.sentMessages).toHaveLength(1);
    const wecomWireText = wecom.sentMessages[0]!.wireText;
    expect(wecomWireText).toContain("<!-- dsh-ctx:");

    const wecomQuoteResp = await fetch(`${origin}/webhooks/connectors/wecom/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        msgId: "wecom-reply-1",
        text: `${wecomWireText
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\nHeap dump uploaded to OSS bucket.`,
      }),
    });
    expect(wecomQuoteResp.status).toBe(202);

    expect(host.prompts).toHaveLength(2);
    expect(host.prompts[1]!.sessionId).toBe(sessionId);
    expect(host.prompts[1]!.text).not.toContain("dsh-ctx:");
    expect(host.prompts[1]!.text).toContain("Heap dump uploaded to OSS bucket.");

    await host.stop();
    expect(github.stopped).toBe(true);
    expect(wecom.stopped).toBe(true);
    expect(alerts.stopped).toBe(true);
  });

  it("activates through Cordis plugin loading without an invalid effect", async () => {
    const host = await TestDshHost.start({ withWebServer: false });
    try {
      await host.ctx.plugin({
        name,
        inject,
        Config,
        apply,
      });
    } finally {
      await host.stop();
    }
  });

  it("persists and reloads ContextSessionStore across cold host restarts via real ctx.storageDomain", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "dsh-plugin-domain-"));
    tempDirs.push(storageRoot);

    const host1 = await TestDshHost.start({ storageRoot, withWebServer: true });
    const github1 = new MockGithubPrConnector();

    const runtime1 = await mountConnectorPlugin(host1.ctx, {
      connectors: [github1],
    });

    const resp1 = await fetch(
      `${host1.ctx.webServer.getOrigin()}/webhooks/connectors/github/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: "deepseek/dsh",
          prNumber: 101,
          eventId: "gh-101-a",
          author: "bob",
          commentBody: "Initial bug report",
        }),
      },
    );
    expect(resp1.status).toBe(202);
    const originalSessionId = host1.prompts[0]!.sessionId;
    const savedPersistedSessions = new Map<SessionId, { cwd: string; title?: string }>(
      host1.persistedSessions,
    );

    await runtime1.dispose();
    await host1.stop({ keepStorageDir: true });

    // Cold host restart (headless mode, no sessionController) over the same storageRoot
    const host2 = await TestDshHost.start({
      storageRoot,
      useSessionController: false,
      withWebServer: true,
      persistedSessions: savedPersistedSessions,
    });
    const github2 = new MockGithubPrConnector();
    const runtime2 = await mountConnectorPlugin(host2.ctx, {
      connectors: [github2],
    });

    const resp2 = await fetch(
      `${host2.ctx.webServer.getOrigin()}/webhooks/connectors/github/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: "deepseek/dsh",
          prNumber: 101,
          eventId: "gh-101-b",
          author: "bob",
          commentBody: "Follow-up after cold process restart",
        }),
      },
    );
    expect(resp2.status).toBe(202);
    expect(host2.prompts).toHaveLength(1);
    expect(host2.prompts[0]!.sessionId).toBe(originalSessionId);
    expect(host2.prompts[0]!.text).toContain("Follow-up after cold process restart");

    await runtime2.dispose();
    await host2.stop({ keepStorageDir: true });
  });

  it("covers plugin config options, Cordis logger adapter, mount rollback, idempotent dispose, and fiber mid-mount disposal", async () => {
    expect(DSH_CONNECTOR_PLUGIN_VERSION).toBe(CONNECTOR_CORE_VERSION);

    const host = await TestDshHost.start({ withWebServer: true });
    try {
      // 1. Default mountConnectorPlugin(ctx) + Cordis logger adapter (with and without meta)
      const emptyRuntime = await mountConnectorPlugin(host.ctx);
      await emptyRuntime.dispose();
      // Second dispose is a safe no-op
      await emptyRuntime.dispose();

      let capturedLogger: ConnectorReceiverContext["logger"] | undefined;
      const loggerProbeConnector = defineConnector({
        name: "logger-probe",
        getSender: () => undefined,
        getReceiver: () => ({
          schema: z.object({}),
          init(ctx) {
            capturedLogger = ctx.logger;
          },
        }),
      });

      const disposeProbe = await apply(host.ctx, { connectors: [loggerProbeConnector] });
      expect(capturedLogger).toBeDefined();
      capturedLogger!.debug("dbg plain");
      capturedLogger!.debug("dbg meta", { a: 1 });
      capturedLogger!.info("info plain");
      capturedLogger!.info("info meta", { a: 1 });
      capturedLogger!.warn("warn plain");
      capturedLogger!.warn("warn meta", { a: 1 });
      capturedLogger!.error("err plain");
      capturedLogger!.error("err meta", { a: 1 });
      await disposeProbe();

      // 2. Explicit contextStore, explicit logger, custom toolNamePrefix, deduplication, workspaceId, webhook disabled
      const customStore = new DefaultContextSessionStore();
      const explicitLogger: ConnectorLogger = {
        debug() {},
        info() {},
        warn() {},
        error() {},
      };
      const github = new MockGithubPrConnector();
      const customRuntime = await mountConnectorPlugin(host.ctx, {
        connectors: [github],
        contextStore: customStore,
        defaultSessionCwd: "/tmp/custom-cwd",
        workspaceId: "ws-custom",
        contextIdGenerator: createDefaultContextIdGenerator(),
        toolNamePrefix: "custom_send_",
        deduplication: { ttlMs: 5_000, maxEntries: 100 },
        webhook: { enabled: false },
        logger: explicitLogger,
      });
      expect(customRuntime.contextStore).toBe(customStore);
      expect(host.ctx.tools.get("custom_send_github")).toBeDefined();
      await customRuntime.dispose();

      // 3. createConnectorPlugin webhook config merge (basePath + maxBodyBytes)
      const alerts = new MockAlertIngestConnector();
      const mergedPlugin = createConnectorPlugin({
        connectors: [alerts],
        webhook: { basePath: "/custom-hooks" },
      });
      const disposeMerged = await mergedPlugin.apply(host.ctx, {
        webhook: { maxBodyBytes: 1024 },
      });
      const customChallenge = await fetch(
        `${host.ctx.webServer.getOrigin()}/custom-hooks/alertmanager?echostr=merged-ok`,
      );
      expect(customChallenge.status).toBe(200);
      expect(await customChallenge.text()).toBe("merged-ok");
      await disposeMerged();

      // 4. mountConnectorPlugin rollback when connector.start() throws
      const brokenConnector = defineConnector({
        name: "broken-start",
        getSender: () => undefined,
        getReceiver: () => undefined,
        start() {
          throw new Error("start failed during mount");
        },
      });
      await expect(
        mountConnectorPlugin(host.ctx, {
          connectors: [brokenConnector],
          contextStore: new DefaultContextSessionStore(),
          webhook: { enabled: false },
        }),
      ).rejects.toThrow("start failed during mount");
    } finally {
      await host.stop();
    }

    // 5. apply() when Cordis context is disposed while async connector start() is still in flight
    const raceHost = await TestDshHost.start({ withWebServer: false });
    try {
      // Default apply(ctx) with no second argument before disposing raceHost
      const disposeDefault = await apply(raceHost.ctx);
      await disposeDefault();

      let releaseStart!: () => void;
      let stoppedAfterRace = false;
      const slowConnector = defineConnector({
        name: "slow-mount",
        getSender: () => undefined,
        getReceiver: () => undefined,
        async start() {
          await new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
        },
        stop() {
          stoppedAfterRace = true;
        },
      });

      const applyPromise = apply(raceHost.ctx, {
        connectors: [slowConnector],
        contextStore: new DefaultContextSessionStore(),
        webhook: { enabled: false },
      });

      // Wait briefly so slowConnector.start() is awaiting releaseStart
      await new Promise((resolve) => setTimeout(resolve, 15));

      // Dispose raceHost's fiber while apply() is suspended in mountConnectorPlugin -> sets state.disposed = true!
      const disposeHostPromise = raceHost.ctx.fiber.dispose();
      releaseStart();

      await applyPromise;
      await disposeHostPromise;
      expect(stoppedAfterRace).toBe(true);
    } finally {
      await raceHost.stop();
    }
  });
});
