import {
  ConnectorError,
  ConnectorValidationError,
  assertNonEmptyContextId,
  assertValidConnectorName,
  createConnectorContext,
  createDefaultContextIdGenerator,
  isReceivableConnector,
  isSendableConnector,
  isWebhookConnector,
  type AnyConnector,
  type ConnectorContext,
  type ConnectorContextIdGenerator,
  type ConnectorInboundPrompt,
  type ConnectorLogger,
  type ConnectorRuntimeContext,
  type ConnectorSendOptions,
  type ConnectorSendResult,
  type InboundDeliveryMeta,
  type ReceivableConnector,
  type SendableConnector,
  type WebhookConnector,
} from "@dsh-connector/core";
import { toContextHashKey, type ContextSessionStore } from "./context-store.js";
import type { SessionDriver } from "./session-driver.js";
import { KeyedSerialQueue, TtlDeduplicator } from "./reliability.js";

const NOOP_LOGGER: ConnectorLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface ConnectorManagerOptions {
  readonly connectors: readonly AnyConnector[];
  readonly contextStore: ContextSessionStore;
  readonly sessionDriver: SessionDriver;
  readonly contextIdGenerator?: ConnectorContextIdGenerator;
  readonly logger?: ConnectorLogger;
  readonly deduplicationTtlMs?: number;
  readonly deduplicationMaxEntries?: number;
}

function formatZodIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => {
      const pathStr = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
      return `${pathStr}: ${issue.message}`;
    })
    .join("; ");
}

function renderDefaultInboundEnvelope(
  connectorName: string,
  contextId: string,
  params: unknown,
): ConnectorInboundPrompt {
  return {
    title: `[${connectorName}] ${contextId}`,
    text: [
      `Inbound event from connector "${connectorName}" (contextId: "${contextId}"):`,
      "```json",
      JSON.stringify(params, null, 2),
      "```",
    ].join("\n"),
  };
}

export class ConnectorManager {
  private readonly connectors = new Map<string, AnyConnector>();
  private readonly startedConnectors: AnyConnector[] = [];
  private readonly contextStore: ContextSessionStore;
  private readonly sessionDriver: SessionDriver;
  private readonly contextIdGenerator: ConnectorContextIdGenerator;
  private readonly logger: ConnectorLogger;
  private readonly inboundQueue = new KeyedSerialQueue();
  private readonly deduplicator: TtlDeduplicator;

  constructor(options: ConnectorManagerOptions) {
    this.contextStore = options.contextStore;
    this.sessionDriver = options.sessionDriver;
    this.contextIdGenerator = options.contextIdGenerator ?? createDefaultContextIdGenerator();
    this.logger = options.logger ?? NOOP_LOGGER;
    this.deduplicator = new TtlDeduplicator({
      ttlMs: options.deduplicationTtlMs,
      maxEntries: options.deduplicationMaxEntries,
    });

    for (const connector of options.connectors) {
      assertValidConnectorName(connector.name);
      if (this.connectors.has(connector.name)) {
        throw new ConnectorValidationError(
          `Duplicate connector name "${connector.name}" registered in ConnectorManager.`,
          { connectorName: connector.name },
        );
      }
      this.connectors.set(connector.name, connector);
    }
  }

  getConnector(name: string): AnyConnector | undefined {
    return this.connectors.get(name);
  }

  getSendableConnectors(): SendableConnector[] {
    return [...this.connectors.values()].filter(isSendableConnector);
  }

  getWebhookConnectors(): WebhookConnector[] {
    return [...this.connectors.values()].filter(isWebhookConnector);
  }

  async startAll(): Promise<void> {
    try {
      for (const connector of this.connectors.values()) {
        const runtimeCtx = this.buildRuntimeContext(connector);
        await connector.init?.(runtimeCtx);
      }

      for (const connector of this.connectors.values()) {
        await connector.start?.();
        this.startedConnectors.push(connector);
      }
    } catch (error) {
      await this.stopAll();
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    const toStop = this.startedConnectors.splice(0).reverse();
    for (const connector of toStop) {
      try {
        await connector.stop?.();
      } catch (error) {
        this.logger.error(`Error stopping connector "${connector.name}"`, {
          connectorName: connector.name,
          error: String(error),
        });
      }
    }
  }

  async dispatchSend(
    connectorName: string,
    currentSessionId: string,
    rawParams: unknown,
    options?: ConnectorSendOptions,
  ): Promise<ConnectorSendResult> {
    const connector = this.connectors.get(connectorName);
    if (connector === undefined) {
      throw new ConnectorError(`Unknown connector "${connectorName}".`, {
        connectorName,
      });
    }
    if (!isSendableConnector(connector)) {
      throw new ConnectorValidationError(
        `Connector "${connectorName}" does not support outbound send capability.`,
        { connectorName },
      );
    }
    if (currentSessionId.trim().length === 0) {
      throw new ConnectorValidationError("currentSessionId must be a non-empty string.", {
        connectorName,
      });
    }

    const parsed = connector.sendSchema.safeParse(rawParams);
    if (!parsed.success) {
      throw new ConnectorValidationError(
        `Invalid parameters for connector "${connectorName}": ${formatZodIssues(parsed.error.issues)}`,
        { connectorName, cause: parsed.error },
      );
    }

    const context = await this.contextStore.getOrCreateContext(
      currentSessionId,
      connector,
      this.contextIdGenerator,
    );

    return connector.send(context, parsed.data, options);
  }

  private buildRuntimeContext(connector: AnyConnector): ConnectorRuntimeContext {
    const createContext = (contextId?: string): ConnectorContext => {
      const resolvedId =
        contextId !== undefined ? contextId : this.contextIdGenerator.generate(connector.name);
      return createConnectorContext(connector, resolvedId);
    };

    const onReceive = isReceivableConnector(connector)
      ? (context: ConnectorContext, rawParams: unknown, meta?: InboundDeliveryMeta) =>
          this.handleInbound(connector, context, rawParams, meta)
      : undefined;

    return {
      createContext,
      contextIdGenerator: this.contextIdGenerator,
      ...(onReceive !== undefined ? { onReceive } : {}),
      logger: this.logger,
    };
  }

  private async handleInbound(
    connector: ReceivableConnector,
    context: ConnectorContext,
    rawParams: unknown,
    meta?: InboundDeliveryMeta,
  ): Promise<{ readonly sessionId: string; readonly deduplicated?: boolean }> {
    if (context.connectorName !== connector.name) {
      throw new ConnectorValidationError(
        `Context connectorName "${context.connectorName}" does not match receiving connector "${connector.name}".`,
        { connectorName: connector.name },
      );
    }
    assertNonEmptyContextId(context.contextId, connector.name);

    const parsed = connector.receiveSchema.safeParse(rawParams);
    if (!parsed.success) {
      throw new ConnectorValidationError(
        `Invalid inbound payload for connector "${connector.name}": ${formatZodIssues(parsed.error.issues)}`,
        { connectorName: connector.name, cause: parsed.error },
      );
    }

    const hashKey = toContextHashKey(context);
    const dedupKey =
      meta?.idempotencyKey !== undefined && meta.idempotencyKey.length > 0
        ? `${connector.name}--${meta.idempotencyKey}`
        : undefined;

    return this.inboundQueue.run(hashKey, async () => {
      if (dedupKey !== undefined && this.deduplicator.has(dedupKey)) {
        const cachedSession = (await this.contextStore.getSessionIdByHashKey(hashKey)) ?? "";
        return { sessionId: cachedSession, deduplicated: true };
      }

      let existingSessionId = await this.contextStore.getSessionIdByHashKey(hashKey);
      if (
        existingSessionId !== undefined &&
        !(await this.sessionDriver.exists(existingSessionId))
      ) {
        await this.contextStore.removeSession(existingSessionId);
        existingSessionId = undefined;
      }

      const rawFormatted = connector.formatInbound?.(parsed.data, context);
      const formatted: ConnectorInboundPrompt =
        typeof rawFormatted === "string"
          ? { text: rawFormatted }
          : (rawFormatted ??
            renderDefaultInboundEnvelope(connector.name, context.contextId, parsed.data));

      let targetSessionId: string;
      if (existingSessionId === undefined) {
        const title = meta?.suggestedTitle ?? formatted.title;
        targetSessionId = await this.sessionDriver.createSession(
          title !== undefined ? { suggestedTitle: title } : undefined,
        );
        await this.contextStore.bind(targetSessionId, context);
      } else {
        targetSessionId = existingSessionId;
      }

      await this.sessionDriver.prompt(
        targetSessionId,
        formatted.text,
        meta?.deliveryMode ?? "queue",
      );

      if (dedupKey !== undefined) {
        this.deduplicator.record(dedupKey);
      }

      return { sessionId: targetSessionId, deduplicated: false };
    });
  }
}
