import {
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import enLocale from "../../locale/en.json";
import zhLocale from "../../locale/zh.json";
import { PLATFORM_BY_ID, PLATFORM_CATALOG, fieldIsVisible, textOf } from "../platforms/catalog";
import type { PlatformField, PlatformRecord, PlatformsConfig } from "../platforms/types";
import { preparePlatformSave } from "../platforms/validate";
import { createSettingsDraft, reduceSettingsDraft, type SettingsDraft } from "./draft";
import css from "./panel.module.css";

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
    return (
      <label className={css.check} htmlFor={inputId}>
        <input
          id={inputId}
          name={field.key}
          type="checkbox"
          checked={checked}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            onChange(field.key, event.currentTarget.checked);
          }}
        />
        <span>{label}</span>
      </label>
    );
  }

  let control: ReactNode;
  if (field.kind === "enum") {
    control = (
      <select
        id={inputId}
        name={field.key}
        className={css.control}
        value={stringValue(record, field.key)}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          const next = event.currentTarget.value;
          onChange(field.key, next === "" ? undefined : next);
        }}
      >
        <option value="">{CHROME[locale].defaultOption}</option>
        {(field.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  } else if (field.kind === "string-list") {
    control = (
      <textarea
        id={inputId}
        name={field.key}
        className={css.control}
        rows={3}
        value={listValue(record, field.key)}
        spellCheck={false}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          onChange(field.key, event.currentTarget.value.split("\n"));
        }}
      />
    );
  } else if (field.kind === "number") {
    const current = readOwn(record, field.key);
    control = (
      <input
        id={inputId}
        name={field.key}
        className={css.control}
        type="number"
        step="1"
        value={typeof current === "number" ? String(current) : ""}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const raw = event.currentTarget.value;
          if (raw.trim() === "") {
            onChange(field.key, undefined);
            return;
          }
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(field.key, parsed);
        }}
      />
    );
  } else {
    control = (
      <input
        id={inputId}
        name={field.key}
        className={css.control}
        type={field.kind === "secret" ? "password" : "text"}
        value={stringValue(record, field.key)}
        autoComplete="off"
        spellCheck={false}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          onChange(field.key, event.currentTarget.value);
        }}
      />
    );
  }

  return (
    <label className={css.field} htmlFor={inputId}>
      <span>{label}</span>
      {control}
      <span className={css.hint}>{detail}</span>
    </label>
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

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
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

  return (
    <div className={css.layout} data-connector-settings={draft.selectedId}>
      <nav className={css.nav} aria-label={chrome.platformList}>
        {PLATFORM_CATALOG.map((platform) => (
          <button
            key={platform.id}
            type="button"
            className={css.tab}
            data-platform={platform.id}
            role="tab"
            aria-selected={platform.id === draft.selectedId}
            onClick={() => {
              update(reduceSettingsDraft(draft, { type: "select", id: platform.id }));
            }}
          >
            {textOf(platform.label, locale)}
          </button>
        ))}
      </nav>
      <form
        className={css.form}
        onSubmit={(event) => {
          void onSubmit(event);
        }}
      >
        <fieldset className={css.fields} disabled={props.disabled === true}>
          <h2 className={css.title}>{textOf(definition.label, locale)}</h2>
          <p className={css.hint}>{textOf(definition.description, locale)}</p>
          <label className={css.check}>
            <input
              name="enabled"
              data-field="enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                update(
                  reduceSettingsDraft(draft, {
                    type: "set-enabled",
                    enabled: event.currentTarget.checked,
                  }),
                );
              }}
            />
            <span>{chrome.enable}</span>
          </label>
          {enabled ? (
            definition.fields
              .filter((field) => fieldIsVisible(definition.id, field, record))
              .map((field) => (
                <FieldControl
                  key={field.key}
                  field={field}
                  record={record}
                  locale={locale}
                  onChange={(key, value) => {
                    update(reduceSettingsDraft(draft, { type: "set-field", key, value }));
                  }}
                />
              ))
          ) : (
            <p className={css.hint}>{chrome.enableHint}</p>
          )}
          {draft.status === undefined ? null : (
            <p
              role={draft.status.kind === "error" ? "alert" : "status"}
              className={draft.status.kind === "error" ? css.error : css.hint}
            >
              {draft.status.text}
            </p>
          )}
          <button className={css.save} type="submit">
            {chrome.save}
          </button>
        </fieldset>
      </form>
    </div>
  );
}

export function normalizeLocale(tag: string | undefined): SettingsLocale {
  return tag?.toLowerCase().startsWith("zh") === true ? "zh" : "en";
}
