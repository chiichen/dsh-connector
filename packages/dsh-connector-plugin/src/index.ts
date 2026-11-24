import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-storage-domain";
import type {} from "@deepseek-ai/dsh-tools";
import {
  CONNECTOR_CORE_VERSION,
  type Connector,
  type ConnectorContextIdGenerator,
  type ConnectorLogger,
} from "@dsh-connector/core";
import {
  CONNECTOR_PLUGIN_NAME,
  CONNECTOR_STORAGE_DOMAIN_NAME,
  CONNECTOR_STORAGE_DOMAIN_VERSION,
  CONNECTOR_STORAGE_TABLE_NAME,
  DEFAULT_DEDUPLICATION_MAX_ENTRIES,
  DEFAULT_DEDUPLICATION_TTL_MS,
  DEFAULT_TOOL_NAME_PREFIX,
  DEFAULT_WEBHOOK_BASE_PATH,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
} from "./constants";
import {
  CONNECTOR_CONTEXT_DOMAIN,
  DefaultContextSessionStore,
  parseContextHashKey,
  persistedContextRecordSchema,
  toContextHashKey,
  type ConnectorContextDomain,
  type ConnectorContextHashKey,
  type ConnectorContextKvTable,
  type ContextSessionStore,
  type PersistedContextRecord,
} from "./context-store";
import { ConnectorManager } from "./manager";
import { createConnectorsFromPlatformConfig } from "./platforms/instantiate";
import { mergePlatformConfigs } from "./platforms/merge";
import { platformSettingsSchema } from "./platforms/schema";
import type { PlatformsConfig } from "./platforms/types";
import { DshSessionDriver } from "./session-driver";
import { registerConnectorTools } from "./tool-bridge";
import { mountConnectorWebhooks } from "./webhook-router";

export const DSH_CONNECTOR_PLUGIN_VERSION: string = CONNECTOR_CORE_VERSION;

export const name = CONNECTOR_PLUGIN_NAME;
export const inject = ["agents", "sessions", "tools", "storageDomain"] as const;

export interface ConnectorPluginWebhookConfig {
  readonly enabled?: boolean;
  readonly basePath?: string;
  readonly maxBodyBytes?: number;
}

export interface ConnectorPluginDeduplicationConfig {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export interface ConnectorPluginConfig {
  readonly connectors?: readonly Connector[];
  readonly contextStore?: ContextSessionStore;
  readonly defaultSessionCwd?: string;
  readonly workspaceId?: string;
  readonly contextIdGenerator?: ConnectorContextIdGenerator;
  readonly toolNamePrefix?: string;
  readonly webhook?: ConnectorPluginWebhookConfig;
  readonly deduplication?: ConnectorPluginDeduplicationConfig;
  readonly logger?: ConnectorLogger;
  readonly platforms?: PlatformsConfig;
}

export const Config: Schema<ConnectorPluginConfig> = Schema.object({
  defaultSessionCwd: Schema.string(),
  workspaceId: Schema.string(),
  toolNamePrefix: Schema.string().default(DEFAULT_TOOL_NAME_PREFIX),
  webhook: Schema.object({
    enabled: Schema.boolean().default(true),
    basePath: Schema.string().default(DEFAULT_WEBHOOK_BASE_PATH),
    maxBodyBytes: Schema.number().step(1).min(1).default(DEFAULT_WEBHOOK_MAX_BODY_BYTES),
  }),
  deduplication: Schema.object({
    ttlMs: Schema.number().step(1).min(1).default(DEFAULT_DEDUPLICATION_TTL_MS),
    maxEntries: Schema.number().step(1).min(1).default(DEFAULT_DEDUPLICATION_MAX_ENTRIES),
  }),
  platforms: platformSettingsSchema,
}) as unknown as Schema<ConnectorPluginConfig>;

export interface ConnectorPluginRuntime {
  readonly manager: ConnectorManager;
  readonly contextStore: ContextSessionStore;
  dispose(): Promise<void>;
}

/** Cleanup Cordis collects from `apply`. Calling it twice is safe. */
export type ConnectorPluginDisposer = () => Promise<void>;

export interface ConnectorCordisPlugin {
  readonly name: typeof name;
  readonly inject: typeof inject;
  apply(
    ctx: Context,
    overrideConfig?: Partial<ConnectorPluginConfig>,
  ): Promise<ConnectorPluginDisposer>;
}

async function resolveContextStore(
  ctx: Context,
  config: ConnectorPluginConfig,
): Promise<{
  readonly store: ContextSessionStore;
  readonly openedDomain?: ConnectorContextDomain;
}> {
  if (config.contextStore !== undefined) {
    return { store: config.contextStore };
  }
  const { store, domain } = await DefaultContextSessionStore.open(ctx.storageDomain);
  return { store, openedDomain: domain };
}

/**
 * Adapts Cordis `ctx.logger("dsh-connector-plugin")` to `ConnectorLogger`.
 * dsh does not print `ctx.logger` to the terminal by default; the profile needs a log exporter to show these lines there.
 */
function adaptCordisLogger(ctx: Context, explicit?: ConnectorLogger): ConnectorLogger {
  if (explicit !== undefined) return explicit;
  const cordisLogger = ctx.logger(CONNECTOR_PLUGIN_NAME);
  return {
    debug: (msg, meta) => {
      cordisLogger.debug(
        meta !== undefined ? `${msg} %o` : msg,
        ...(meta !== undefined ? [meta] : []),
      );
    },
    info: (msg, meta) => {
      cordisLogger.info(
        meta !== undefined ? `${msg} %o` : msg,
        ...(meta !== undefined ? [meta] : []),
      );
    },
    warn: (msg, meta) => {
      cordisLogger.warn(
        meta !== undefined ? `${msg} %o` : msg,
        ...(meta !== undefined ? [meta] : []),
      );
    },
    error: (msg, meta) => {
      cordisLogger.error(
        meta !== undefined ? `${msg} %o` : msg,
        ...(meta !== undefined ? [meta] : []),
      );
    },
  };
}

export async function mountConnectorPlugin(
  ctx: Context,
  config: ConnectorPluginConfig = {},
): Promise<ConnectorPluginRuntime> {
  const { store: contextStore, openedDomain } = await resolveContextStore(ctx, config);
  const logger = adaptCordisLogger(ctx, config.logger);

  const sessionDriver = new DshSessionDriver(ctx, {
    ...(config.defaultSessionCwd !== undefined ? { defaultCwd: config.defaultSessionCwd } : {}),
    ...(config.workspaceId !== undefined ? { workspaceId: config.workspaceId } : {}),
  });

  const manager = new ConnectorManager({
    connectors: [
      ...createConnectorsFromPlatformConfig(config.platforms, logger),
      ...(config.connectors ?? []),
    ],
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
    logger,
  });

  let disposeTools: (() => void) | undefined;
  let disposeWebServerInjector: (() => Promise<void>) | undefined;
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;

    if (disposeWebServerInjector !== undefined) {
      await disposeWebServerInjector();
      disposeWebServerInjector = undefined;
    }

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
        logger,
      };

      // Reuse DSH's built-in @deepseek-ai/dsh-host-webserver (`ctx.webServer`) whenever active.
      const webFiber = ctx.inject(["webServer"], (webCtx) => {
        webCtx.effect(() => mountConnectorWebhooks(webCtx.webServer, manager, routerOptions));
      });
      disposeWebServerInjector = webFiber.dispose;
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    manager,
    contextStore,
    dispose,
  };
}

/**
 * Cordis treats this function's return value as the plugin effect.
 * The promise must settle to a disposer or to nothing. A runtime object is
 * `TypeError: Invalid effect` inside `safeCollect`.
 *
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/fiber.ts
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md
 */
export async function apply(
  ctx: Context,
  config: ConnectorPluginConfig = {},
): Promise<ConnectorPluginDisposer> {
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

  return async () => {
    state.disposed = true;
    await runtime.dispose();
  };
}

export function createConnectorPlugin(defaultConfig: ConnectorPluginConfig): ConnectorCordisPlugin {
  return {
    name,
    inject,
    apply: (ctx, overrideConfig) => {
      const platforms = mergePlatformConfigs(defaultConfig.platforms, overrideConfig?.platforms);
      return apply(ctx, {
        ...defaultConfig,
        ...overrideConfig,
        ...(defaultConfig.webhook !== undefined || overrideConfig?.webhook !== undefined
          ? { webhook: { ...defaultConfig.webhook, ...overrideConfig?.webhook } }
          : {}),
        ...(platforms !== undefined ? { platforms } : {}),
      });
    },
  };
}

export {
  CONNECTOR_PLUGIN_NAME,
  CONNECTOR_STORAGE_DOMAIN_NAME,
  CONNECTOR_STORAGE_DOMAIN_VERSION,
  CONNECTOR_STORAGE_TABLE_NAME,
  DEFAULT_DEDUPLICATION_MAX_ENTRIES,
  DEFAULT_DEDUPLICATION_TTL_MS,
  DEFAULT_TOOL_NAME_PREFIX,
  DEFAULT_WEBHOOK_BASE_PATH,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
};
export {
  CONNECTOR_CONTEXT_DOMAIN,
  DefaultContextSessionStore,
  parseContextHashKey,
  persistedContextRecordSchema,
  toContextHashKey,
  type ConnectorContextDomain,
  type ConnectorContextHashKey,
  type ConnectorContextKvTable,
  type ContextSessionStore,
  type PersistedContextRecord,
};
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
  createWebhookHttpHandler,
  mountConnectorWebhooks,
  type WebhookRouterOptions,
} from "./webhook-router";
export { createConnectorsFromPlatformConfig } from "./platforms/instantiate";
export { mergePlatformConfigs } from "./platforms/merge";
export { platformSettingsSchema } from "./platforms/schema";
export { PLATFORM_IDS, type PlatformId, type PlatformsConfig } from "./platforms/types";
export {
  dshJsonSchemaNodeSchema,
  dshObjectJsonSchema,
  jsonSchemaScalarSchema,
  jsonSchemaTypeSchema,
  zodToDshJsonSchema,
  type AssertExactType,
} from "./zod-json-schema";
