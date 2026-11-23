import { ToolArgsError, ToolContextUnavailableError } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
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
import { createTestToolRunContext, TestDshHost } from "./mocks/mock-dsh-host";

describe("registerConnectorTools", () => {
  it("registers tools on real @deepseek-ai/dsh-tools ToolsService, renders ContentBlock[], and throws DSH tool errors", async () => {
    const host = await TestDshHost.start();
    try {
      const store = new DefaultContextSessionStore();
      const sessionDriver = new DshSessionDriver(host.ctx, { defaultCwd: "/tmp/tools" });

      const wecom = new MockWecomNotifyConnector();
      const alerts = new MockAlertIngestConnector();
      const github = new MockGithubPrConnector();

      const manager = new ConnectorManager({
        connectors: [wecom, alerts, github],
        contextStore: store,
        sessionDriver,
      });
      await manager.startAll();

      const disposeTools = registerConnectorTools(host.ctx.tools, manager);

      const registeredNames = host.ctx.tools
        .definitions()
        .map((def) => def.name)
        .sort();
      expect(registeredNames).toEqual(["connector_send_github", "connector_send_wecom"]);
      expect(host.ctx.tools.get("connector_send_alertmanager")).toBeUndefined();

      const ghTool = host.ctx.tools.get("connector_send_github")!;
      const abortController = new AbortController();

      const output = (await ghTool.execute(
        { prNumber: 88, body: "Automated review passed" },
        createTestToolRunContext({
          sessionId: "session-agent-7",
          signal: abortController.signal,
        }),
      )) as Record<string, JsonValue>;

      expect(output["ok"]).toBe(true);
      expect(output["connector"]).toBe("github");
      expect(output["summary"]).toBe("Posted comment to chiichen/dsh-connector#88");

      const renderedBlocks = ghTool.output.render(
        { prNumber: 88, body: "Automated review passed" },
        output,
      );
      expect(renderedBlocks).toEqual([
        {
          type: "text",
          text: "[github] Posted comment to chiichen/dsh-connector#88 (externalId: chiichen/dsh-connector#88-comment-1)",
        },
      ]);

      // Invalid schema arguments surface DSH ToolArgsError
      await expect(
        ghTool.execute(
          { prNumber: -5, body: "" },
          createTestToolRunContext({ sessionId: "session-agent-7" }),
        ),
      ).rejects.toBeInstanceOf(ToolArgsError);

      // Missing agent session context surfaces DSH ToolContextUnavailableError
      await expect(
        ghTool.execute({ prNumber: 1, body: "hi" }, createTestToolRunContext()),
      ).rejects.toBeInstanceOf(ToolContextUnavailableError);

      disposeTools();
      expect(host.ctx.tools.definitions()).toHaveLength(0);
      await manager.stopAll();
    } finally {
      await host.stop();
    }
  });
});
