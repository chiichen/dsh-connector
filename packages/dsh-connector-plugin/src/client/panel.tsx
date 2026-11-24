import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import enLocale from "../../locale/en.json";
import zhLocale from "../../locale/zh.json";
import {
  PLATFORM_BY_ID,
  PLATFORM_CATALOG,
  fieldIsVisible,
  platformsWithDisplayedDefaults,
  textOf,
} from "../platforms/catalog";
import type { PlatformField, PlatformRecord, PlatformsConfig } from "../platforms/types";
import { preparePlatformSave } from "../platforms/validate";
import { createSettingsDraft, reduceSettingsDraft, type SettingsDraft } from "./draft";
import { samePlatforms, secretWasRedacted } from "./persist";
import css from "./panel.module.css";

type SettingsLocale = "en" | "zh";

interface ChromeCopy {
  readonly section: string;
  readonly enable: string;
  readonly save: string;
  readonly saved: string;
  readonly saveFailed: string;
  readonly secretSaved: string;
  readonly unavailable: string;
  readonly defaultOption: string;
  readonly platformList: string;
  readonly enableHint: string;
  readonly required: string;
  readonly optional: string;
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

function enumValue(record: PlatformRecord | undefined, field: PlatformField): string {
  const stored = stringValue(record, field.key);
  if (stored.length > 0) return stored;
  return field.defaultChoice ?? "";
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

function requirementText(field: PlatformField, locale: SettingsLocale): string | undefined {
  if (field.requirement === undefined) return undefined;
  return CHROME[locale][field.requirement];
}

function choiceText(field: PlatformField, choice: string, locale: SettingsLocale): string {
  const labels = field.choiceLabels?.[choice];
  return labels === undefined ? choice : textOf(labels, locale);
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
  const requirement = requirementText(field, locale);
  const secretStored = field.kind === "secret" && secretWasRedacted(record, field.key);

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
        {requirement === undefined ? null : <span className={css.requirement}>{requirement}</span>}
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
        value={enumValue(record, field)}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          const next = event.currentTarget.value;
          onChange(field.key, field.defaultChoice === undefined && next === "" ? undefined : next);
        }}
      >
        {field.defaultChoice === undefined ? (
          <option value="">{CHROME[locale].defaultOption}</option>
        ) : null}
        {(field.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>
            {choiceText(field, choice, locale)}
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
        placeholder={secretStored ? CHROME[locale].secretSaved : undefined}
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
      <span className={css.fieldLabel}>
        <span>{label}</span>
        {requirement === undefined ? null : <span className={css.requirement}>{requirement}</span>}
        {secretStored ? (
          <span className={css.requirement} data-secret-saved="true">
            {CHROME[locale].secretSaved}
          </span>
        ) : null}
      </span>
      {control}
      <span className={css.hint}>{detail}</span>
    </label>
  );
}

export function ConnectorSettingsPanel(props: ConnectorSettingsPanelProps): ReactElement {
  const locale = props.locale ?? "en";
  const chrome = CHROME[locale];
  const [draft, setDraft] = useState<SettingsDraft>(() => createSettingsDraft(props.platforms));
  const draftRef = useRef(draft);
  const hydratedPlatforms = useRef(props.platforms);
  draftRef.current = draft;
  useEffect(() => {
    const current = draftRef.current;
    const baseline = createSettingsDraft(hydratedPlatforms.current);
    const untouched = samePlatforms(current.platforms, baseline.platforms);
    const sourceEmpty = Object.keys(baseline.platforms).length === 0;
    const incoming = props.platforms;
    hydratedPlatforms.current = incoming;
    if (!untouched && !sourceEmpty) return;
    const next = createSettingsDraft(incoming);
    const selectedId =
      current.selectedId !== baseline.selectedId ? current.selectedId : next.selectedId;
    if (
      selectedId === current.selectedId &&
      samePlatforms(current.platforms, next.platforms) &&
      current.status === undefined
    ) {
      return;
    }
    setDraft({ selectedId, platforms: next.platforms });
  }, [props.platforms]);
  const definition = PLATFORM_BY_ID[draft.selectedId];
  const record = draft.platforms[draft.selectedId];
  const enabled = record?.enabled === true;

  function update(next: SettingsDraft): void {
    setDraft(next);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (props.disabled === true) return;
    const prepared = preparePlatformSave(platformsWithDisplayedDefaults(draft.platforms));
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
