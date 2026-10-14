/**
 * SettingsForm – renders a declarative settings schema (src/types/settings.ts).
 *
 * Shared by the kiosk settings dialog and the web UI, so it must stay free of
 * Tauri and widget imports. Changes are reported as patches; text-like inputs
 * commit on blur / Enter or after a short pause, never per keystroke (each
 * commit is a backend write and may trigger a widget refetch). Addresses
 * commit on blur / Enter only (see `isEndpointField`). Choices commit per
 * click; `optionsProvider` fields load theirs via optionProviders.ts.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { REDACTED_SECRET, type SettingsContext, type SettingsField, type ValueField } from '../../types/settings';
import {
  filterChoices,
  groupChoices,
  mergeChoices,
  moveSelection,
  normalizeSelection,
  removeSelection,
  selectionChips,
  toggleSelection,
} from './multiselect';
import { useProviderOptions, type ProviderOptionsState } from './optionProviders';
import './settings.css';

export interface SettingsFormProps {
  schema: SettingsField[];
  /** Current values, already merged with the defaults. */
  values: Record<string, unknown>;
  /** Called with the changed keys only. */
  onChange: (patch: Record<string, unknown>) => void;
  context: SettingsContext;
}

type SectionField = Extract<SettingsField, { type: 'section' }>;
/** The schema member that declares type `T` (members may share several types, e.g. text/url/secret). */
type FieldOf<T extends ValueField['type']> = ValueField extends infer F
  ? F extends { type: infer U }
    ? T extends U
      ? F
      : never
    : never
  : never;

interface Group {
  section: SectionField | null;
  fields: ValueField[];
}

const TEXT_COMMIT_DELAY_MS = 600;
const SLIDER_COMMIT_DELAY_MS = 250;
/** Multiselects with more choices than this get a search field. */
const MULTI_SEARCH_MIN_CHOICES = 6;

/**
 * Addresses wait for blur / Enter instead of a typing pause: a half-typed
 * address would be fetched by the widget, and over HTTP the backend clears
 * the sibling secret whenever a key ending in «url» or «host» changes – a
 * pause in typing must not cost the stored password or token.
 */
const isEndpointField = (field: ValueField): boolean => field.type === 'url' || /(url|host)$/i.test(field.key);
const SECRET_SET_PLACEHOLDER = 'gesetzt – zum Ändern neu eingeben';

/** Mo–So as shown, mapped to Date.getDay() numbers (0 = Sonntag). */
const WEEK_DAYS: readonly { day: number; label: string; title: string }[] = [
  { day: 1, label: 'Mo', title: 'Montag' },
  { day: 2, label: 'Di', title: 'Dienstag' },
  { day: 3, label: 'Mi', title: 'Mittwoch' },
  { day: 4, label: 'Do', title: 'Donnerstag' },
  { day: 5, label: 'Fr', title: 'Freitag' },
  { day: 6, label: 'Sa', title: 'Samstag' },
  { day: 0, label: 'So', title: 'Sonntag' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function groupFields(schema: readonly SettingsField[]): Group[] {
  const groups: Group[] = [];
  let current: Group = { section: null, fields: [] };
  for (const field of schema) {
    if (field.type === 'section') {
      if (current.section || current.fields.length > 0) groups.push(current);
      current = { section: field, fields: [] };
    } else {
      current.fields.push(field);
    }
  }
  if (current.section || current.fields.length > 0) groups.push(current);
  return groups;
}

function isVisible(field: SettingsField, values: Record<string, unknown>, context: SettingsContext): boolean {
  if (field.type !== 'section' && field.kioskOnly && context === 'remote') return false;
  if (!field.showIf) return true;
  try {
    return field.showIf(values);
  } catch {
    // A broken rule must not hide the whole form.
    return true;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const clamp = (value: number, min?: number, max?: number): number =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));

/** Snaps to the step grid (relative to min) and drops float noise. */
function snap(value: number, step: number | undefined, min: number | undefined): number {
  if (!step || step <= 0) return value;
  const base = min ?? 0;
  const snapped = base + Math.round((value - base) / step) * step;
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number(snapped.toFixed(decimals));
}

function normalizeTime(text: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

/** `<input type="color">` only accepts #rrggbb. */
function toColorInputValue(value: unknown): string {
  if (typeof value !== 'string') return '#000000';
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
  return long ? `#${long[1].toLowerCase()}` : '#000000';
}

function isValidUrl(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Local draft for an input: shown while editing, committed after `delay` ms
 * without typing (null = never), on `flush()` (blur / Enter) and on unmount.
 */
function useDraft(value: string, onCommit: (text: string) => void, delay: number | null) {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(onCommit);
  const valueRef = useRef(value);

  useLayoutEffect(() => {
    commitRef.current = onCommit;
    valueRef.current = value;
  });

  const flushRef = useRef(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next !== null && next !== valueRef.current) commitRef.current(next);
  });

  useEffect(() => {
    const flushPending = flushRef.current;
    return () => flushPending();
  }, []);

  return {
    text: draft ?? value,
    editing: draft !== null,
    change(next: string) {
      setDraft(next);
      pending.current = next;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = delay === null ? null : setTimeout(flushRef.current, delay);
    },
    flush() {
      flushRef.current();
    },
    /** Commit and show the stored value again. */
    finish() {
      flushRef.current();
      setDraft(null);
    },
  };
}

const commitOnEnter = (event: KeyboardEvent<HTMLInputElement>, flush: () => void): void => {
  if (event.key === 'Enter') {
    event.preventDefault();
    flush();
  }
};

// ── Field shell ──────────────────────────────────────────────────────────────

interface FieldShellProps {
  id: string;
  field: ValueField;
  badge?: ReactNode;
  children: ReactNode;
  /** Group label (radio, days, lists) instead of <label for>. */
  asGroup?: boolean;
}

function FieldShell({ id, field, badge, children, asGroup }: FieldShellProps) {
  return (
    <div className="settings-field" role={asGroup ? 'group' : undefined} aria-labelledby={asGroup ? `${id}-label` : undefined}>
      {asGroup ? (
        <div className="settings-label" id={`${id}-label`}>
          {field.label}
          {badge}
        </div>
      ) : (
        <label className="settings-label" htmlFor={id} id={`${id}-label`}>
          {field.label}
          {badge}
        </label>
      )}
      {field.description && <div className="settings-description">{field.description}</div>}
      {children}
    </div>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────────

interface ControlProps<F extends ValueField> {
  id: string;
  field: F;
  value: unknown;
  set: (value: unknown) => void;
  context: SettingsContext;
}

function TextControl({ id, field, value, set }: ControlProps<FieldOf<'text' | 'url' | 'textarea'>>) {
  const commit = (text: string) => set(field.type === 'url' ? text.trim() : text);
  const draft = useDraft(asText(value), commit, isEndpointField(field) ? null : TEXT_COMMIT_DELAY_MS);
  const invalidUrl = field.type === 'url' && draft.text.trim() !== '' && !isValidUrl(draft.text.trim());

  if (field.type === 'textarea') {
    return (
      <FieldShell id={id} field={field}>
        <textarea
          id={id}
          className="settings-input settings-textarea"
          value={draft.text}
          placeholder={field.placeholder}
          rows={4}
          onChange={(e) => draft.change(e.target.value)}
          onBlur={draft.finish}
        />
      </FieldShell>
    );
  }

  return (
    <FieldShell id={id} field={field}>
      <input
        id={id}
        className={`settings-input${invalidUrl ? ' settings-input-invalid' : ''}`}
        type={field.type === 'url' ? 'url' : 'text'}
        inputMode={field.type === 'url' ? 'url' : undefined}
        autoCapitalize={field.type === 'url' ? 'off' : undefined}
        spellCheck={field.type === 'url' ? false : undefined}
        value={draft.text}
        placeholder={field.placeholder}
        onChange={(e) => draft.change(e.target.value)}
        onKeyDown={(e) => commitOnEnter(e, draft.flush)}
        onBlur={draft.finish}
      />
      {invalidUrl && <div className="settings-field-error">Ungültige Adresse – vollständige URL inkl. https:// eingeben</div>}
    </FieldShell>
  );
}

function SecretControl({ id, field, value, set }: ControlProps<FieldOf<'secret'>>) {
  const [reveal, setReveal] = useState(false);
  const isSet = value === REDACTED_SECRET || (typeof value === 'string' && value !== '');
  // The stored secret is never shown (visitor-facing kiosk, redacted web UI):
  // the input starts empty and only a newly typed value is sent – on Enter, blur
  // or close only: a half-typed key saved during a typing pause would be used
  // right away (failed logins, a wrong key stored).
  const draft = useDraft('', (text) => set(text), null);

  return (
    <FieldShell
      id={id}
      field={field}
      badge={isSet ? <span className="settings-secret-badge">gesetzt</span> : null}
    >
      <div className="settings-input-row">
        <input
          id={id}
          className="settings-input"
          type={reveal ? 'text' : 'password'}
          autoComplete="new-password"
          autoCapitalize="off"
          spellCheck={false}
          value={draft.text}
          placeholder={isSet ? SECRET_SET_PLACEHOLDER : field.placeholder}
          onChange={(e) => draft.change(e.target.value)}
          onKeyDown={(e) => commitOnEnter(e, draft.flush)}
          onBlur={draft.finish}
        />
        <button
          type="button"
          className="settings-icon-btn"
          onClick={() => setReveal((r) => !r)}
          title={reveal ? 'Eingabe verbergen' : 'Eingabe anzeigen'}
          aria-label={reveal ? 'Eingabe verbergen' : 'Eingabe anzeigen'}
        >
          {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        {isSet && (
          <button
            type="button"
            className="settings-icon-btn danger"
            onClick={() => set('')}
            title="Gespeicherten Wert entfernen"
            aria-label="Gespeicherten Wert entfernen"
          >
            <X size={16} />
          </button>
        )}
      </div>
    </FieldShell>
  );
}

function parseNumber(text: string): number | null {
  if (text.trim() === '') return null;
  const parsed = Number(text.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function NumberControl({ id, field, value, set }: ControlProps<FieldOf<'number'>>) {
  const current = asFiniteNumber(value);
  const commit = (text: string) => {
    const parsed = parseNumber(text);
    if (parsed === null) return;
    const next = snap(clamp(parsed, field.min, field.max), field.step, field.min);
    if (next !== current) set(next);
  };
  const draft = useDraft(current === null ? '' : String(current), commit, TEXT_COMMIT_DELAY_MS);
  // Invalid input is never committed; on blur the stored value comes back.
  const invalid = draft.editing && parseNumber(draft.text) === null;
  const hint =
    field.min !== undefined && field.max !== undefined
      ? `Erlaubt: ${field.min}–${field.max}`
      : field.min !== undefined
        ? `Mindestens ${field.min}`
        : field.max !== undefined
          ? `Höchstens ${field.max}`
          : 'Bitte eine Zahl eingeben';

  return (
    <FieldShell id={id} field={field}>
      <div className="settings-input-row">
        <input
          id={id}
          className={`settings-input${invalid ? ' settings-input-invalid' : ''}`}
          type="number"
          inputMode="decimal"
          min={field.min}
          max={field.max}
          step={field.step ?? 'any'}
          value={draft.text}
          onChange={(e) => draft.change(e.target.value)}
          onKeyDown={(e) => commitOnEnter(e, draft.flush)}
          onBlur={draft.finish}
        />
        {field.unit && <span className="settings-unit">{field.unit}</span>}
      </div>
      {invalid && <div className="settings-field-error">{hint}</div>}
    </FieldShell>
  );
}

function BooleanControl({ id, field, value, set }: ControlProps<FieldOf<'boolean'>>) {
  return (
    <div className="settings-field">
      <label className="settings-toggle" htmlFor={id}>
        <span className="settings-toggle-text">
          <span className="settings-toggle-label">{field.label}</span>
          {field.description && <span className="settings-toggle-sublabel">{field.description}</span>}
        </span>
        <span className="toggle-switch">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} />
          <span className="toggle-switch-slider" />
        </span>
      </label>
    </div>
  );
}

/** Loading hint and load error (with «Neu laden») of a field with an options provider. */
function ProviderStatus({ provider }: { provider: ProviderOptionsState }) {
  if (provider.error) {
    return (
      <div className="settings-provider-status error" role="alert">
        <span>{provider.error}</span>
        <button type="button" className="settings-btn" onClick={provider.reload} disabled={provider.loading}>
          <RefreshCw size={14} aria-hidden="true" />
          Neu laden
        </button>
      </div>
    );
  }
  if (provider.loading && !provider.loaded) {
    return <div className="settings-provider-status">Auswahl wird geladen …</div>;
  }
  return null;
}

interface SelectEntry {
  value: string | number;
  label: string;
  group?: string;
}

function SelectControl({ id, field, value, set }: ControlProps<FieldOf<'select'>>) {
  const provider = useProviderOptions(field.optionsProvider);
  const entries = useMemo<SelectEntry[]>(() => {
    const fixed = new Set(field.options.map((option) => String(option.value)));
    return [...field.options, ...provider.options.filter((option) => !fixed.has(option.value))];
  }, [field.options, provider.options]);
  const selected = entries.find((entry) => entry.value === value);
  // A stored provider id that is not (yet) among the options stays selected and visible.
  const stray = !selected && field.optionsProvider && typeof value === 'string' && value !== '' ? value : null;
  const strayLabel = provider.loaded ? `Unbekannt (${stray})` : provider.loading ? 'Lädt …' : stray;

  return (
    <FieldShell id={id} field={field}>
      <select
        id={id}
        className="settings-select"
        value={selected ? String(selected.value) : (stray ?? '')}
        onChange={(e) => {
          const entry = entries.find((o) => String(o.value) === e.target.value);
          if (entry) set(entry.value);
        }}
      >
        {!selected && stray === null && (
          <option value="" disabled>
            {provider.loading && !provider.loaded ? 'Lädt …' : 'Bitte wählen…'}
          </option>
        )}
        {stray !== null && (
          <option value={stray} disabled>
            {strayLabel}
          </option>
        )}
        {groupChoices(entries).map(({ group, items }) => {
          const options = items.map((entry) => (
            <option key={String(entry.value)} value={String(entry.value)}>
              {entry.label}
            </option>
          ));
          return group === null ? (
            options
          ) : (
            <optgroup key={`group:${group}`} label={group}>
              {options}
            </optgroup>
          );
        })}
      </select>
      {field.optionsProvider && <ProviderStatus provider={provider} />}
    </FieldShell>
  );
}

function RadioControl({ id, field, value, set }: ControlProps<FieldOf<'radio'>>) {
  return (
    <FieldShell id={id} field={field} asGroup>
      <div className="settings-radio-group" role="radiogroup" aria-labelledby={`${id}-label`}>
        {field.options.map((option) => {
          const active = option.value === value;
          return (
            <label key={String(option.value)} className={`settings-radio-option${active ? ' active' : ''}`}>
              <input type="radio" name={id} checked={active} onChange={() => set(option.value)} />
              {option.label}
            </label>
          );
        })}
      </div>
    </FieldShell>
  );
}

function RangeControl({ id, field, value, set }: ControlProps<FieldOf<'range'>>) {
  const current = clamp(asFiniteNumber(value) ?? field.min, field.min, field.max);
  const draft = useDraft(String(current), (text) => set(Number(text)), SLIDER_COMMIT_DELAY_MS);
  return (
    <FieldShell id={id} field={field}>
      <div className="settings-range-row">
        <input
          id={id}
          className="settings-range"
          type="range"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={draft.text}
          onChange={(e) => draft.change(e.target.value)}
          onPointerUp={draft.finish}
          onKeyUp={draft.flush}
          onBlur={draft.finish}
        />
        <span className="settings-range-value">
          {draft.text}
          {field.unit ? ` ${field.unit}` : ''}
        </span>
      </div>
    </FieldShell>
  );
}

function ColorControl({ id, field, value, set }: ControlProps<FieldOf<'color'>>) {
  const draft = useDraft(toColorInputValue(value), (text) => set(text), SLIDER_COMMIT_DELAY_MS);
  return (
    <FieldShell id={id} field={field}>
      <div className="settings-input-row">
        <input
          id={id}
          className="settings-color-input"
          type="color"
          value={draft.text}
          onChange={(e) => draft.change(e.target.value)}
          onBlur={draft.finish}
        />
        <span className="settings-color-value">{draft.text.toUpperCase()}</span>
      </div>
    </FieldShell>
  );
}

function TimeControl({ id, field, value, set }: ControlProps<FieldOf<'time'>>) {
  const commit = (text: string) => {
    const time = normalizeTime(text);
    if (time !== null && time !== value) set(time);
  };
  const draft = useDraft(asText(value), commit, TEXT_COMMIT_DELAY_MS);
  // Browsers with a native time picker report '' while the input is incomplete.
  const invalid = draft.editing && draft.text !== '' && normalizeTime(draft.text) === null;
  return (
    <FieldShell id={id} field={field}>
      <input
        id={id}
        className={`settings-input${invalid ? ' settings-input-invalid' : ''}`}
        type="time"
        step={60}
        placeholder="HH:MM"
        value={draft.text}
        onChange={(e) => draft.change(e.target.value)}
        onKeyDown={(e) => commitOnEnter(e, draft.flush)}
        onBlur={draft.finish}
      />
      {invalid && <div className="settings-field-error">Uhrzeit im Format HH:MM eingeben</div>}
    </FieldShell>
  );
}

function DaysControl({ id, field, value, set }: ControlProps<FieldOf<'days'>>) {
  const days = useMemo(
    () => new Set(Array.isArray(value) ? value.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : []),
    [value],
  );
  const toggle = (day: number) => {
    const next = new Set(days);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    set([...next].sort((a, b) => a - b));
  };
  return (
    <FieldShell id={id} field={field} asGroup>
      <div className="settings-days">
        {WEEK_DAYS.map(({ day, label, title }) => {
          const active = days.has(day);
          return (
            <button
              key={day}
              type="button"
              className={`settings-day-chip${active ? ' active' : ''}`}
              aria-pressed={active}
              title={title}
              onClick={() => toggle(day)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}

interface MoveButtonsProps {
  index: number;
  count: number;
  label: string;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}

function RowButtons({ index, count, label, onMove, onRemove }: MoveButtonsProps) {
  return (
    <>
      <button
        type="button"
        className="settings-icon-btn"
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
        title="Nach oben"
        aria-label={`${label} nach oben verschieben`}
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        className="settings-icon-btn"
        disabled={index === count - 1}
        onClick={() => onMove(index, index + 1)}
        title="Nach unten"
        aria-label={`${label} nach unten verschieben`}
      >
        <ChevronDown size={16} />
      </button>
      <button
        type="button"
        className="settings-icon-btn danger"
        onClick={() => onRemove(index)}
        title="Entfernen"
        aria-label={`${label} entfernen`}
      >
        <Trash2 size={16} />
      </button>
    </>
  );
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function MultiSelectControl({ id, field, value, set }: ControlProps<FieldOf<'multiselect'>>) {
  const selection = useMemo(() => normalizeSelection(value), [value]);
  // Latest committed list – two quick clicks run before the next render.
  const current = useRef(selection);
  useLayoutEffect(() => {
    current.current = selection;
  }, [selection]);
  const provider = useProviderOptions(field.optionsProvider);
  const choices = useMemo(() => mergeChoices(field.options, provider.options), [field.options, provider.options]);
  const byValue = useMemo(() => new Map(choices.map((choice) => [choice.value, choice])), [choices]);
  const selected = useMemo(() => new Set(selection), [selection]);
  // Without a provider the static options are complete; with one, only a loaded list proves an id unknown.
  // During the first load the chips say so instead of showing raw ids (e.g. planbar cuids).
  const chips = selectionChips(
    selection,
    byValue,
    !field.optionsProvider || provider.loaded,
    provider.loading ? 'Lädt …' : undefined,
  );
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupChoices(filterChoices(choices, query)), [choices, query]);

  const commit = (next: string[]) => {
    current.current = next;
    set(next);
  };

  let emptyText: string | null = null;
  if (groups.length === 0) {
    if (provider.loading && !provider.loaded) emptyText = 'Auswahl wird geladen …';
    else if (choices.length === 0) emptyText = provider.error ? null : 'Keine Einträge verfügbar';
    else emptyText = `Keine Treffer für «${query.trim()}»`;
  }

  return (
    <FieldShell
      id={id}
      field={field}
      asGroup
      badge={selection.length > 0 ? <span className="settings-count-badge">{selection.length}</span> : null}
    >
      <div className="settings-multi">
        {chips.length === 0 ? (
          <div className="settings-list-empty">Nichts ausgewählt</div>
        ) : field.ordered ? (
          <ol className="settings-multi-ordered">
            {chips.map((chip, index) => (
              <li key={chip.value} className={`settings-list-row settings-multi-row${chip.unknown ? ' unknown' : ''}`}>
                <span className="settings-multi-row-label" title={chip.label}>
                  {chip.label}
                </span>
                <RowButtons
                  index={index}
                  count={chips.length}
                  label={chip.label}
                  onMove={(from, to) => commit(moveSelection(current.current, from, to))}
                  onRemove={(i) => commit(current.current.filter((_, j) => j !== i))}
                />
              </li>
            ))}
          </ol>
        ) : (
          <div className="settings-chips">
            {chips.map((chip) => (
              <button
                key={chip.value}
                type="button"
                className={`settings-chip${chip.unknown ? ' unknown' : ''}`}
                onClick={() => commit(removeSelection(current.current, chip.value))}
                title="Entfernen"
                aria-label={`${chip.label} entfernen`}
              >
                <span className="settings-chip-label">{chip.label}</span>
                <X size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        <div className="settings-multi-toolbar">
          {choices.length > MULTI_SEARCH_MIN_CHOICES && (
            <input
              id={id}
              className="settings-input"
              type="search"
              value={query}
              placeholder={field.placeholder ?? 'Suchen …'}
              aria-label={`${field.label} durchsuchen`}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {field.optionsProvider && (
            <button
              type="button"
              className="settings-icon-btn"
              onClick={provider.reload}
              disabled={provider.loading}
              title="Auswahl neu laden"
              aria-label="Auswahl neu laden"
            >
              <RefreshCw size={16} className={provider.loading ? 'settings-spin' : undefined} />
            </button>
          )}
          {selection.length > 0 && (
            <button type="button" className="settings-btn" onClick={() => commit([])}>
              Alle abwählen
            </button>
          )}
        </div>

        <div className="settings-multi-options">
          {groups.map(({ group, items }) => (
            <div key={group ?? ''} className="settings-multi-group" role="group" aria-label={group ?? field.label}>
              {group !== null && <div className="settings-multi-group-title">{group}</div>}
              {items.map((choice) => {
                const checked = selected.has(choice.value);
                return (
                  <label key={choice.value} className={`settings-multi-option${checked ? ' checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => commit(toggleSelection(current.current, choice.value))}
                    />
                    <span className="settings-multi-option-text">
                      <span className="settings-multi-option-label">{choice.label}</span>
                      {choice.hint && <span className="settings-multi-option-hint">{choice.hint}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
          {emptyText && <div className="settings-list-empty">{emptyText}</div>}
        </div>
        {provider.error && <ProviderStatus provider={provider} />}
      </div>
    </FieldShell>
  );
}

function StringListRow({
  value,
  index,
  onCommit,
}: {
  value: string;
  index: number;
  onCommit: (index: number, text: string) => void;
}) {
  const draft = useDraft(value, (text) => onCommit(index, text), TEXT_COMMIT_DELAY_MS);
  return (
    <input
      className="settings-input"
      value={draft.text}
      aria-label={`Eintrag ${index + 1}`}
      onChange={(e) => draft.change(e.target.value)}
      onKeyDown={(e) => commitOnEnter(e, draft.flush)}
      onBlur={draft.finish}
    />
  );
}

function StringListControl({ id, field, value, set }: ControlProps<FieldOf<'stringList'>>) {
  const items = useMemo(() => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []), [value]);
  // Latest committed list – a blur commit and the click that caused it run
  // before the next render, so edits must not build on `items`.
  const current = useRef(items);
  useLayoutEffect(() => {
    current.current = items;
  }, [items]);
  const [newText, setNewText] = useState('');

  const commit = (next: string[]) => {
    current.current = next;
    set(next);
  };
  const add = () => {
    const text = newText.trim();
    if (!text) return;
    commit([...current.current, text]);
    setNewText('');
  };
  const edit = (index: number, text: string) => {
    const clean = text.trim();
    commit(clean ? current.current.map((item, i) => (i === index ? clean : item)) : current.current.filter((_, i) => i !== index));
  };

  return (
    <FieldShell id={id} field={field} asGroup>
      <div className="settings-list">
        {items.length === 0 && <div className="settings-list-empty">Noch keine Einträge</div>}
        {items.map((item, index) => (
          // Index keys are fine: drafts only live while an input is focused,
          // and moving/removing blurs (and commits) it first.
          <div key={index} className="settings-list-row">
            <StringListRow value={item} index={index} onCommit={edit} />
            <RowButtons
              index={index}
              count={items.length}
              label={item || `Eintrag ${index + 1}`}
              onMove={(from, to) => commit(moveItem(current.current, from, to))}
              onRemove={(i) => commit(current.current.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <div className="settings-list-add">
          <input
            id={id}
            className="settings-input"
            value={newText}
            placeholder={field.placeholder ?? 'Neuer Eintrag'}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="settings-btn" onClick={add} disabled={!newText.trim()}>
            <Plus size={16} />
            {field.addLabel ?? 'Hinzufügen'}
          </button>
        </div>
      </div>
    </FieldShell>
  );
}

const itemKey = (item: Record<string, unknown>, index: number): string =>
  typeof item.id === 'string' && item.id ? `id:${item.id}` : `index:${index}`;

function ListControl({ id, field, value, set, context }: ControlProps<FieldOf<'list'>>) {
  const items = useMemo(() => (Array.isArray(value) ? value.filter(isRecord) : []), [value]);
  const current = useRef(items);
  useLayoutEffect(() => {
    current.current = items;
  }, [items]);
  // Long lists start collapsed; new items open.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(items.map((item, i) => [itemKey(item, i), items.length > 2])),
  );

  const commit = (next: Record<string, unknown>[]) => {
    current.current = next;
    set(next);
  };
  const update = (index: number, patch: Record<string, unknown>) => {
    commit(
      current.current.map((item, i) => {
        if (i !== index) return item;
        const merged: Record<string, unknown> = { ...item, ...patch };
        for (const [key, v] of Object.entries(patch)) if (v === undefined) delete merged[key];
        return merged;
      }),
    );
  };
  const add = () => {
    const item = field.newItem();
    const next = [...current.current, item];
    setCollapsed((c) => ({ ...c, [itemKey(item, next.length - 1)]: false }));
    commit(next);
  };

  return (
    <FieldShell id={id} field={field} asGroup>
      <div className="settings-list">
        {items.length === 0 && <div className="settings-list-empty">Noch keine Einträge</div>}
        {items.map((item, index) => {
          const key = itemKey(item, index);
          const isCollapsed = collapsed[key] === true;
          const rawTitle = field.itemTitleKey ? item[field.itemTitleKey] : undefined;
          const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle : `Eintrag ${index + 1}`;
          return (
            <div key={key} className={`settings-list-card${isCollapsed ? ' collapsed' : ''}`}>
              <div className="settings-list-card-header">
                <button
                  type="button"
                  className="settings-list-card-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((c) => ({ ...c, [key]: !isCollapsed }))}
                >
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  <span>{title}</span>
                </button>
                <RowButtons
                  index={index}
                  count={items.length}
                  label={title}
                  onMove={(from, to) => commit(moveItem(current.current, from, to))}
                  onRemove={(i) => commit(current.current.filter((_, j) => j !== i))}
                />
              </div>
              {!isCollapsed && (
                <div className="settings-list-card-body">
                  <SettingsForm
                    schema={field.itemFields}
                    values={item}
                    onChange={(patch) => update(index, patch)}
                    context={context}
                  />
                </div>
              )}
            </div>
          );
        })}
        <div>
          <button type="button" className="settings-btn" onClick={add}>
            <Plus size={16} />
            {field.addLabel ?? 'Eintrag hinzufügen'}
          </button>
        </div>
      </div>
    </FieldShell>
  );
}

// ── Form ─────────────────────────────────────────────────────────────────────

function FieldControl(props: ControlProps<ValueField>) {
  const { field } = props;
  switch (field.type) {
    case 'text':
    case 'url':
    case 'textarea':
      return <TextControl {...props} field={field} />;
    case 'secret':
      return <SecretControl {...props} field={field} />;
    case 'number':
      return <NumberControl {...props} field={field} />;
    case 'boolean':
      return <BooleanControl {...props} field={field} />;
    case 'select':
      return <SelectControl {...props} field={field} />;
    case 'multiselect':
      return <MultiSelectControl {...props} field={field} />;
    case 'radio':
      return <RadioControl {...props} field={field} />;
    case 'range':
      return <RangeControl {...props} field={field} />;
    case 'color':
      return <ColorControl {...props} field={field} />;
    case 'time':
      return <TimeControl {...props} field={field} />;
    case 'days':
      return <DaysControl {...props} field={field} />;
    case 'stringList':
      return <StringListControl {...props} field={field} />;
    case 'list':
      return <ListControl {...props} field={field} />;
  }
}

export function SettingsForm({ schema, values, onChange, context }: SettingsFormProps) {
  const baseId = useId();
  const groups = useMemo(() => groupFields(schema), [schema]);

  const renderField = (field: ValueField) => (
    <FieldControl
      key={field.key}
      id={`${baseId}-${field.key}`}
      field={field}
      value={values[field.key]}
      set={(value) => onChange({ [field.key]: value })}
      context={context}
    />
  );

  return (
    <div className="settings-form">
      {groups.map((group, index) => {
        const fields = group.fields.filter((field) => isVisible(field, values, context));
        if (!group.section) return fields.map(renderField);
        const { section } = group;
        if (!isVisible(section, values, context) || (fields.length === 0 && !section.description)) return null;
        return (
          <section key={`section-${index}`} className="settings-section">
            <div className="settings-section-title">{section.label}</div>
            {section.description && <div className="settings-section-description">{section.description}</div>}
            {fields.map(renderField)}
          </section>
        );
      })}
    </div>
  );
}
