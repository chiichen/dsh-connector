import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
  type KvTable,
} from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import {
  assertNonEmptyContextId,
  assertValidConnectorName,
  CONNECTOR_CONTEXT_SEPARATOR,
  ConnectorValidationError,
  createConnectorContext,
  type ConnectorContext,
  type ConnectorContextId,
  type ConnectorContextIdGenerator,
  type ConnectorName,
} from "@dsh-connector/core";
import {
  CONNECTOR_STORAGE_DOMAIN_NAME,
  CONNECTOR_STORAGE_DOMAIN_VERSION,
  CONNECTOR_STORAGE_TABLE_NAME,
} from "./constants";
import { KeyedSerialQueue } from "./reliability";

/**
 * Plugin-internal globally unique hash key formatted strictly as `${connector_name}--${context_id}`.
 */
export type ConnectorContextHashKey = string & { readonly __brand: "ConnectorContextHashKey" };

export function toContextHashKey(context: ConnectorContext): ConnectorContextHashKey {
  assertValidConnectorName(context.connectorName);
  assertNonEmptyContextId(context.contextId, context.connectorName);
  return `${context.connectorName}${CONNECTOR_CONTEXT_SEPARATOR}${context.contextId}` as ConnectorContextHashKey;
}

export function parseContextHashKey(hashKey: string): {
  readonly connectorName: ConnectorName;
  readonly contextId: ConnectorContextId;
} {
  const sepIndex = hashKey.indexOf(CONNECTOR_CONTEXT_SEPARATOR);
  if (sepIndex <= 0) {
    throw new ConnectorValidationError(
      `Invalid ConnectorContextHashKey "${hashKey}": missing "${CONNECTOR_CONTEXT_SEPARATOR}" delimiter.`,
    );
  }
  const connectorName = hashKey.slice(0, sepIndex);
  const contextId = hashKey.slice(sepIndex + CONNECTOR_CONTEXT_SEPARATOR.length);
  assertValidConnectorName(connectorName);
  assertNonEmptyContextId(contextId, connectorName);
  return { connectorName, contextId };
}

export interface PersistedContextRecord {
  readonly sessionId: string;
  readonly connectorName: string;
  readonly contextId: ConnectorContextId;
}

export const persistedContextRecordSchema: z.ZodType<PersistedContextRecord> = z.object({
  sessionId: z.string().min(1),
  connectorName: z.string().refine(
    (val) => {
      try {
        assertValidConnectorName(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid connectorName" },
  ),
  contextId: z.string().transform((val, ctx) => {
    try {
      assertNonEmptyContextId(val);
      return val;
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid contextId",
      });
      return z.NEVER;
    }
  }),
});

/**
 * Declarative `@deepseek-ai/dsh-storage-domain` specification owned by `dsh-connector-plugin`.
 * Persisted via DSH's built-in storage hub (`@deepseek-ai/dsh-storage-json` / SQLite).
 */
export const CONNECTOR_CONTEXT_DOMAIN = defineDomain({
  name: CONNECTOR_STORAGE_DOMAIN_NAME,
  version: CONNECTOR_STORAGE_DOMAIN_VERSION,
  tables: {
    [CONNECTOR_STORAGE_TABLE_NAME]: domainTable<ConnectorContextHashKey, PersistedContextRecord>(
      persistedContextRecordSchema,
    ),
  },
});

export type ConnectorContextDomain = Domain<typeof CONNECTOR_CONTEXT_DOMAIN>;
export type ConnectorContextKvTable = KvTable<ConnectorContextHashKey, PersistedContextRecord>;

export interface ContextSessionStore {
  getSessionId(context: ConnectorContext): Promise<string | undefined>;
  getSessionIdByHashKey(hashKey: ConnectorContextHashKey): Promise<string | undefined>;
  getContext<const TName extends string = string>(
    sessionId: string,
    connectorName: TName,
  ): Promise<ConnectorContext<TName> | undefined>;
  getAllContexts(sessionId: string): Promise<Readonly<Record<string, ConnectorContext>>>;
  getOrCreateContext<const TName extends string>(
    sessionId: string,
    connectorOrName: { readonly name: TName } | TName,
    contextIdGenerator: ConnectorContextIdGenerator,
  ): Promise<ConnectorContext<TName>>;
  bind(sessionId: string, context: ConnectorContext): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
}

export class DefaultContextSessionStore implements ContextSessionStore {
  private readonly sessionToContexts = new Map<string, Map<string, ConnectorContext>>();
  private readonly hashKeyToSession = new Map<ConnectorContextHashKey, string>();
  private readonly singleFlight = new KeyedSerialQueue();
  private readonly table: ConnectorContextKvTable | undefined;

  constructor(table?: ConnectorContextKvTable) {
    this.table = table;
    if (table !== undefined) {
      for (const [rawKey, record] of table.entries()) {
        parseContextHashKey(rawKey);
        const ctx = createConnectorContext(record.connectorName, record.contextId);
        this.insertInMemory(record.sessionId, ctx, rawKey);
      }
    }
  }

  static fromDomain(domain: ConnectorContextDomain): DefaultContextSessionStore {
    return new DefaultContextSessionStore(domain.table(CONNECTOR_STORAGE_TABLE_NAME));
  }

  static async open(storageDomain: DomainFacility): Promise<{
    readonly store: DefaultContextSessionStore;
    readonly domain: ConnectorContextDomain;
  }> {
    const domain = await storageDomain.open(CONNECTOR_CONTEXT_DOMAIN);
    try {
      const store = DefaultContextSessionStore.fromDomain(domain);
      return { store, domain };
    } catch (error) {
      await domain.close();
      throw error;
    }
  }

  private insertInMemory(
    sessionId: string,
    context: ConnectorContext,
    hashKey: ConnectorContextHashKey,
  ): void {
    let byConnector = this.sessionToContexts.get(sessionId);
    if (byConnector === undefined) {
      byConnector = new Map();
      this.sessionToContexts.set(sessionId, byConnector);
    }
    byConnector.set(context.connectorName, context);
    this.hashKeyToSession.set(hashKey, sessionId);
  }

  async getSessionId(context: ConnectorContext): Promise<string | undefined> {
    return this.hashKeyToSession.get(toContextHashKey(context));
  }

  async getSessionIdByHashKey(hashKey: ConnectorContextHashKey): Promise<string | undefined> {
    return this.hashKeyToSession.get(hashKey);
  }

  async getContext<const TName extends string = string>(
    sessionId: string,
    connectorName: TName,
  ): Promise<ConnectorContext<TName> | undefined> {
    return this.sessionToContexts.get(sessionId)?.get(connectorName) as
      | ConnectorContext<TName>
      | undefined;
  }

  async getAllContexts(sessionId: string): Promise<Readonly<Record<string, ConnectorContext>>> {
    const byConnector = this.sessionToContexts.get(sessionId);
    if (byConnector === undefined) {
      return Object.freeze({});
    }
    return Object.freeze(Object.fromEntries(byConnector.entries()));
  }

  async bind(sessionId: string, context: ConnectorContext): Promise<void> {
    if (sessionId.trim().length === 0) {
      throw new ConnectorValidationError("sessionId must be a non-empty string.", {
        connectorName: context.connectorName,
      });
    }
    const frozenCtx = createConnectorContext(context.connectorName, context.contextId);
    const hashKey = toContextHashKey(frozenCtx);

    const existingOwnerSession = this.hashKeyToSession.get(hashKey);
    if (existingOwnerSession !== undefined && existingOwnerSession !== sessionId) {
      throw new ConnectorValidationError(
        `Context "${hashKey}" is already bound to session "${existingOwnerSession}" and cannot be rebound to "${sessionId}".`,
        { connectorName: frozenCtx.connectorName },
      );
    }

    const existingForConnector = this.sessionToContexts
      .get(sessionId)
      ?.get(frozenCtx.connectorName);
    if (existingForConnector !== undefined) {
      if (existingForConnector.contextId === frozenCtx.contextId) {
        return;
      }
      throw new ConnectorValidationError(
        `Session "${sessionId}" already has an initialized context "${existingForConnector.contextId}" for connector "${frozenCtx.connectorName}".`,
        { connectorName: frozenCtx.connectorName },
      );
    }

    if (this.table !== undefined) {
      await this.table.put(hashKey, {
        sessionId,
        connectorName: frozenCtx.connectorName,
        contextId: frozenCtx.contextId,
      });
    }
    this.insertInMemory(sessionId, frozenCtx, hashKey);
  }

  async getOrCreateContext<const TName extends string>(
    sessionId: string,
    connectorOrName: { readonly name: TName } | TName,
    contextIdGenerator: ConnectorContextIdGenerator,
  ): Promise<ConnectorContext<TName>> {
    const connectorName =
      typeof connectorOrName === "string" ? connectorOrName : connectorOrName.name;
    const lockKey = `${sessionId}${CONNECTOR_CONTEXT_SEPARATOR}${connectorName}`;
    return this.singleFlight.run(lockKey, async () => {
      const existing = await this.getContext(sessionId, connectorName);
      if (existing !== undefined) {
        return existing;
      }

      const generatedId = contextIdGenerator.generate(connectorName);
      const created = createConnectorContext(connectorName, generatedId);
      await this.bind(sessionId, created);
      return created;
    });
  }

  async removeSession(sessionId: string): Promise<void> {
    const byConnector = this.sessionToContexts.get(sessionId);
    if (byConnector === undefined) {
      return;
    }

    const removedHashKeys: ConnectorContextHashKey[] = [];
    for (const ctx of byConnector.values()) {
      const hashKey = toContextHashKey(ctx);
      removedHashKeys.push(hashKey);
    }

    if (this.table !== undefined && removedHashKeys.length > 0) {
      await this.table.deleteMany(removedHashKeys);
    }

    for (const hashKey of removedHashKeys) {
      this.hashKeyToSession.delete(hashKey);
    }
    this.sessionToContexts.delete(sessionId);
  }
}
