import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  ToolArgsError,
  ToolContextUnavailableError,
  type ObjectJsonSchema,
  type ToolsService,
} from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  ConnectorValidationError,
  type Connector,
  type ConnectorSender,
} from "@dsh-connector/core";
import { DEFAULT_TOOL_NAME_PREFIX } from "./constants";
import type { ConnectorManager } from "./manager";
import { zodToDshJsonSchema } from "./zod-json-schema";

export interface ToolBridgeOptions {
  readonly toolNamePrefix?: string;
}

const TOOL_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    connector: { type: "string" },
    externalId: { type: "string" },
    summary: { type: "string" },
    data: { type: "object", properties: {}, additionalProperties: true },
  },
  required: ["ok", "connector", "summary"],
  additionalProperties: false,
};

export function formatConnectorToolName(
  connectorName: string,
  prefix: string = DEFAULT_TOOL_NAME_PREFIX,
): string {
  return `${prefix}${connectorName.replace(/-/g, "_")}`;
}

function registerSingleConnectorTool(
  toolsService: ToolsService,
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
    parameters: { ...parameters },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render(_args: unknown, value: JsonValue): ContentBlock[] {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const summary = typeof value["summary"] === "string" ? value["summary"] : "Sent.";
          const extId =
            typeof value["externalId"] === "string" ? ` (externalId: ${value["externalId"]})` : "";
          const connectorLabel =
            typeof value["connector"] === "string" ? value["connector"] : connector.name;
          return [{ type: "text", text: `[${connectorLabel}] ${summary}${extId}` }];
        }
        return [{ type: "text", text: String(value) }];
      },
    },
    async execute(args, exec) {
      const currentSessionId = exec.agent?.id;
      if (currentSessionId === undefined || currentSessionId.trim().length === 0) {
        throw new ToolContextUnavailableError(
          `Tool "${toolName}" requires an active DSH Agent session identity.`,
        );
      }

      try {
        const result = await manager.dispatchSend(connector.name, currentSessionId, args, {
          signal: exec.signal,
        });

        return {
          ok: true,
          connector: connector.name,
          ...(result.externalId !== undefined ? { externalId: result.externalId } : {}),
          summary: result.summary ?? `Delivered via connector "${connector.name}".`,
          ...(result.data !== undefined ? { data: result.data } : {}),
        };
      } catch (error) {
        if (error instanceof ConnectorValidationError) {
          throw new ToolArgsError([error.message]);
        }
        throw error;
      }
    },
  });
}

export function registerConnectorTools(
  toolsService: ToolsService,
  manager: ConnectorManager,
  options?: ToolBridgeOptions,
): () => void {
  const prefix = options?.toolNamePrefix ?? DEFAULT_TOOL_NAME_PREFIX;
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
