import { ToolArgsError, ToolContextUnavailableError } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConnectorTransportError, defineConnector } from "@dsh-connector/core";
import { DefaultContextSessionStore } from "../src/context-store";
import { ConnectorManager } from "../src/manager";
import { DshSessionDriver } from "../src/session-driver";
import { formatConnectorToolName, registerConnectorTools } from "../src/tool-bridge";
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

  it("supports custom toolNamePrefix, default descriptions, data payloads, render fallbacks, and transport error propagation", async () => {
    const host = await TestDshHost.start();
    try {
      expect(formatConnectorToolName("ops-pager")).toBe("connector_send_ops_pager");
      expect(formatConnectorToolName("ops-pager", "ext_")).toBe("ext_ops_pager");

      let shouldFailTransport = false;
      const customConnector = defineConnector({
        name: "ops-pager",
        getSender: () => ({
          schema: z.object({ message: z.string() }),
          async send(_ctx, params) {
            if (shouldFailTransport) {
              throw new ConnectorTransportError("502 upstream gateway error", {
                statusCode: 502,
                retryable: true,
              });
            }
            return {
              data: { echoed: params.message },
            };
          },
        }),
        getReceiver: () => undefined,
      });

      const manager = new ConnectorManager({
        connectors: [customConnector],
        contextStore: new DefaultContextSessionStore(),
        sessionDriver: new DshSessionDriver(host.ctx),
      });
      await manager.startAll();

      const dispose = registerConnectorTools(host.ctx.tools, manager, {
        toolNamePrefix: "ext_",
      });

      const tool = host.ctx.tools.get("ext_ops_pager")!;
      expect(tool).toBeDefined();
      expect(tool.description).toBe(
        'Send a message or action via the "ops-pager" external connector.',
      );

      const output = (await tool.execute(
        { message: "ping" },
        createTestToolRunContext({ sessionId: "session-ops-1" }),
      )) as Record<string, JsonValue>;

      expect(output).toEqual({
        ok: true,
        connector: "ops-pager",
        summary: 'Delivered via connector "ops-pager".',
        data: { echoed: "ping" },
      });

      // Render fallback branches: minimal empty object & non-object scalar JsonValue
      expect(tool.output.render({}, {})).toEqual([{ type: "text", text: "[ops-pager] Sent." }]);
      expect(tool.output.render({}, "raw-scalar")).toEqual([{ type: "text", text: "raw-scalar" }]);

      // Non-validation errors (e.g. ConnectorTransportError) propagate directly without wrapping in ToolArgsError
      shouldFailTransport = true;
      await expect(
        tool.execute({ message: "ping" }, createTestToolRunContext({ sessionId: "session-ops-1" })),
      ).rejects.toBeInstanceOf(ConnectorTransportError);

      dispose();
      await manager.stopAll();
    } finally {
      await host.stop();
    }
  });
});
