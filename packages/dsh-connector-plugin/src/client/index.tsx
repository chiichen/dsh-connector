import { useRef, useSyncExternalStore, type ReactElement } from "react";
import enLocale from "../../locale/en.json";
import zhLocale from "../../locale/zh.json";
import { CONNECTOR_PLUGIN_NAME } from "../constants";
import { isRecord } from "../platforms/records";
import type { PlatformsConfig } from "../platforms/types";
import { ConnectorSettingsPanel, normalizeLocale } from "./panel";
import css from "./panel.module.css";

/**
 * Settings page for the connector plugin.
 * The rail-and-form interaction follows dsh-im's per-platform settings page.
 * Field names come from each connector's constructor options, not from dsh-im.
 * Presentation uses a CSS Module, the same way a first-party settings
 * section imports its own `*.module.css`.
 */

export const name = CONNECTOR_PLUGIN_NAME;
export const inject = ["slots", "configForms", "locale"] as const;

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
}

export interface ConnectorSettingsHost {
  effect(callback: () => void | (() => void)): void;
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
        readonly inject: () => { readonly form: ConfigFormHandle; readonly localeTag: string };
      },
      component: (props: {
        readonly form?: ConfigFormHandle;
        readonly localeTag?: string;
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

export function ConnectorSettingsEntry(props: {
  readonly form?: ConfigFormHandle;
  readonly localeTag?: string;
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
  return <ConnectorSettingsForm form={props.form} locale={locale} />;
}

function ConnectorSettingsForm(props: {
  readonly form: ConfigFormHandle;
  readonly locale: "en" | "zh";
}): ReactElement {
  const snapshot = useConfigForm(props.form);
  return (
    <ConnectorSettingsPanel
      platforms={platformsFromConfigValue(snapshot.value)}
      locale={props.locale}
      disabled={snapshot.writable === false}
      onSave={async (platforms) => {
        await props.form.set("platforms", platforms);
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
