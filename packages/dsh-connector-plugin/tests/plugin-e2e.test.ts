import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  apply,
  createConnectorPlugin,
  inject,
  mountConnectorPlugin,
  name,
  type PersistedContextRecord,
} from "../src";
import {
  MockAlertIngestConnector,
  MockGithubPrConnector,
  MockWecomBotConnector,
} from "./mocks/mock-connectors";
import { MockDshHost } from "./mocks/mock-dsh-host";

describe("dsh-connector-plugin Cordis E2E integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exposes standard Cordis plugin metadata (name, inject, apply) and runs full HTTP + Agent Tool + Quote closed loop", async () => {
    expect(name).toBe("dsh-connector-plugin");
    expect(inject).toEqual(["agents", "sessions", "tools"]);
    expect(typeof apply).toBe("function");

    const host = new MockDshHost();
    const ctx = host.createContext();

    const github = new MockGithubPrConnector();
    const wecom = new MockWecomBotConnector();
    const alerts = new MockAlertIngestConnector();

    const plugin = createConnectorPlugin({
      connectors: [github, wecom, alerts],
      webhook: {
        standalone: { host: "127.0.0.1", port: 0 },
      },
    });

    const runtime = await plugin.apply(ctx);
    expect(runtime.standaloneWebhookPort).toBeGreaterThan(0);

    expect([...host.registeredTools.keys()].sort()).toEqual([
      "connector_send_github",
      "connector_send_wecom",
    ]);
    expect(host.registeredRoutes).toHaveLength(1);

    const ghResp = await fetch(
      `http://127.0.0.1:${runtime.standaloneWebhookPort}/webhooks/connectors/github/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: "deepseek/dsh",
          prNumber: 88,
          eventId: "gh-evt-88-1",
          author: "alice",
          commentBody: "Investigate pod OOMKilled",
        }),
      },
    );
    expect(ghResp.status).toBe(202);

    expect(host.prompts).toHaveLength(1);
    const sessionId = host.prompts[0]!.sessionId;
    expect(sessionId.startsWith("session-")).toBe(true);
    expect(host.persistedSessions.get(sessionId)?.title).toBe("PR deepseek/dsh#88");

    const ghTool = host.registeredTools.get("connector_send_github")!;
    const wecomTool = host.registeredTools.get("connector_send_wecom")!;
    const liveAgent = host.liveAgents.get(sessionId)!;

    await ghTool.execute({ body: "Acknowledge #88, investigating now." }, { agent: liveAgent });
    await ghTool.execute(
      { repo: "deepseek/dsh", prNumber: 89, body: "Linking related incident #89." },
      { agent: liveAgent },
    );
    await wecomTool.execute(
      { text: "Alerting SRE channel: investigating GitHub #88." },
      { agent: liveAgent },
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

    const wecomQuoteResp = await fetch(
      `http://127.0.0.1:${runtime.standaloneWebhookPort}/webhooks/connectors/wecom/callback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          msgId: "wecom-reply-1",
          text: `${wecomWireText
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}\nHeap dump uploaded to OSS bucket.`,
        }),
      },
    );
    expect(wecomQuoteResp.status).toBe(202);

    expect(host.prompts).toHaveLength(2);
    expect(host.prompts[1]!.sessionId).toBe(sessionId);
    expect(host.prompts[1]!.text).not.toContain("dsh-ctx:");
    expect(host.prompts[1]!.text).toContain("Heap dump uploaded to OSS bucket.");

    const portBeforeDispose = runtime.standaloneWebhookPort!;
    await host.disposeAll();

    expect(host.registeredTools.size).toBe(0);
    expect(host.registeredRoutes).toHaveLength(0);
    expect(github.stopped).toBe(true);
    expect(wecom.stopped).toBe(true);
    expect(alerts.stopped).toBe(true);

    await expect(
      fetch(`http://127.0.0.1:${portBeforeDispose}/webhooks/connectors/github/events`, {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow();
  });

  it("persists and reloads ContextSessionStore across cold host restarts via ctx.storageDomain and storageFilePath", async () => {
    const sharedStorageDomain = new Map<string, PersistedContextRecord>();
    const host1 = new MockDshHost({ storageDomainBacking: sharedStorageDomain });
    const github1 = new MockGithubPrConnector();

    const runtime1 = await mountConnectorPlugin(host1.createContext(), {
      connectors: [github1],
      webhook: { standalone: { host: "127.0.0.1", port: 0 } },
    });

    const resp1 = await fetch(
      `http://127.0.0.1:${runtime1.standaloneWebhookPort}/webhooks/connectors/github/events`,
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

    await runtime1.dispose();
    expect(host1.storageDomainCloseCount).toBe(1);

    const host2 = new MockDshHost({
      useSessionController: false,
      storageDomainBacking: sharedStorageDomain,
    });
    for (const [id, meta] of host1.persistedSessions.entries()) {
      host2.persistedSessions.set(id, { ...meta });
    }

    const github2 = new MockGithubPrConnector();
    const runtime2 = await mountConnectorPlugin(host2.createContext(), {
      connectors: [github2],
      webhook: { standalone: { host: "127.0.0.1", port: 0 } },
    });

    const resp2 = await fetch(
      `http://127.0.0.1:${runtime2.standaloneWebhookPort}/webhooks/connectors/github/events`,
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
    expect(host2.storageDomainCloseCount).toBe(1);

    const tempDir = await mkdtemp(join(tmpdir(), "dsh-plugin-file-store-"));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, "bindings.json");

    const host3 = new MockDshHost();
    const wecom3 = new MockWecomBotConnector();
    const runtime3 = await mountConnectorPlugin(host3.createContext(), {
      connectors: [wecom3],
      storageFilePath: filePath,
    });
    const created = await host3.createContext().get("sessionController")!.create({});
    const fileSessionId = created.sessionId!;
    await runtime3.manager.dispatchSend("wecom", fileSessionId, { text: "Persist to JSON file" });
    const boundCtx = await runtime3.contextStore.getContext(fileSessionId, "wecom");
    expect(boundCtx?.contextId.length).toBeGreaterThan(0);
    await runtime3.dispose();

    const host4 = new MockDshHost();
    const runtime4 = await mountConnectorPlugin(host4.createContext(), {
      connectors: [new MockWecomBotConnector()],
      storageFilePath: filePath,
    });
    expect(await runtime4.contextStore.getSessionId(boundCtx!)).toBe(fileSessionId);
    await runtime4.dispose();
  });
});
