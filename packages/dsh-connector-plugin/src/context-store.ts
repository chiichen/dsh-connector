import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConnectorValidationError,
  assertNonEmptyContextId,
  assertValidConnectorName,
  createConnectorContext,
  type ConnectorBase,
  type ConnectorContext,
  type ConnectorContextId,
  type ConnectorContextIdGenerator,
  type ConnectorName,
} from "@dsh-connector/core";
import { KeyedSerialQueue } from "./reliability.js";

/**
 * Plugin-internal globally unique hash key formatted strictly as `${connector_name}--${context_id}`.
 */
export type ConnectorContextHashKey = string & { readonly __brand: "ConnectorContextHashKey" };

export function toContextHashKey(context: ConnectorContext): ConnectorContextHashKey {
  assertValidConnectorName(context.connectorName);
  assertNonEmptyContextId(context.contextId, context.connectorName);
  return `${context.connectorName}--${context.contextId}` as ConnectorContextHashKey;
}

export function parseContextHashKey(hashKey: string): {
  readonly connectorName: ConnectorName;
  readonly contextId: ConnectorContextId;
} {
  const sepIndex = hashKey.indexOf("--");
  if (sepIndex <= 0) {
    throw new ConnectorValidationError(
      `Invalid ConnectorContextHashKey "${hashKey}": missing "--" delimiter.`,
    );
  }
  const connectorName = hashKey.slice(0, sepIndex);
  const contextId = hashKey.slice(sepIndex + 2);
  assertValidConnectorName(connectorName);
  assertNonEmptyContextId(contextId, connectorName);
  return { connectorName, contextId };
}

export interface PersistedContextRecord {
  readonly sessionId: string;
  readonly connectorName: string;
  readonly contextId: ConnectorContextId;
}

export interface ContextStorageAdapter {
  loadAll(): Promise<ReadonlyMap<ConnectorContextHashKey, PersistedContextRecord>>;
  put(hashKey: ConnectorContextHashKey, record: PersistedContextRecord): Promise<void>;
  deleteMany(hashKeys: readonly ConnectorContextHashKey[]): Promise<void>;
}

export class InMemoryContextStorageAdapter implements ContextStorageAdapter {
  private readonly records = new Map<ConnectorContextHashKey, PersistedContextRecord>();

  async loadAll(): Promise<ReadonlyMap<ConnectorContextHashKey, PersistedContextRecord>> {
    return new Map(this.records);
  }

  async put(hashKey: ConnectorContextHashKey, record: PersistedContextRecord): Promise<void> {
    this.records.set(hashKey, record);
  }

  async deleteMany(hashKeys: readonly ConnectorContextHashKey[]): Promise<void> {
    for (const key of hashKeys) {
      this.records.delete(key);
    }
  }
}

export class JsonFileContextStorageAdapter implements ContextStorageAdapter {
  private readonly writeQueue = new KeyedSerialQueue();

  constructor(private readonly filePath: string) {}

  async loadAll(): Promise<ReadonlyMap<ConnectorContextHashKey, PersistedContextRecord>> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Map();
      }
      throw error;
    }

    const parsed = JSON.parse(content) as Record<string, PersistedContextRecord>;
    const map = new Map<ConnectorContextHashKey, PersistedContextRecord>();
    for (const [rawKey, record] of Object.entries(parsed)) {
      parseContextHashKey(rawKey);
      map.set(rawKey as ConnectorContextHashKey, record);
    }
    return map;
  }

  async put(hashKey: ConnectorContextHashKey, record: PersistedContextRecord): Promise<void> {
    await this.writeQueue.run("file", async () => {
      const current = new Map(await this.loadAll());
      current.set(hashKey, record);
      await this.flushAtomically(current);
    });
  }

  async deleteMany(hashKeys: readonly ConnectorContextHashKey[]): Promise<void> {
    if (hashKeys.length === 0) return;
    await this.writeQueue.run("file", async () => {
      const current = new Map(await this.loadAll());
      for (const key of hashKeys) {
        current.delete(key);
      }
      await this.flushAtomically(current);
    });
  }

  private async flushAtomically(
    records: ReadonlyMap<ConnectorContextHashKey, PersistedContextRecord>,
  ): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const serialized = JSON.stringify(Object.fromEntries(records), null, 2);
    const tempFile = `${this.filePath}.tmp-${randomUUID()}`;
    await writeFile(tempFile, serialized, "utf8");
    await rename(tempFile, this.filePath);
  }
}

export interface DshKvTableLike {
  entries(): Promise<Iterable<readonly [string, PersistedContextRecord]>>;
  set(key: string, value: PersistedContextRecord): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

export class DshStorageDomainAdapter implements ContextStorageAdapter {
  constructor(private readonly table: DshKvTableLike) {}

  async loadAll(): Promise<ReadonlyMap<ConnectorContextHashKey, PersistedContextRecord>> {
    const map = new Map<ConnectorContextHashKey, PersistedContextRecord>();
    for (const [rawKey, record] of await this.table.entries()) {
      parseContextHashKey(rawKey);
      map.set(rawKey as ConnectorContextHashKey, record);
    }
    return map;
  }

  async put(hashKey: ConnectorContextHashKey, record: PersistedContextRecord): Promise<void> {
    await this.table.set(hashKey, record);
  }

  async deleteMany(hashKeys: readonly ConnectorContextHashKey[]): Promise<void> {
    await Promise.all(hashKeys.map((key) => this.table.delete(key)));
  }
}

export interface ContextSessionStore {
  getSessionId(context: ConnectorContext): Promise<string | undefined>;
  getSessionIdByHashKey(hashKey: ConnectorContextHashKey): Promise<string | undefined>;
  getContext<TConnector extends ConnectorBase>(
    sessionId: string,
    connectorName: TConnector["name"],
  ): Promise<ConnectorContext<TConnector> | undefined>;
  getAllContexts(sessionId: string): Promise<Readonly<Record<string, ConnectorContext>>>;
  getOrCreateContext<TConnector extends ConnectorBase>(
    sessionId: string,
    connector: TConnector,
    contextIdGenerator: ConnectorContextIdGenerator,
  ): Promise<ConnectorContext<TConnector>>;
  bind(sessionId: string, context: ConnectorContext): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
}

export class DefaultContextSessionStore implements ContextSessionStore {
  private readonly sessionToContexts = new Map<string, Map<string, ConnectorContext>>();
  private readonly hashKeyToSession = new Map<ConnectorContextHashKey, string>();
  private readonly singleFlight = new KeyedSerialQueue();
  private readonly adapter: ContextStorageAdapter;

  constructor(adapter: ContextStorageAdapter = new InMemoryContextStorageAdapter()) {
    this.adapter = adapter;
  }

  static async open(adapter: ContextStorageAdapter): Promise<DefaultContextSessionStore> {
    const store = new DefaultContextSessionStore(adapter);
    await store.hydrate();
    return store;
  }

  private async hydrate(): Promise<void> {
    const stored = await this.adapter.loadAll();
    for (const [hashKey, record] of stored.entries()) {
      const ctx = createConnectorContext(record.connectorName, record.contextId);
      this.insertInMemory(record.sessionId, ctx, hashKey);
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

  async getContext<TConnector extends ConnectorBase>(
    sessionId: string,
    connectorName: TConnector["name"],
  ): Promise<ConnectorContext<TConnector> | undefined> {
    return this.sessionToContexts.get(sessionId)?.get(connectorName) as
      | ConnectorContext<TConnector>
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

    this.insertInMemory(sessionId, frozenCtx, hashKey);
    await this.adapter.put(hashKey, {
      sessionId,
      connectorName: frozenCtx.connectorName,
      contextId: frozenCtx.contextId,
    });
  }

  async getOrCreateContext<TConnector extends ConnectorBase>(
    sessionId: string,
    connector: TConnector,
    contextIdGenerator: ConnectorContextIdGenerator,
  ): Promise<ConnectorContext<TConnector>> {
    const lockKey = `${sessionId}--${connector.name}`;
    return this.singleFlight.run(lockKey, async () => {
      const existing = await this.getContext<TConnector>(sessionId, connector.name);
      if (existing !== undefined) {
        return existing;
      }

      const generatedId = contextIdGenerator.generate(connector.name);
      const created = createConnectorContext(connector, generatedId);
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
      this.hashKeyToSession.delete(hashKey);
      removedHashKeys.push(hashKey);
    }
    this.sessionToContexts.delete(sessionId);
    await this.adapter.deleteMany(removedHashKeys);
  }
}
