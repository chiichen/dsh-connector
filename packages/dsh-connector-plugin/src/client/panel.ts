import { createElement, useState, type ReactElement, type ReactNode } from "react";
import enLocale from "../../locale/en.json";
import zhLocale from "../../locale/zh.json";
import { PLATFORM_BY_ID, PLATFORM_CATALOG, fieldIsVisible, textOf } from "../platforms/catalog";
import type { PlatformField, PlatformRecord, PlatformsConfig } from "../platforms/types";
import { preparePlatformSave } from "../platforms/validate";
import { createSettingsDraft, reduceSettingsDraft, type SettingsDraft } from "./draft";

const SETTINGS_CSS = `
.dsh-connector-settings {
  display: grid;
  grid-template-columns: minmax(10rem, 14rem) minmax(0, 1fr);
  gap: 1.25rem;
  align-items: start;
  color: inherit;
  font: inherit;
}
.dsh-connector-settings__nav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.dsh-connector-settings__tab {
  text-align: left;
  border: 0;
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dsh-connector-settings__tab[aria-selected="true"] {
  background: var(--accent, rgba(127, 127, 127, 0.16));
}
.dsh-connector-settings__panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
  border: 0;
  margin: 0;
  padding: 0;
}
.dsh-connector-settings__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.dsh-connector-settings__check {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}
.dsh-connector-settings__field input,
.dsh-connector-settings__field select,
.dsh-connector-settings__field textarea {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.45));
  border-radius: 0.375rem;
  padding: 0.4rem 0.5rem;
}
.dsh-connector-settings__hint,
.dsh-connector-settings__detail {
  margin: 0;
  opacity: 0.8;
}
.dsh-connector-settings__error {
  color: var(--danger, #b00020);
  white-space: pre-wrap;
}
@media (max-width: 720px) {
  .dsh-connector-settings {
    grid-template-columns: 1fr;
  }
}
`;

type SettingsLocale = "en" | "zh";

interface ChromeCopy {
  readonly section: string;
  readonly enable: string;
  readonly save: string;
  readonly saved: string;
  readonly unavailable: string;
  readonly defaultOption: string;
  readonly platformList: string;
  readonly enableHint: string;
}

const CHROME: Record<SettingsLocale, ChromeCopy> = {
  en: enLocale.settings,
  zh: zhLocale.settings,
};

export interface ConnectorSettingsPanelProps {
  readonly platforms?: PlatformsConfig;
  readonly locale?: SettingsLocale;
  readonly disabled?: boolean;
  readonly onSave: (platforms: PlatformsConfig) => void | Promise<void>;
}

function stringValue(record: PlatformRecord | undefined, key: string): string {
  const value = readOwn(record, key);
  return typeof value === "string" ? value : "";
}

function readOwn(record: PlatformRecord | undefined, key: string): unknown {
  if (record === undefined) return undefined;
  const parts = key.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as PlatformRecord)[part];
  }
  return current;
}

function listValue(record: PlatformRecord | undefined, key: string): string {
  const value = readOwn(record, key);
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string").join("\n");
}

function FieldControl(props: {
  readonly field: PlatformField;
  readonly record: PlatformRecord | undefined;
  readonly locale: SettingsLocale;
  readonly onChange: (
    key: string,
    value: string | boolean | number | readonly string[] | undefined,
  ) => void;
}): ReactElement {
  const { field, record, locale, onChange } = props;
  const inputId = `dsh-connector-${field.key.replaceAll(".", "-")}`;
  const label = textOf(field.label, locale);
  const detail = textOf(field.description, locale);

  if (field.kind === "boolean") {
    const checked = readOwn(record, field.key) === true;
    return createElement(
      "label",
      {
        className: "dsh-connector-settings__field dsh-connector-settings__check",
        htmlFor: inputId,
      },
      createElement("input", {
        id: inputId,
        name: field.key,
        type: "checkbox",
        checked,
        onChange: (event: { currentTarget: { checked: boolean } }) => {
          onChange(field.key, event.currentTarget.checked);
        },
      }),
      createElement("span", null, label),
    );
  }

  let control: ReactNode;
  if (field.kind === "enum") {
    control = createElement(
      "select",
      {
        id: inputId,
        name: field.key,
        value: stringValue(record, field.key),
        onChange: (event: { currentTarget: { value: string } }) => {
          const next = event.currentTarget.value;
          onChange(field.key, next === "" ? undefined : next);
        },
      },
      createElement("option", { value: "" }, CHROME[locale].defaultOption),
      ...(field.choices ?? []).map((choice) =>
        createElement("option", { key: choice, value: choice }, choice),
      ),
    );
  } else if (field.kind === "string-list") {
    control = createElement("textarea", {
      id: inputId,
      name: field.key,
      rows: 3,
      value: listValue(record, field.key),
      spellCheck: false,
      onChange: (event: { currentTarget: { value: string } }) => {
        onChange(field.key, event.currentTarget.value.split("\n"));
      },
    });
  } else if (field.kind === "number") {
    const current = readOwn(record, field.key);
    control = createElement("input", {
      id: inputId,
      name: field.key,
      type: "number",
      step: "1",
      value: typeof current === "number" ? String(current) : "",
      onChange: (event: { currentTarget: { value: string } }) => {
        const raw = event.currentTarget.value;
        if (raw.trim() === "") {
          onChange(field.key, undefined);
          return;
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) onChange(field.key, parsed);
      },
    });
  } else {
    control = createElement("input", {
      id: inputId,
      name: field.key,
      type: field.kind === "secret" ? "password" : "text",
      value: stringValue(record, field.key),
      autoComplete: "off",
      spellCheck: false,
      onChange: (event: { currentTarget: { value: string } }) => {
        onChange(field.key, event.currentTarget.value);
      },
    });
  }

  return createElement(
    "label",
    { className: "dsh-connector-settings__field", htmlFor: inputId },
    createElement("span", null, label),
    control,
    createElement("span", { className: "dsh-connector-settings__detail" }, detail),
  );
}

export function ConnectorSettingsPanel(props: ConnectorSettingsPanelProps): ReactElement {
  const locale = props.locale ?? "en";
  const chrome = CHROME[locale];
  const [draft, setDraft] = useState<SettingsDraft>(() => createSettingsDraft(props.platforms));
  const definition = PLATFORM_BY_ID[draft.selectedId];
  const record = draft.platforms[draft.selectedId];
  const enabled = record?.enabled === true;

  function update(next: SettingsDraft): void {
    setDraft(next);
  }

  async function onSubmit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    if (props.disabled === true) return;
    const prepared = preparePlatformSave(draft.platforms);
    if (!prepared.ok) {
      update(
        reduceSettingsDraft(draft, {
          type: "status",
          status: { kind: "error", text: prepared.message },
        }),
      );
      return;
    }
    try {
      await props.onSave(prepared.platforms);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      update(reduceSettingsDraft(draft, { type: "status", status: { kind: "error", text } }));
      return;
    }
    update({
      selectedId: draft.selectedId,
      platforms: prepared.platforms,
      status: { kind: "saved", text: chrome.saved },
    });
  }

  const status =
    draft.status === undefined
      ? null
      : createElement(
          "p",
          {
            role: draft.status.kind === "error" ? "alert" : "status",
            className:
              draft.status.kind === "error"
                ? "dsh-connector-settings__error"
                : "dsh-connector-settings__hint",
          },
          draft.status.text,
        );

  return createElement(
    "div",
    { className: "dsh-connector-settings", "data-connector-settings": draft.selectedId },
    createElement("style", null, SETTINGS_CSS),
    createElement(
      "nav",
      { className: "dsh-connector-settings__nav", "aria-label": chrome.platformList },
      PLATFORM_CATALOG.map((platform) =>
        createElement(
          "button",
          {
            key: platform.id,
            type: "button",
            className: "dsh-connector-settings__tab",
            "data-platform": platform.id,
            role: "tab",
            "aria-selected": platform.id === draft.selectedId,
            onClick: () => {
              update(reduceSettingsDraft(draft, { type: "select", id: platform.id }));
            },
          },
          textOf(platform.label, locale),
        ),
      ),
    ),
    createElement(
      "form",
      { onSubmit: (event: { preventDefault(): void }) => void onSubmit(event) },
      createElement(
        "fieldset",
        { className: "dsh-connector-settings__panel", disabled: props.disabled === true },
        createElement("h2", null, textOf(definition.label, locale)),
        createElement(
          "p",
          { className: "dsh-connector-settings__hint" },
          textOf(definition.description, locale),
        ),
        createElement(
          "label",
          { className: "dsh-connector-settings__field dsh-connector-settings__check" },
          createElement("input", {
            name: "enabled",
            "data-field": "enabled",
            type: "checkbox",
            checked: enabled,
            onChange: (event: { currentTarget: { checked: boolean } }) => {
              update(
                reduceSettingsDraft(draft, {
                  type: "set-enabled",
                  enabled: event.currentTarget.checked,
                }),
              );
            },
          }),
          createElement("span", null, chrome.enable),
        ),
        enabled
          ? definition.fields
              .filter((field) => fieldIsVisible(definition.id, field, record))
              .map((field) =>
                createElement(FieldControl, {
                  key: field.key,
                  field,
                  record,
                  locale,
                  onChange: (key, value) => {
                    update(reduceSettingsDraft(draft, { type: "set-field", key, value }));
                  },
                }),
              )
          : createElement("p", { className: "dsh-connector-settings__hint" }, chrome.enableHint),
        status,
        createElement("button", { type: "submit" }, chrome.save),
      ),
    ),
  );
}

export function normalizeLocale(tag: string | undefined): SettingsLocale {
  return tag?.toLowerCase().startsWith("zh") === true ? "zh" : "en";
}
