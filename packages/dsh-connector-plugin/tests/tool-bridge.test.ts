import { describe, expect, it } from "vitest";
import { DefaultContextSessionStore } from "../src/context-store";
import { ConnectorManager } from "../src/manager";
import { DshSessionDriver } from "../src/session-driver";
import { registerConnectorTools } from "../src/tool-bridge";
import {
  MockAlertIngestConnector,
  MockGithubPrConnector,
  MockWecomNotifyConnector,
} from "./mocks/mock-connectors";
import { MockDshHost } from "./mocks/mock-dsh-host";

describe("registerConnectorTools", () => {
  it("registers tools only for sendable connectors, bridges sessionId & AbortSignal, and unregisters on dispose", async () => {
    const host = new MockDshHost();
    const dshCtx = host.createContext();
    const store = new DefaultContextSessionStore();
    const sessionDriver = new DshSessionDriver(dshCtx, { defaultCwd: "/tmp/tools" });

    const wecom = new MockWecomNotifyConnector();
    const alerts = new MockAlertIngestConnector();
    const github = new MockGithubPrConnector();

    const manager = new ConnectorManager({
      connectors: [wecom, alerts, github],
      contextStore: store,
      sessionDriver,
    });
    await manager.startAll();

    const disposeTools = registerConnectorTools(dshCtx.tools, manager);

    expect([...host.registeredTools.keys()].sort()).toEqual([
      "connector_send_github",
      "connector_send_wecom",
    ]);
    expect(host.registeredTools.has("connector_send_alertmanager")).toBe(false);

    const ghTool = host.registeredTools.get("connector_send_github")!;
    const abortController = new AbortController();

    const output = (await ghTool.execute(
      { prNumber: 88, body: "Automated review passed" },
      { agent: { id: "session-agent-7" }, signal: abortController.signal },
    )) as Record<string, unknown>;

    expect(output["ok"]).toBe(true);
    expect(output["connector"]).toBe("github");
    expect(output["summary"]).toBe("Posted comment to chiichen/dsh-connector#88");
    expect(ghTool.output?.render?.(output)).toContain(
      "Posted comment to chiichen/dsh-connector#88",
    );

    // Invalid schema arguments surface code: INVALID_ARGS
    await expect(
      ghTool.execute({ prNumber: -5, body: "" }, { agent: { id: "session-agent-7" } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });

    // Missing agent session context surfaces explicit error
    await expect(ghTool.execute({ prNumber: 1, body: "hi" }, {})).rejects.toMatchObject({
      code: "MISSING_SESSION_CONTEXT",
    });

    disposeTools();
    expect(host.registeredTools.size).toBe(0);
    await manager.stopAll();
  });
});
