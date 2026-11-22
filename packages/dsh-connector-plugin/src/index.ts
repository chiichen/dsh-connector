import {
  CONNECTOR_CORE_VERSION,
  type Connector,
  type ConnectorContextIdGenerator,
  type ConnectorLogger,
} from "@dsh-connector/core";
import {
  DefaultContextSessionStore,
  DshStorageDomainAdapter,
  InMemoryContextStorageAdapter,
  JsonFileContextStorageAdapter,
  parseContextHashKey,
  toContextHashKey,
  type ConnectorContextHashKey,
  type ContextSessionStore,
  type ContextStorageAdapter,
  type DshKvTableLike,
  type PersistedContextRecord,
} from "./context-store";
import type { DshCordisContextLike, DshOpenedDomainLike } from "./dsh-types";
import { ConnectorManager } from "./manager";
import { DshSessionDriver } from "./session-driver";
import { registerConnectorTools } from "./tool-bridge";
import {
  createStandaloneWebhookServer,
  mountConnectorWebhooks,
  type StandaloneWebhookServerHandle,
} from "./webhook-router";

export const DSH_CONNECTOR_PLUGIN_VERSION: string = CONNECTOR_CORE_VERSION;

export const name = "dsh-connector-plugin" as const;
export const inject = ["agents", "sessions", "tools"] as const;

const DEFAULT_STORAGE_TABLE = "connector_contexts";

export interface ConnectorPluginWebhookConfig {
  readonly enabled?: boolean;
  readonly basePath?: string;
  readonly maxBodyBytes?: number;
  readonly standalone?: {
    readonly host?: string;
    readonly port: number;
  };
}

export interface ConnectorPluginDeduplicationConfig {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export interface ConnectorPluginConfig {
  readonly connectors?: readonly Connector[];
  readonly contextStore?: ContextSessionStore;
  readonly storageAdapter?: ContextStorageAdapter;
  readonly storageFilePath?: string;
  readonly storageDomainSpec?: unknown;
  readonly storageTableName?: string;
  readonly defaultSessionCwd?: string;
  readonly workspaceId?: string;
  readonly contextIdGenerator?: ConnectorContextIdGenerator;
  readonly toolNamePrefix?: string;
  readonly webhook?: ConnectorPluginWebhookConfig;
  readonly deduplication?: ConnectorPluginDeduplicationConfig;
  readonly logger?: ConnectorLogger;
}

export interface ConnectorPluginRuntime {
  readonly manager: ConnectorManager;
  readonly contextStore: ContextSessionStore;
  readonly standaloneWebhookPort?: number;
  dispose(): Promise<void>;
}

export interface ConnectorCordisPlugin {
  readonly name: typeof name;
  readonly inject: typeof inject;
  apply(
    ctx: DshCordisContextLike,
    overrideConfig?: Partial<ConnectorPluginConfig>,
  ): Promise<ConnectorPluginRuntime>;
}

async function resolveContextStore(
  ctx: DshCordisContextLike,
  config: ConnectorPluginConfig,
): Promise<{
  store: ContextSessionStore;
  openedDomain?: DshOpenedDomainLike;
}> {
  if (config.contextStore !== undefined) {
    return { store: config.contextStore };
  }
  if (config.storageAdapter !== undefined) {
    return { store: await DefaultContextSessionStore.open(config.storageAdapter) };
  }
  if (config.storageFilePath !== undefined) {
    const fileAdapter = new JsonFileContextStorageAdapter(config.storageFilePath);
    return { store: await DefaultContextSessionStore.open(fileAdapter) };
  }
  const storageDomain = ctx.get("storageDomain");
  if (storageDomain !== undefined) {
    const openedDomain = await storageDomain.open(config.storageDomainSpec ?? { id: name });
    try {
      const table = openedDomain.table(config.storageTableName ?? DEFAULT_STORAGE_TABLE);
      const store = await DefaultContextSessionStore.open(new DshStorageDomainAdapter(table));
      return { store, openedDomain };
    } catch (error) {
      await openedDomain.close();
      throw error;
    }
  }
  return {
    store: await DefaultContextSessionStore.open(new InMemoryContextStorageAdapter()),
  };
}

function adaptCordisLogger(
  ctx: DshCordisContextLike,
  explicit?: ConnectorLogger,
): ConnectorLogger | undefined {
  if (explicit !== undefined) return explicit;
  if (ctx.logger === undefined) return undefined;
  return {
    debug: (msg, meta) => ctx.logger?.debug?.(msg, meta),
    info: (msg, meta) => ctx.logger?.info?.(msg, meta),
    warn: (msg, meta) => ctx.logger?.warn?.(msg, meta),
    error: (msg, meta) => ctx.logger?.error?.(msg, meta),
  };
}

export async function mountConnectorPlugin(
  ctx: DshCordisContextLike,
  config: ConnectorPluginConfig = {},
): Promise<ConnectorPluginRuntime> {
  const { store: contextStore, openedDomain } = await resolveContextStore(ctx, config);
  const logger = adaptCordisLogger(ctx, config.logger);

  const sessionDriver = new DshSessionDriver(ctx, {
    ...(config.defaultSessionCwd !== undefined ? { defaultCwd: config.defaultSessionCwd } : {}),
    ...(config.workspaceId !== undefined ? { workspaceId: config.workspaceId } : {}),
  });

  const manager = new ConnectorManager({
    connectors: config.connectors ?? [],
    contextStore,
    sessionDriver,
    ...(config.contextIdGenerator !== undefined
      ? { contextIdGenerator: config.contextIdGenerator }
      : {}),
    ...(config.deduplication?.ttlMs !== undefined
      ? { deduplicationTtlMs: config.deduplication.ttlMs }
      : {}),
    ...(config.deduplication?.maxEntries !== undefined
      ? { deduplicationMaxEntries: config.deduplication.maxEntries }
      : {}),
    ...(logger !== undefined ? { logger } : {}),
  });

  let disposeTools: (() => void) | undefined;
  let disposeWebServerRoute: (() => void) | undefined;
  let standaloneServer: StandaloneWebhookServerHandle | undefined;
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;

    if (standaloneServer !== undefined) {
      await standaloneServer.close();
      standaloneServer = undefined;
    }
    disposeWebServerRoute?.();
    disposeWebServerRoute = undefined;

    disposeTools?.();
    disposeTools = undefined;

    await manager.stopAll();

    if (openedDomain !== undefined) {
      await openedDomain.close();
    }
  };

  try {
    await manager.startAll();

    disposeTools = registerConnectorTools(
      ctx.tools,
      manager,
      config.toolNamePrefix !== undefined ? { toolNamePrefix: config.toolNamePrefix } : undefined,
    );

    const webhookEnabled = config.webhook?.enabled ?? true;
    if (webhookEnabled) {
      const routerOptions = {
        ...(config.webhook?.basePath !== undefined ? { basePath: config.webhook.basePath } : {}),
        ...(config.webhook?.maxBodyBytes !== undefined
          ? { maxBodyBytes: config.webhook.maxBodyBytes }
          : {}),
        ...(logger !== undefined ? { logger } : {}),
      };

      const webServer = ctx.get("webServer");
      if (webServer !== undefined) {
        disposeWebServerRoute = mountConnectorWebhooks(webServer, manager, routerOptions);
      }

      if (config.webhook?.standalone !== undefined) {
        standaloneServer = await createStandaloneWebhookServer(manager, {
          ...routerOptions,
          ...(config.webhook.standalone.host !== undefined
            ? { host: config.webhook.standalone.host }
            : {}),
          port: config.webhook.standalone.port,
        });
      }
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    manager,
    contextStore,
    ...(standaloneServer !== undefined ? { standaloneWebhookPort: standaloneServer.port } : {}),
    dispose,
  };
}

export async function apply(
  ctx: DshCordisContextLike,
  config: ConnectorPluginConfig = {},
): Promise<ConnectorPluginRuntime> {
  const state: { disposed: boolean; runtime?: ConnectorPluginRuntime } = { disposed: false };

  ctx.effect(() => {
    return async () => {
      state.disposed = true;
      if (state.runtime !== undefined) {
        await state.runtime.dispose();
      }
    };
  });

  const runtime = await mountConnectorPlugin(ctx, config);
  state.runtime = runtime;

  if (state.disposed) {
    await runtime.dispose();
  }

  return runtime;
}

export function createConnectorPlugin(defaultConfig: ConnectorPluginConfig): ConnectorCordisPlugin {
  return {
    name,
    inject,
    apply: (ctx, overrideConfig) =>
      apply(ctx, {
        ...defaultConfig,
        ...overrideConfig,
        ...(defaultConfig.webhook !== undefined || overrideConfig?.webhook !== undefined
          ? { webhook: { ...defaultConfig.webhook, ...overrideConfig?.webhook } }
          : {}),
      }),
  };
}

export {
  DefaultContextSessionStore,
  DshStorageDomainAdapter,
  InMemoryContextStorageAdapter,
  JsonFileContextStorageAdapter,
  parseContextHashKey,
  toContextHashKey,
  type ConnectorContextHashKey,
  type ContextSessionStore,
  type ContextStorageAdapter,
  type DshKvTableLike,
  type PersistedContextRecord,
};
export type {
  DshAgentDefaultModelLike,
  DshAgentLike,
  DshAgentsServiceLike,
  DshCordisContextLike,
  DshOpenedDomainLike,
  DshOptionalServicesMap,
  DshSessionControllerLike,
  DshSessionPersistenceLike,
  DshSessionsServiceLike,
  DshSessionTitleLike,
  DshStorageDomainLike,
  DshTextPartLike,
  DshToolDefinitionLike,
  DshToolRunContextLike,
  DshToolsServiceLike,
  DshWebServerLike,
  DshWebServerRouteLike,
} from "./dsh-types";
export {
  ConnectorManager,
  type ConnectorManagerOptions,
  type RegisteredConnectorEntry,
  type SendableConnectorEntry,
} from "./manager";
export { KeyedSerialQueue, TtlDeduplicator, type TtlDeduplicatorOptions } from "./reliability";
export {
  DshSessionDriver,
  type DshSessionDriverOptions,
  type SessionDriver,
} from "./session-driver";
export {
  formatConnectorToolName,
  registerConnectorTools,
  type ToolBridgeOptions,
} from "./tool-bridge";
export {
  createStandaloneWebhookServer,
  createWebhookHttpHandler,
  mountConnectorWebhooks,
  type StandaloneWebhookServerHandle,
  type StandaloneWebhookServerOptions,
  type WebhookRouterOptions,
} from "./webhook-router";
export {
  zodToDshJsonSchema,
  type DshJsonPrimitiveType,
  type DshJsonSchema,
  type DshObjectJsonSchema,
} from "./zod-json-schema";
