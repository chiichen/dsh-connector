// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ConnectorSettingsEntry, type ConfigFormHandle } from "../src/client";
import { ConnectorSettingsPanel } from "../src/client/panel";
import type { PlatformsConfig } from "../src/platforms/types";

async function render(node: ReturnType<typeof createElement>): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

async function unmount(view: { container: HTMLDivElement; root: Root }): Promise<void> {
  await act(async () => {
    view.root.unmount();
  });
  view.container.remove();
}

function setControlValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

describe("connector settings interaction", () => {
  it("enables Telegram, saves the credentials the connector reads, and blocks an incomplete Feishu form", async () => {
    const saved: PlatformsConfig[] = [];
    const view = await render(
      createElement(ConnectorSettingsPanel, {
        onSave: (platforms) => {
          saved.push(platforms);
        },
      }),
    );
    const telegram = view.container.querySelector('[data-platform="telegram"]');
    if (!(telegram instanceof HTMLButtonElement)) throw new Error("missing Telegram tab");
    await act(async () => {
      telegram.click();
    });
    const enabled = view.container.querySelector('[data-field="enabled"]');
    if (!(enabled instanceof HTMLInputElement)) throw new Error("missing enable toggle");
    await act(async () => {
      enabled.click();
    });

    const token = view.container.querySelector('input[name="botToken"]');
    const mode = view.container.querySelector('select[name="mode"]');
    const botId = view.container.querySelector('input[name="botId"]');
    const chats = view.container.querySelector('textarea[name="allowedChatIds"]');
    const marker = view.container.querySelector('input[name="includeContextMarker"]');
    if (
      !(token instanceof HTMLInputElement) ||
      !(mode instanceof HTMLSelectElement) ||
      !(botId instanceof HTMLInputElement) ||
      !(chats instanceof HTMLTextAreaElement) ||
      !(marker instanceof HTMLInputElement)
    ) {
      throw new Error("Telegram fields were not rendered");
    }
    await act(async () => {
      setControlValue(token, " 123456:telegram ");
      setControlValue(mode, "webhook");
      setControlValue(botId, "42");
      setControlValue(botId, "");
      setControlValue(chats, "10\n\n20");
      marker.click();
    });
    const form = view.container.querySelector("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("missing form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(saved).toEqual([
      {
        telegram: {
          enabled: true,
          botToken: "123456:telegram",
          mode: "webhook",
          allowedChatIds: ["10", "20"],
          includeContextMarker: true,
        },
      },
    ]);
    expect(view.container.textContent).toContain("Saved.");
    await unmount(view);

    const rejected: PlatformsConfig[] = [];
    const feishu = await render(
      createElement(ConnectorSettingsPanel, {
        onSave: (platforms) => {
          rejected.push(platforms);
        },
      }),
    );
    const feishuEnabled = feishu.container.querySelector('[data-field="enabled"]');
    if (!(feishuEnabled instanceof HTMLInputElement)) throw new Error("missing enable toggle");
    await act(async () => {
      feishuEnabled.click();
    });
    const feishuForm = feishu.container.querySelector("form");
    if (!(feishuForm instanceof HTMLFormElement)) throw new Error("missing form");
    await act(async () => {
      feishuForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(rejected).toEqual([]);
    expect(feishu.container.querySelector('[role="alert"]')?.textContent).toContain(
      "feishu requires appId",
    );
    await unmount(feishu);
  });

  it("shows a save failure, switches WeChat mode, and writes through the config form", async () => {
    const failing = await render(
      createElement(ConnectorSettingsPanel, {
        platforms: { telegram: { enabled: true, botToken: "1:token", mode: "passive" } },
        onSave: () => {
          throw new Error("host rejected the write");
        },
      }),
    );
    await act(async () => {
      failing.container
        .querySelector('[data-platform="telegram"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      failing.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(failing.container.querySelector('[role="alert"]')?.textContent).toContain(
      "host rejected the write",
    );
    await unmount(failing);

    const weixin = await render(
      createElement(ConnectorSettingsPanel, {
        platforms: { weixin: { enabled: true, mode: "official-account", appId: "wx", token: "t" } },
        onSave: () => {},
      }),
    );
    await act(async () => {
      weixin.container
        .querySelector('[data-platform="weixin"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(weixin.container.querySelector('input[name="appId"]')).not.toBeNull();
    const mode = weixin.container.querySelector('select[name="mode"]');
    if (!(mode instanceof HTMLSelectElement)) throw new Error("missing mode");
    await act(async () => {
      setControlValue(mode, "ilink");
    });
    expect(weixin.container.querySelector('input[name="appId"]')).toBeNull();
    expect(weixin.container.querySelector('input[name="botToken"]')).not.toBeNull();
    await unmount(weixin);

    const wecom = await render(
      createElement(ConnectorSettingsPanel, {
        platforms: { wecom: { enabled: true } },
        onSave: () => {},
      }),
    );
    await act(async () => {
      wecom.container
        .querySelector('[data-platform="wecom"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const connection = wecom.container.querySelector('select[name="mode"]');
    if (!(connection instanceof HTMLSelectElement)) throw new Error("missing WeCom connection");
    expect(connection.value).toBe("aibotWs");
    expect([...connection.options].map((option) => option.value)).toEqual([
      "app",
      "callback",
      "aibotWs",
    ]);
    expect(wecom.container.querySelector('input[name="aibotWs.botId"]')).not.toBeNull();
    expect(wecom.container.querySelector('input[name="aibotWs.secret"]')).not.toBeNull();
    expect(wecom.container.querySelector('input[name="app.corpId"]')).toBeNull();
    expect(wecom.container.querySelector('input[name="callback.token"]')).toBeNull();
    await act(async () => {
      setControlValue(connection, "app");
    });
    expect(wecom.container.querySelector('input[name="app.corpId"]')).not.toBeNull();
    expect(wecom.container.querySelector('input[name="aibotWs.botId"]')).toBeNull();
    await unmount(wecom);

    const writes: unknown[] = [];
    const snapshot = { value: { platforms: {} }, writable: true, revision: 1 };
    const configForm: ConfigFormHandle = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set: () => true,
      mutate: (ops) => {
        writes.push(ops);
        return true;
      },
    };
    const entry = await render(
      createElement(ConnectorSettingsEntry, { form: configForm, localeTag: "en" }),
    );
    const enabled = entry.container.querySelector('[data-field="enabled"]');
    if (!(enabled instanceof HTMLInputElement)) throw new Error("missing enable toggle");
    await act(async () => {
      enabled.click();
    });
    const appId = entry.container.querySelector('input[name="appId"]');
    const appSecret = entry.container.querySelector('input[name="appSecret"]');
    if (!(appId instanceof HTMLInputElement) || !(appSecret instanceof HTMLInputElement)) {
      throw new Error("Feishu credentials were not rendered");
    }
    await act(async () => {
      setControlValue(appId, "cli_from_ui");
      setControlValue(appSecret, "ui-secret");
    });
    await act(async () => {
      entry.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(writes).toEqual([
      [
        { op: "set", path: ["platforms", "feishu", "enabled"], value: true },
        { op: "set", path: ["platforms", "feishu", "appId"], value: "cli_from_ui" },
        { op: "set", path: ["platforms", "feishu", "appSecret"], value: "ui-secret" },
      ],
    ]);

    const locked = entry.container.querySelector("fieldset");
    expect(locked).not.toBeNull();
    await unmount(entry);

    const blocked = await render(
      createElement(ConnectorSettingsPanel, {
        disabled: true,
        platforms: { feishu: { enabled: true, appId: "cli", appSecret: "secret" } },
        onSave: () => {
          throw new Error("should not save");
        },
      }),
    );
    await act(async () => {
      blocked.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(blocked.container.querySelector('[role="alert"]')).toBeNull();
    await unmount(blocked);
  });

  it("shows a saved WeCom long connection again after the settings section reopens", async () => {
    const stored = {
      wecom: {
        enabled: true,
        mode: "aibotWs",
        aibotWs: { botId: "bot-saved" },
      },
    };
    const reopened = await render(
      createElement(ConnectorSettingsPanel, {
        platforms: stored,
        onSave: () => {},
      }),
    );
    const mode = reopened.container.querySelector('select[name="mode"]');
    const botId = reopened.container.querySelector('input[name="aibotWs.botId"]');
    const secret = reopened.container.querySelector('input[name="aibotWs.secret"]');
    const savedSecret = reopened.container.querySelector("[data-secret-saved]");
    if (
      !(mode instanceof HTMLSelectElement) ||
      !(botId instanceof HTMLInputElement) ||
      !(secret instanceof HTMLInputElement)
    ) {
      throw new Error("WeCom long-connection fields were not restored");
    }
    expect(mode.value).toBe("aibotWs");
    expect(botId.value).toBe("bot-saved");
    expect(secret.value).toBe("");
    expect(savedSecret?.textContent).toContain("Saved");
    await unmount(reopened);

    let snapshot: { value: { platforms: PlatformsConfig }; writable: boolean; revision: number } = {
      value: { platforms: {} },
      writable: true,
      revision: 1,
    };
    let renderEntry: (() => void) | undefined;
    const configForm: ConfigFormHandle = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        renderEntry = listener;
        return () => {
          renderEntry = undefined;
        };
      },
      set: () => true,
      mutate: () => true,
    };
    const entry = await render(
      createElement(ConnectorSettingsEntry, { localeTag: "en", form: configForm }),
    );
    expect(entry.container.querySelector('select[name="mode"]')).toBeNull();
    snapshot = { value: { platforms: stored }, writable: true, revision: 2 };
    await act(async () => {
      renderEntry?.();
    });
    const restoredMode = entry.container.querySelector('select[name="mode"]');
    const restoredBot = entry.container.querySelector('input[name="aibotWs.botId"]');
    const restoredSecret = entry.container.querySelector('input[name="aibotWs.secret"]');
    if (
      !(restoredMode instanceof HTMLSelectElement) ||
      !(restoredBot instanceof HTMLInputElement) ||
      !(restoredSecret instanceof HTMLInputElement)
    ) {
      throw new Error("the settings form did not read the saved WeCom section");
    }
    expect(restoredMode.value).toBe("aibotWs");
    expect(restoredBot.value).toBe("bot-saved");
    expect(restoredSecret.value).toBe("");
    expect(entry.container.querySelector("[data-secret-saved]")?.textContent).toContain("Saved");
    await unmount(entry);
  });
});
