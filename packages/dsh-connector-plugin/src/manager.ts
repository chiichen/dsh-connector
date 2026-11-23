import {
  CONNECTOR_CONTEXT_SEPARATOR,
  ConnectorError,
  ConnectorValidationError,
  assertNonEmptyContextId,
  assertValidConnectorName,
  createDefaultContextIdGenerator,
  type Connector,
  type ConnectorContext,
  type ConnectorContextIdGenerator,
  type ConnectorInboundPrompt,
  type ConnectorLogger,
  type ConnectorReceiver,
  type ConnectorReceiverContext,
  type ConnectorSender,
  type ConnectorSendOptions,
  type ConnectorSendResult,
  type InboundDeliveryMeta,
} from "@dsh-connector/core";
import { DEDUP_KEY_LENGTH_DELIMITER } from "./constants";
import {
  toContextHashKey,
  type ConnectorContextHashKey,
  type ContextSessionStore,
} from "./context-store";
import { KeyedSerialQueue, TtlDeduplicator } from "./reliability";
import type { SessionDriver } from "./session-driver";

const NOOP_LOGGER: ConnectorLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface RegisteredConnectorEntry {
  readonly connector: Connector;
  readonly sender: ConnectorSender | undefined;
  readonly receiver: ConnectorReceiver | undefined;
}

export interface SendableConnectorEntry {
  readonly connector: Connector;
  readonly sender: ConnectorSender;
}

export interface ConnectorManagerOptions {
  readonly connectors: readonly Connector[];
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

function buildInboundDedupKey(hashKey: ConnectorContextHashKey, idempotencyKey: string): string {
  return `${hashKey.length}${DEDUP_KEY_LENGTH_DELIMITER}${hashKey}${CONNECTOR_CONTEXT_SEPARATOR}${idempotencyKey}`;
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
  private readonly entries = new Map<string, RegisteredConnectorEntry>();
  private readonly startedConnectors: Connector[] = [];
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
      if (this.entries.has(connector.name)) {
        throw new ConnectorValidationError(
          `Duplicate connector name "${connector.name}" registered in ConnectorManager.`,
          { connectorName: connector.name },
        );
      }
      this.entries.set(connector.name, {
        connector,
        sender: connector.getSender(),
        receiver: connector.getReceiver(),
      });
    }
  }

  getConnector(name: string): Connector | undefined {
    return this.entries.get(name)?.connector;
  }

  getReceiver(name: string): ConnectorReceiver | undefined {
    return this.entries.get(name)?.receiver;
  }

  getSendableEntries(): SendableConnectorEntry[] {
    const result: SendableConnectorEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.sender !== undefined) {
        result.push({ connector: entry.connector, sender: entry.sender });
      }
    }
    return result;
  }

  async startAll(): Promise<void> {
    try {
      for (const { connector, receiver } of this.entries.values()) {
        if (receiver !== undefined) {
          const receiverCtx = this.buildReceiverContext(connector, receiver);
          await receiver.init?.(receiverCtx);
        }
      }

      for (const { connector } of this.entries.values()) {
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
    const entry = this.entries.get(connectorName);
    if (entry === undefined) {
      throw new ConnectorError(`Unknown connector "${connectorName}".`, {
        connectorName,
      });
    }
    if (entry.sender === undefined) {
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

    const parsed = entry.sender.schema.safeParse(rawParams);
    if (!parsed.success) {
      throw new ConnectorValidationError(
        `Invalid parameters for connector "${connectorName}": ${formatZodIssues(parsed.error.issues)}`,
        { connectorName, cause: parsed.error },
      );
    }

    const context = await this.contextStore.getOrCreateContext(
      currentSessionId,
      entry.connector,
      this.contextIdGenerator,
    );

    return entry.sender.send(context, parsed.data, options);
  }

  private buildReceiverContext(
    connector: Connector,
    receiver: ConnectorReceiver,
  ): ConnectorReceiverContext {
    return {
      allocateContextId: () => this.contextIdGenerator.generate(connector.name),
      contextIdGenerator: this.contextIdGenerator,
      onReceive: (context: ConnectorContext, rawParams: unknown, meta?: InboundDeliveryMeta) =>
        this.handleInbound(connector, receiver, context, rawParams, meta),
      logger: this.logger,
    };
  }

  private async handleInbound(
    connector: Connector,
    receiver: ConnectorReceiver,
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

    const parsed = receiver.schema.safeParse(rawParams);
    if (!parsed.success) {
      throw new ConnectorValidationError(
        `Invalid inbound payload for connector "${connector.name}": ${formatZodIssues(parsed.error.issues)}`,
        { connectorName: connector.name, cause: parsed.error },
      );
    }

    const hashKey = toContextHashKey(context);
    const dedupKey =
      meta?.idempotencyKey !== undefined && meta.idempotencyKey.length > 0
        ? buildInboundDedupKey(hashKey, meta.idempotencyKey)
        : undefined;

    return this.inboundQueue.run(hashKey, async () => {
      let existingSessionId = await this.contextStore.getSessionIdByHashKey(hashKey);
      if (
        existingSessionId !== undefined &&
        !(await this.sessionDriver.exists(existingSessionId))
      ) {
        await this.contextStore.removeSession(existingSessionId);
        existingSessionId = undefined;
      }

      if (dedupKey !== undefined) {
        if (existingSessionId !== undefined && this.deduplicator.has(dedupKey)) {
          return { sessionId: existingSessionId, deduplicated: true };
        }
        this.deduplicator.delete(dedupKey);
      }

      const rawFormatted = receiver.formatInbound?.(parsed.data, context);
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
