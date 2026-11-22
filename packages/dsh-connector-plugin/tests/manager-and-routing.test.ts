import { describe, expect, it } from "vitest";
import { ConnectorTargetRequiredError, ConnectorValidationError } from "@dsh-connector/core";
import { DefaultContextSessionStore } from "../src/context-store.js";
import { ConnectorManager } from "../src/manager.js";
import { DshSessionDriver } from "../src/session-driver.js";
import {
  MockAlertIngestConnector,
  MockGithubPrConnector,
  MockWecomNotifyConnector,
} from "./mocks/mock-connectors.js";
import { MockDshHost } from "./mocks/mock-dsh-host.js";

describe("ConnectorManager & DshSessionDriver routing closed-loop", () => {
  it("routes inbound events with business IDs to a single DSH session and replies via non-empty context fallback", async () => {
    const host = new MockDshHost({ useSessionController: true });
    const dshCtx = host.createContext();
    const store = new DefaultContextSessionStore();
    const sessionDriver = new DshSessionDriver(dshCtx, { defaultCwd: "/tmp/workspace" });
    const github = new MockGithubPrConnector();

    const manager = new ConnectorManager({
      connectors: [github],
      contextStore: store,
      sessionDriver,
    });
    await manager.startAll();
    expect(github.started).toBe(true);

    const first = await github.simulateWebhookComment({
      repo: "Chiichen/DSH-Connector",
      prNumber: 42,
      author: "alice",
      commentBody: "Please review this change.",
    });

    expect(first.sessionId).toMatch(/^session-/);
    expect(host.persistedSessions.get(first.sessionId)?.title).toBe("PR Chiichen/DSH-Connector#42");

    const second = await github.simulateWebhookComment({
      repo: "chiichen/dsh-connector",
      prNumber: 42,
      author: "bob",
      commentBody: "Added unit tests.",
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(host.prompts).toHaveLength(2);

    // Agent replies in the same session WITHOUT specifying prNumber in params -> resolves from context.contextId
    const sendRes = await manager.dispatchSend("github", first.sessionId, {
      body: "Looks great, LGTM!",
    });
    expect(sendRes.summary).toBe("Posted comment to chiichen/dsh-connector#42");
    expect(github.postedComments[0]?.context).toEqual({
      connectorName: "github",
      contextId: "chiichen/dsh-connector#42",
    });

    await manager.stopAll();
    expect(github.stopped).toBe(true);
  });

  it("allocates a non-empty UUID on outbound-first send, keeps 1 context across #42/#43 params, and resumes via Quote reply", async () => {
    const host = new MockDshHost({ useSessionController: false });
    const dshCtx = host.createContext();
    // Pre-create a local DSH session in headless mode
    await dshCtx.agents.create({ sessionId: "session-local-1", meta: { cwd: "/tmp/local" } });

    const store = new DefaultContextSessionStore();
    const sessionDriver = new DshSessionDriver(dshCtx, { defaultCwd: "/tmp/local" });
    const github = new MockGithubPrConnector();
    const wecom = new MockWecomNotifyConnector();

    const manager = new ConnectorManager({
      connectors: [github, wecom],
      contextStore: store,
      sessionDriver,
    });
    await manager.startAll();

    // Missing prNumber on local session (whose auto-allocated contextId is a pure UUID) throws ConnectorTargetRequiredError
    await expect(
      manager.dispatchSend("github", "session-local-1", { body: "Where does this go?" }),
    ).rejects.toThrow(ConnectorTargetRequiredError);

    // Explicitly comment on #42 and #43 in the same session -> single constant UUID contextId!
    await manager.dispatchSend("github", "session-local-1", {
      prNumber: 42,
      body: "Checking PR #42",
    });
    await manager.dispatchSend("github", "session-local-1", {
      prNumber: 43,
      body: "Cross-referencing PR #43",
    });
    // Also notify WeCom in the same session -> multi-connector single session!
    await manager.dispatchSend("wecom", "session-local-1", {
      webhookKey: "ops-room",
      text: "Both PRs reviewed",
    });

    expect(github.postedComments).toHaveLength(2);
    const allocatedGithubCtx = github.postedComments[0]!.context;
    expect(allocatedGithubCtx.contextId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(github.postedComments[1]!.context).toEqual(allocatedGithubCtx);
    expect(wecom.sentCalls[0]!.context.connectorName).toBe("wecom");

    // External user Quote-replies to the encoded comment on PR #42 -> routes straight back to session-local-1!
    const quotedComment = github.postedComments[0]!.encodedBody.split("\n")
      .map((line) => `> ${line}`)
      .concat(["", "Thanks, fixed the nit!"])
      .join("\n");

    // Evict live agent first to also test headless cold-session resume!
    host.evictLiveAgentToColdStorage("session-local-1");

    const inbound = await github.simulateWebhookComment({
      repo: "chiichen/dsh-connector",
      prNumber: 42,
      author: "reviewer",
      commentBody: quotedComment,
    });

    expect(inbound.sessionId).toBe("session-local-1");
    const lastPrompt = host.prompts.at(-1)!;
    expect(lastPrompt.sessionId).toBe("session-local-1");
    expect(lastPrompt.text).not.toContain("dsh-ctx:");
    expect(lastPrompt.text).toContain("Thanks, fixed the nit!");
  });

  it("deduplicates retries, serializes 10 concurrent webhooks into 1 session, and self-heals deleted sessions", async () => {
    const host = new MockDshHost({ useSessionController: true });
    const dshCtx = host.createContext();
    const store = new DefaultContextSessionStore();
    const sessionDriver = new DshSessionDriver(dshCtx, { defaultCwd: "/tmp/alerts" });
    const alerts = new MockAlertIngestConnector();

    const manager = new ConnectorManager({
      connectors: [alerts],
      contextStore: store,
      sessionDriver,
    });
    await manager.startAll();

    // 10 concurrent webhooks for the same fingerprint arrive at the exact same tick
    const concurrentResults = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        alerts.simulateAlert(
          {
            severity: "critical",
            fingerprint: "cpu-high",
            message: `Burst event #${idx}`,
          },
          { idempotencyKey: `delivery-${idx}` },
        ),
      ),
    );

    const uniqueSessions = new Set(concurrentResults.map((r) => r.sessionId));
    expect(uniqueSessions.size).toBe(1);
    const originalSessionId = concurrentResults[0]!.sessionId;
    expect(host.prompts).toHaveLength(10);

    // Retry with duplicate idempotencyKey is ignored
    const duplicate = await alerts.simulateAlert(
      { severity: "critical", fingerprint: "cpu-high", message: "Retry" },
      { idempotencyKey: "delivery-0" },
    );
    expect(duplicate).toEqual({ sessionId: originalSessionId, deduplicated: true });
    expect(host.prompts).toHaveLength(10);

    // Simulate user deleting the session in DSH UI -> next alert self-heals by minting a fresh session
    host.deleteSessionInUi(originalSessionId);
    const healed = await alerts.simulateAlert({
      severity: "warning",
      fingerprint: "cpu-high",
      message: "Recovered alert after session deletion",
    });
    expect(healed.sessionId).not.toBe(originalSessionId);
    expect(host.prompts).toHaveLength(11);
  });

  it("rejects duplicate connector names and rolls back started connectors if a subsequent connector fails to start", async () => {
    const host = new MockDshHost();
    const dshCtx = host.createContext();
    const sessionDriver = new DshSessionDriver(dshCtx, { defaultCwd: "/tmp/test" });

    expect(
      () =>
        new ConnectorManager({
          connectors: [new MockGithubPrConnector(), new MockGithubPrConnector()],
          contextStore: new DefaultContextSessionStore(),
          sessionDriver,
        }),
    ).toThrow(ConnectorValidationError);

    const gh = new MockGithubPrConnector();
    const failingConnector = {
      name: "broken-svc",
      sendSchema: gh.sendSchema,
      start() {
        throw new Error("Failed to connect socket");
      },
      async send() {
        return {};
      },
    };

    const manager = new ConnectorManager({
      connectors: [gh, failingConnector],
      contextStore: new DefaultContextSessionStore(),
      sessionDriver,
    });

    await expect(manager.startAll()).rejects.toThrow("Failed to connect socket");
    expect(gh.started).toBe(true);
    expect(gh.stopped).toBe(true);
  });
});
