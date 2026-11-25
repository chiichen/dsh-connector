import { useCallback, useRef, useSyncExternalStore, type ReactElement } from "react";
import enLocale from "../../locale/en.json";
import zhLocale from "../../locale/zh.json";
import { CONNECTOR_PLUGIN_NAME } from "../constants";
import { isRecord } from "../platforms/records";
import type { PlatformsConfig } from "../platforms/types";
import { workspaceIdFromConfigValue, type WorkspaceChoice } from "../workspace-selection";
import { platformSettingsOps, workspaceSettingsOp, type SettingsPathOp } from "./persist";
import { ConnectorSettingsPanel, normalizeLocale, type WorkspaceListStatus } from "./panel";
import css from "./panel.module.css";

/**
 * Settings page for the connector plugin.
 * The rail-and-form interaction follows dsh-im's per-platform settings page.
 * Field names come from each connector's constructor options, not from dsh-im.
 * Presentation uses a CSS Module, the same way a first-party settings
 * section imports its own `*.module.css`.
 */

export const name = CONNECTOR_PLUGIN_NAME;
export const inject = ["slots", "configForms", "locale", "workspaces"] as const;

export const CONFIG_ENTRY_ID = CONNECTOR_PLUGIN_NAME;
export const SETTINGS_SECTION_ID = CONNECTOR_PLUGIN_NAME;
export const LOCALE_NAMESPACE = CONNECTOR_PLUGIN_NAME;

const SECTION_ORDER = 40;

export interface ConfigFormSnapshot {
  readonly value: unknown;
  readonly writable?: boolean;
  readonly revision?: number;
}

export interface ConfigFormHandle {
  getSnapshot(): ConfigFormSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean> | boolean;
  mutate(ops: readonly SettingsPathOp[]): Promise<boolean> | boolean;
}

/**
 * One row of `ctx.workspaces.list`.
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-controller/src/types.ts
 */
export interface SettingsWorkspaceView {
  readonly workspaceId: string;
  readonly title: string;
  readonly path: string;
}

/**
 * Snapshot from `ctx.workspaces.list.getSnapshot()`.
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-controller/src/client/model.ts
 */
export interface SettingsWorkspaceSnapshot {
  readonly items: readonly SettingsWorkspaceView[];
  readonly phase: "pending" | "ready";
  readonly error: { readonly message: string } | null;
}

/**
 * `ctx.workspaces.list`, the client projection of the current profile's workspaces.
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-controller/src/client/service.ts
 */
export interface SettingsWorkspaceList {
  getSnapshot(): SettingsWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
}

const EMPTY_WORKSPACE_SNAPSHOT: SettingsWorkspaceSnapshot = {
  items: [],
  phase: "pending",
  error: null,
};

function sameWorkspaceSnapshot(
  left: SettingsWorkspaceSnapshot,
  right: SettingsWorkspaceSnapshot,
): boolean {
  if (left.phase !== right.phase || left.error?.message !== right.error?.message) return false;
  if (left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => {
    const other = right.items[index];
    return (
      other !== undefined &&
      item.workspaceId === other.workspaceId &&
      item.title === other.title &&
      item.path === other.path
    );
  });
}

export function workspaceChoices(
  items: readonly SettingsWorkspaceView[],
): readonly WorkspaceChoice[] {
  return items.map((item) => ({
    id: item.workspaceId,
    title: item.title,
    path: item.path,
  }));
}

export function workspaceListStatus(
  source: SettingsWorkspaceList | undefined,
  snapshot: SettingsWorkspaceSnapshot,
): WorkspaceListStatus {
  if (source === undefined) return "absent";
  if (snapshot.error !== null) return "error";
  if (snapshot.phase === "ready") return "ready";
  return "loading";
}

export interface ConnectorSettingsHost {
  effect(callback: () => void | (() => void)): void;
  workspaces?: { readonly list: SettingsWorkspaceList };
  locale: {
    register(
      namespace: string,
      dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>,
    ): void | (() => void);
    bind(namespace: string): (key: string) => string;
    getSnapshot?: () => { readonly active?: string } | undefined;
  };
  configForms: {
    get(entryId: string): ConfigFormHandle;
  };
  slots: {
    inject(slot: string, setup: () => () => void): () => void;
    register(
      options: {
        readonly name: string;
        readonly id: string;
        readonly order: number;
        readonly label: () => string;
        readonly locale: string;
        readonly inject: () => {
          readonly form: ConfigFormHandle;
          readonly localeTag: string;
          readonly workspaces?: { readonly list: SettingsWorkspaceList };
        };
      },
      component: (props: {
        readonly form?: ConfigFormHandle;
        readonly localeTag?: string;
        readonly workspaces?: { readonly list: SettingsWorkspaceList };
      }) => ReactElement,
    ): () => void;
  };
}

export function readLocaleTag(locale: {
  getSnapshot?: () => { readonly active?: string } | undefined;
}): string {
  const active = locale.getSnapshot?.()?.active;
  return typeof active === "string" && active.length > 0 ? active : "en";
}

export function platformsFromConfigValue(value: unknown): PlatformsConfig | undefined {
  if (!isRecord(value)) return undefined;
  const platforms = value.platforms;
  if (!isRecord(platforms)) return undefined;
  return platforms as PlatformsConfig;
}

function useConfigForm(form: ConfigFormHandle): ConfigFormSnapshot {
  const cache = useRef<{
    readonly read: () => ConfigFormSnapshot;
  } | null>(null);
  if (cache.current === null) {
    let stored: ConfigFormSnapshot | undefined;
    cache.current = {
      read: () => {
        const next = form.getSnapshot();
        if (
          stored !== undefined &&
          stored.writable === next.writable &&
          stored.revision === next.revision &&
          (typeof next.revision === "number" || stored.value === next.value)
        ) {
          return stored;
        }
        stored = next;
        return next;
      },
    };
  }
  const read = cache.current.read;
  return useSyncExternalStore((listener) => form.subscribe(listener), read, read);
}

function useWorkspaceList(list: SettingsWorkspaceList | undefined): SettingsWorkspaceSnapshot {
  const stored = useRef<SettingsWorkspaceSnapshot>(EMPTY_WORKSPACE_SNAPSHOT);
  const read = useCallback((): SettingsWorkspaceSnapshot => {
    if (list === undefined) return EMPTY_WORKSPACE_SNAPSHOT;
    const next = list.getSnapshot();
    const previous = stored.current;
    if (sameWorkspaceSnapshot(previous, next)) return previous;
    stored.current = next;
    return next;
  }, [list]);
  const subscribe = useCallback(
    (listener: () => void) => list?.subscribe(listener) ?? (() => {}),
    [list],
  );
  return useSyncExternalStore(subscribe, read, read);
}

export function ConnectorSettingsEntry(props: {
  readonly form?: ConfigFormHandle;
  readonly localeTag?: string;
  readonly workspaces?: { readonly list: SettingsWorkspaceList };
}): ReactElement {
  const locale = normalizeLocale(props.localeTag);
  if (props.form === undefined) {
    const chrome = locale === "zh" ? zhLocale.settings : enLocale.settings;
    return (
      <p className={css.hint} role="status">
        {chrome.unavailable}
      </p>
    );
  }
  return <ConnectorSettingsForm form={props.form} locale={locale} workspaces={props.workspaces} />;
}

function ConnectorSettingsForm(props: {
  readonly form: ConfigFormHandle;
  readonly locale: "en" | "zh";
  readonly workspaces?: { readonly list: SettingsWorkspaceList };
}): ReactElement {
  const snapshot = useConfigForm(props.form);
  const workspaceSnapshot = useWorkspaceList(props.workspaces?.list);
  const savedWorkspaceId = workspaceIdFromConfigValue(snapshot.value);
  return (
    <ConnectorSettingsPanel
      platforms={platformsFromConfigValue(snapshot.value)}
      workspaceId={savedWorkspaceId}
      workspaces={workspaceChoices(workspaceSnapshot.items)}
      workspaceListStatus={workspaceListStatus(props.workspaces?.list, workspaceSnapshot)}
      locale={props.locale}
      disabled={snapshot.writable === false}
      onSave={async (platforms, workspace) => {
        const ops = platformSettingsOps(platformsFromConfigValue(snapshot.value), platforms);
        if (workspace !== undefined) {
          const workspaceOp = workspaceSettingsOp(savedWorkspaceId, workspace.id);
          if (workspaceOp !== undefined) ops.push(workspaceOp);
        }
        if (ops.length === 0) return;
        const accepted = await props.form.mutate(ops);
        if (!accepted) {
          const chrome = props.locale === "zh" ? zhLocale.settings : enLocale.settings;
          throw new Error(chrome.saveFailed);
        }
      }}
    />
  );
}

export function apply(ctx: ConnectorSettingsHost): void {
  ctx.effect(() => {
    const disposeLocale = ctx.locale.register(LOCALE_NAMESPACE, {
      en: { "settings.section": enLocale.settings.section },
      zh: { "settings.section": zhLocale.settings.section },
    });
    const translate = ctx.locale.bind(LOCALE_NAMESPACE);
    const disposeSection = ctx.slots.inject("settings.section", () => {
      const unregister = ctx.slots.register(
        {
          name: "settings.section",
          id: SETTINGS_SECTION_ID,
          order: SECTION_ORDER,
          label: () => translate("settings.section"),
          locale: LOCALE_NAMESPACE,
          inject: () => ({
            form: ctx.configForms.get(CONFIG_ENTRY_ID),
            localeTag: readLocaleTag(ctx.locale),
            workspaces: ctx.workspaces,
          }),
        },
        ConnectorSettingsEntry,
      );
      return () => {
        unregister();
      };
    });
    return () => {
      disposeSection();
      if (typeof disposeLocale === "function") disposeLocale();
    };
  });
}
