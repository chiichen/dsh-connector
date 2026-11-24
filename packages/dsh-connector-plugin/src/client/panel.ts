import { createElement, useState, type ReactElement, type ReactNode } from "react";
import enLocale from "../../locale/en.json";
import zhLocale from "../../locale/zh.json";
import { PLATFORM_BY_ID, PLATFORM_CATALOG, fieldIsVisible, textOf } from "../platforms/catalog";
import type { PlatformField, PlatformRecord, PlatformsConfig } from "../platforms/types";
import { preparePlatformSave } from "../platforms/validate";
import { createSettingsDraft, reduceSettingsDraft, type SettingsDraft } from "./draft";
import { settingsStyles } from "./settings.generated";

const fieldClass = "flex flex-col gap-1";
const checkClass = "flex flex-row items-center gap-2";
const controlClass =
  "rounded-md border border-solid bg-transparent px-2 py-[0.4rem] [font:inherit] text-inherit border-[var(--border,rgba(127,127,127,0.45))]";
const hintClass = "m-0 opacity-80";
const errorClass = "m-0 whitespace-pre-wrap text-[var(--danger,#b00020)]";

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
        className: checkClass,
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
        className: controlClass,
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
      className: controlClass,
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
      className: controlClass,
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
      className: controlClass,
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
    { className: fieldClass, htmlFor: inputId },
    createElement("span", null, label),
    control,
    createElement("span", { className: hintClass }, detail),
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
            className: draft.status.kind === "error" ? errorClass : hintClass,
          },
          draft.status.text,
        );

  return createElement(
    "div",
    {
      className:
        "dsh-connector-settings grid grid-cols-1 items-start gap-5 [font:inherit] text-inherit min-[721px]:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]",
      "data-connector-settings": draft.selectedId,
    },
    createElement("style", null, settingsStyles),
    createElement(
      "nav",
      { className: "flex flex-col gap-1", "aria-label": chrome.platformList },
      PLATFORM_CATALOG.map((platform) =>
        createElement(
          "button",
          {
            key: platform.id,
            type: "button",
            className:
              "cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2 text-left [font:inherit] text-inherit aria-selected:bg-[var(--accent,rgba(127,127,127,0.16))]",
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
        {
          className: "m-0 flex min-w-0 flex-col gap-3 border-0 p-0",
          disabled: props.disabled === true,
        },
        createElement("h2", null, textOf(definition.label, locale)),
        createElement("p", { className: hintClass }, textOf(definition.description, locale)),
        createElement(
          "label",
          { className: checkClass },
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
          : createElement("p", { className: hintClass }, chrome.enableHint),
        status,
        createElement("button", { type: "submit" }, chrome.save),
      ),
    ),
  );
}

export function normalizeLocale(tag: string | undefined): SettingsLocale {
  return tag?.toLowerCase().startsWith("zh") === true ? "zh" : "en";
}
