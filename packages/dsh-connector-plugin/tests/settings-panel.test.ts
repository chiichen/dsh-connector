import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorSettingsEntry,
  apply,
  platformsFromConfigValue,
  readLocaleTag,
  type ConfigFormHandle,
  type ConnectorSettingsHost,
} from "../src/client";
import { createSettingsDraft, reduceSettingsDraft } from "../src/client/draft";
import { ConnectorSettingsPanel } from "../src/client/panel";

function form(snapshot: ReturnType<ConfigFormHandle["getSnapshot"]>): ConfigFormHandle {
  return {
    getSnapshot: () => ({ ...snapshot }),
    subscribe: () => () => {},
    set: () => true,
  };
}

describe("connector settings panel", () => {
  it("hides credentials until a connector is enabled and switches WeChat fields with mode", () => {
    const disabled = renderToStaticMarkup(
      createElement(ConnectorSettingsPanel, {
        platforms: { feishu: { enabled: false, appSecret: "secret" } },
        onSave: () => {},
      }),
    );
    expect(disabled).toContain("Feishu");
    expect(disabled).toContain("Enable this connector");
    expect(disabled).not.toContain('name="appSecret"');

    const enabled = renderToStaticMarkup(
      createElement(ConnectorSettingsPanel, {
        platforms: {
          feishu: { enabled: true, appId: "cli_test", appSecret: "secret" },
        },
        onSave: () => {},
      }),
    );
    expect(enabled).toContain('type="password"');
    expect(enabled).toContain('name="appId"');
    expect(enabled).toContain("cli_test");

    const ilink = renderToStaticMarkup(
      createElement(ConnectorSettingsPanel, {
        platforms: { weixin: { enabled: true, mode: "ilink" } },
        onSave: () => {},
      }),
    );
    expect(ilink).toContain('name="botToken"');
    expect(ilink).not.toContain('name="appId"');

    const chinese = renderToStaticMarkup(
      createElement(ConnectorSettingsPanel, {
        locale: "zh",
        platforms: {},
        disabled: true,
        onSave: () => {},
      }),
    );
    expect(chinese).toContain("飞书");
    expect(chinese).toContain("启用");
    expect(chinese).toContain("disabled");
  });

  it("updates the draft for the selected platform", () => {
    const initial = createSettingsDraft({ feishu: { enabled: true, appId: "cli" } });
    const selected = reduceSettingsDraft(initial, { type: "select", id: "telegram" });
    const enabled = reduceSettingsDraft(selected, { type: "set-enabled", enabled: true });
    const edited = reduceSettingsDraft(enabled, {
      type: "set-field",
      key: "botToken",
      value: "123:abc",
    });
    const cleared = reduceSettingsDraft(edited, {
      type: "set-field",
      key: "botToken",
      value: undefined,
    });
    const failed = reduceSettingsDraft(cleared, {
      type: "status",
      status: { kind: "error", text: "missing" },
    });
    expect(edited.platforms.telegram).toEqual({ enabled: true, botToken: "123:abc" });
    expect(cleared.platforms.telegram).toEqual({ enabled: true });
    expect(failed.status).toEqual({ kind: "error", text: "missing" });
    expect(selected.status).toBeUndefined();
  });
});

describe("connector settings client", () => {
  it("reads plugin config snapshots and renders an unavailable state without a form", () => {
    expect(platformsFromConfigValue(undefined)).toBeUndefined();
    expect(platformsFromConfigValue("nope")).toBeUndefined();
    expect(platformsFromConfigValue({})).toBeUndefined();
    expect(platformsFromConfigValue({ platforms: [] })).toBeUndefined();
    expect(platformsFromConfigValue({ platforms: { qq: { enabled: true } } })).toEqual({
      qq: { enabled: true },
    });
    expect(readLocaleTag({})).toBe("en");
    expect(readLocaleTag({ getSnapshot: () => ({ active: "" }) })).toBe("en");
    expect(readLocaleTag({ getSnapshot: () => ({ active: "zh-CN" }) })).toBe("zh-CN");

    const unavailable = renderToStaticMarkup(createElement(ConnectorSettingsEntry, {}));
    expect(unavailable).toContain("configuration form");
    const unavailableZh = renderToStaticMarkup(
      createElement(ConnectorSettingsEntry, { localeTag: "zh-Hans" }),
    );
    expect(unavailableZh).toContain("配置表单");

    const html = renderToStaticMarkup(
      createElement(ConnectorSettingsEntry, {
        localeTag: "zh-CN",
        form: form({
          value: { platforms: { feishu: { enabled: true, appId: "cli_saved" } } },
          writable: false,
          revision: 3,
        }),
      }),
    );
    expect(html).toContain("飞书");
    expect(html).toContain("cli_saved");
    expect(html).toContain("disabled");
  });

  it("registers the settings section against the plugin config entry", () => {
    const unregister = vi.fn();
    const disposeLocale = vi.fn();
    const seen: Array<{ id: string; label: string; entryId: string; localeTag: string }> = [];
    let dispose: (() => void) | undefined;
    const ctx: ConnectorSettingsHost = {
      effect(callback) {
        dispose = callback() ?? undefined;
      },
      locale: {
        register: () => disposeLocale,
        bind: () => (key) => `label:${key}`,
        getSnapshot: () => ({ active: "en" }),
      },
      configForms: {
        get: (entryId) => ({ ...form({ value: {}, writable: true, revision: 1 }), entryId }),
      },
      slots: {
        inject: (_slot, setup) => setup(),
        register: (options, _component) => {
          const injected = options.inject();
          const entryId = (injected.form as ConfigFormHandle & { entryId?: string }).entryId;
          seen.push({
            id: options.id,
            label: options.label(),
            entryId: entryId ?? "",
            localeTag: injected.localeTag,
          });
          return unregister;
        },
      },
    };
    apply(ctx);
    expect(seen).toEqual([
      {
        id: "dsh-connector-plugin",
        label: "label:settings.section",
        entryId: "dsh-connector-plugin",
        localeTag: "en",
      },
    ]);
    dispose?.();
    expect(unregister).toHaveBeenCalledOnce();
    expect(disposeLocale).toHaveBeenCalledOnce();

    let disposeWithoutLocale: (() => void) | undefined;
    apply({
      ...ctx,
      effect(callback) {
        disposeWithoutLocale = callback() ?? undefined;
      },
      locale: {
        register: () => undefined,
        bind: () => () => "section",
        getSnapshot: () => undefined,
      },
    });
    disposeWithoutLocale?.();
    expect(unregister).toHaveBeenCalledTimes(2);
  });
});
