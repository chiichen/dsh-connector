import {
  ConnectorValidationError,
  type Connector,
  type ConnectorSender,
} from "@dsh-connector/core";
import type { ObjectJsonSchema } from "@deepseek-ai/dsh-tools";
import type { DshToolsServiceLike } from "./dsh-types";
import type { ConnectorManager } from "./manager";
import { zodToDshJsonSchema } from "./zod-json-schema";

export interface ToolBridgeOptions {
  readonly toolNamePrefix?: string;
}

class ToolBridgeExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ToolBridgeExecutionError";
    this.code = code;
  }
}

const TOOL_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    connector: { type: "string" },
    externalId: { type: "string" },
    summary: { type: "string" },
    data: { type: "object", additionalProperties: true },
  },
  required: ["ok", "connector", "summary"],
  additionalProperties: false,
};

export function formatConnectorToolName(connectorName: string, prefix = "connector_send_"): string {
  return `${prefix}${connectorName.replace(/-/g, "_")}`;
}

function registerSingleConnectorTool(
  toolsService: DshToolsServiceLike,
  manager: ConnectorManager,
  connector: Connector,
  sender: ConnectorSender,
  toolNamePrefix: string,
): () => void {
  const toolName = formatConnectorToolName(connector.name, toolNamePrefix);
  const description =
    sender.description ??
    connector.description ??
    `Send a message or action via the "${connector.name}" external connector.`;

  const parameters = zodToDshJsonSchema(sender.schema);

  return toolsService.register({
    name: toolName,
    description,
    parameters,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render(value: unknown): string {
        if (typeof value === "object" && value !== null) {
          const rec = value as Record<string, unknown>;
          const summary = typeof rec["summary"] === "string" ? rec["summary"] : "Sent.";
          const extId =
            typeof rec["externalId"] === "string" ? ` (externalId: ${rec["externalId"]})` : "";
          return `[${String(rec["connector"] ?? connector.name)}] ${summary}${extId}`;
        }
        return String(value);
      },
    },
    async execute(args, exec) {
      const currentSessionId = exec.agent?.id ?? exec.agent?.session?.id;
      if (currentSessionId === undefined || currentSessionId.trim().length === 0) {
        throw new ToolBridgeExecutionError(
          "MISSING_SESSION_CONTEXT",
          `Tool "${toolName}" requires an active DSH Agent session identity.`,
        );
      }

      try {
        const result = await manager.dispatchSend(
          connector.name,
          currentSessionId,
          args,
          exec.signal !== undefined ? { signal: exec.signal } : undefined,
        );

        return {
          ok: true,
          connector: connector.name,
          ...(result.externalId !== undefined ? { externalId: result.externalId } : {}),
          summary: result.summary ?? `Delivered via connector "${connector.name}".`,
          ...(result.data !== undefined ? { data: result.data } : {}),
        };
      } catch (error) {
        if (error instanceof ConnectorValidationError) {
          throw new ToolBridgeExecutionError("INVALID_ARGS", error.message, error);
        }
        throw error;
      }
    },
  });
}

export function registerConnectorTools(
  toolsService: DshToolsServiceLike,
  manager: ConnectorManager,
  options?: ToolBridgeOptions,
): () => void {
  const prefix = options?.toolNamePrefix ?? "connector_send_";
  const disposers: Array<() => void> = [];

  for (const { connector, sender } of manager.getSendableEntries()) {
    disposers.push(registerSingleConnectorTool(toolsService, manager, connector, sender, prefix));
  }

  return () => {
    for (const dispose of [...disposers].reverse()) {
      dispose();
    }
    disposers.length = 0;
  };
}
