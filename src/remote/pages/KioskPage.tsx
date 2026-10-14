/**
 * Kiosk: name and local operation, display schedule, design (mode, accent)
 * and the grid. Forms are SettingsForm schemas bound to their part of the
 * state; every change is written at once and shows on the kiosk live – except
 * the column count, which rearranges all widgets and therefore waits for
 * «Übernehmen» (and can be undone).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Grid3x3, LayoutGrid, Moon, Palette, RotateCcw, SlidersHorizontal, Sun } from 'lucide-react';
import { SettingsForm } from '../../components/settings/SettingsForm';
import { useAppState } from '../../state/appState';
import { layoutActions, themeActions } from '../../state/dataActions';
import { bottomOf, DEFAULT_STATE } from '../../state/defaults';
import type { DisplaySchedule, Path, ThemeMode, WidgetInstance } from '../../state/types';
import { fitRowHeight } from '../../types/grid';
import type { SettingsField } from '../../types/settings';
import { formatNumber } from '../format';
import { useSystemInfo } from '../hooks/useSystemInfo';
import { compactWidgets, rescaleWidgets, rowsOnScreen } from '../kioskGrid';
import { href } from '../router';
import { Button, Card, Field, LinkButton, Notice, PageHeader, Segmented, toast, type SegmentedOption } from '../ui';

const VIEWPORT_POLL_MS = 60_000;

const mergeInto = (path: Path, patch: Record<string, unknown>): Promise<boolean> =>
  useAppState.getState().apply([{ op: 'merge', path, value: patch }]);

// ── Allgemein ────────────────────────────────────────────────────────────────

const GENERAL_SCHEMA: SettingsField[] = [
  {
    type: 'text',
    key: 'name',
    label: 'Name',
    placeholder: DEFAULT_STATE.kiosk.name,
    description: 'Erscheint in der Fernsteuerung und beim Identifizieren auf dem Kiosk.',
  },
  { type: 'section', label: 'Bedienung am Kiosk' },
  {
    type: 'boolean',
    key: 'showTopBar',
    label: 'Obere Leiste anzeigen',
    description: 'Ausgeblendet erscheint sie für 30 Sekunden, wenn die Ecke oben rechts angetippt wird.',
  },
  {
    type: 'boolean',
    key: 'allowLocalEditing',
    label: 'Bearbeiten am Kiosk erlauben',
    description:
      'Aus: Layout und Widgets lassen sich nur noch über die Fernsteuerung ändern – und der Kiosk zeigt den PIN der Fernsteuerung nicht mehr an (er steht unter «Bearbeiten» → «Fernsteuerung»).',
  },
  {
    type: 'number',
    key: 'editModeAutoExitMinutes',
    label: 'Bearbeiten automatisch beenden nach',
    description: 'Ohne Eingabe am Kiosk endet der Bearbeitungsmodus nach dieser Zeit. 0 = nie.',
    min: 0,
    max: 1440,
    step: 1,
    unit: 'Min.',
  },
  {
    type: 'number',
    key: 'cursorHideSeconds',
    label: 'Mauszeiger ausblenden nach',
    description: 'Ohne Mausbewegung verschwindet der Zeiger nach dieser Zeit. 0 = nie ausblenden.',
    min: 0,
    max: 86_400,
    step: 1,
    unit: 's',
  },
];

function GeneralCard() {
  const kiosk = useAppState((s) => s.state.kiosk);
  const values = useMemo<Record<string, unknown>>(
    () => ({
      name: kiosk.name,
      showTopBar: kiosk.showTopBar,
      allowLocalEditing: kiosk.allowLocalEditing,
      editModeAutoExitMinutes: kiosk.editModeAutoExitMinutes,
      cursorHideSeconds: kiosk.cursorHideSeconds,
    }),
    [kiosk],
  );

  const onChange = useCallback((patch: Record<string, unknown>) => {
    const clean = { ...patch };
    if (typeof clean.name === 'string') clean.name = clean.name.trim() || DEFAULT_STATE.kiosk.name;
    void mergeInto(['kiosk'], clean);
  }, []);

  return (
    <Card title="Allgemein" icon={SlidersHorizontal}>
      <div className="r-settings">
        <SettingsForm schema={GENERAL_SCHEMA} values={values} onChange={onChange} context="remote" />
      </div>
      {!kiosk.allowLocalEditing && (
        <Notice tone="warning" title="PIN am Kiosk nicht abrufbar">
          Ohne «Bearbeiten» zeigt der Kiosk den PIN der Fernsteuerung nicht mehr an. Den PIN gut aufbewahren – ändern lässt
          er sich unter System, solange ein Gerät angemeldet ist.
        </Notice>
      )}
    </Card>
  );
}

// ── Bildschirmzeiten ─────────────────────────────────────────────────────────

const scheduleOn = (values: Record<string, unknown>): boolean => values.enabled === true;

const SCHEDULE_SCHEMA: SettingsField[] = [
  {
    type: 'boolean',
    key: 'enabled',
    label: 'Bildschirm nach Zeitplan ein- und ausschalten',
    description: 'Ausserhalb der Zeiten ist der Bildschirm aus. Eine Berührung weckt ihn für 5 Minuten.',
  },
  { type: 'time', key: 'on', label: 'Einschalten um', showIf: scheduleOn },
  { type: 'time', key: 'off', label: 'Ausschalten um', showIf: scheduleOn },
  { type: 'days', key: 'days', label: 'An diesen Tagen', showIf: scheduleOn },
];

const DAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
/** Monday first, as in the day chips. */
const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** «täglich», «Mo–Fr», «Mo–Mi, Sa». */
function daysText(days: readonly number[]): string {
  const selected = WEEK_ORDER.filter((day) => days.includes(day));
  if (selected.length === 7) return 'täglich';
  const runs: number[][] = [];
  for (const day of selected) {
    const run = runs[runs.length - 1];
    const previous = run?.[run.length - 1];
    if (run && previous !== undefined && WEEK_ORDER.indexOf(previous) + 1 === WEEK_ORDER.indexOf(day)) run.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) =>
      run.length >= 3
        ? `${DAY_SHORT[run[0]]}–${DAY_SHORT[run[run.length - 1]]}`
        : run.map((day) => DAY_SHORT[day]).join(', '),
    )
    .join(', ');
}

function scheduleSummary(schedule: DisplaySchedule): { tone: 'info' | 'warning'; text: string } {
  if (schedule.days.length === 0) {
    return { tone: 'warning', text: 'Kein Tag gewählt – der Bildschirm bleibt dauerhaft aus. Mindestens einen Tag wählen.' };
  }
  const days = daysText(schedule.days);
  if (schedule.on === schedule.off) {
    return schedule.days.length === 7
      ? { tone: 'info', text: 'Der Bildschirm bleibt immer eingeschaltet (gleiche Ein- und Ausschaltzeit).' }
      : { tone: 'info', text: `Der Bildschirm ist ${days} ganztags eingeschaltet, an den übrigen Tagen aus.` };
  }
  const window =
    schedule.on < schedule.off
      ? `von ${schedule.on} bis ${schedule.off} Uhr`
      : `ab ${schedule.on} Uhr bis ${schedule.off} Uhr am Folgetag`;
  return { tone: 'info', text: `Der Bildschirm ist ${days} ${window} eingeschaltet, sonst aus.` };
}

function ScheduleCard() {
  const schedule = useAppState((s) => s.state.kiosk.displaySchedule);
  const values = useMemo<Record<string, unknown>>(() => ({ ...schedule }), [schedule]);
  const onChange = useCallback((patch: Record<string, unknown>) => {
    void mergeInto(['kiosk', 'displaySchedule'], patch);
  }, []);
  const summary = scheduleSummary(schedule);

  return (
    <Card title="Bildschirmzeiten" icon={CalendarClock} subtitle="Schaltet den Bildschirm z.B. nachts und am Wochenende aus.">
      <div className="r-settings">
        <SettingsForm schema={SCHEDULE_SCHEMA} values={values} onChange={onChange} context="remote" />
      </div>
      {schedule.enabled && <Notice tone={summary.tone}>{summary.text}</Notice>}
    </Card>
  );
}

// ── Design ───────────────────────────────────────────────────────────────────

/** Accent of each theme when none is chosen (tokens.css). */
const THEME_ACCENTS: Record<ThemeMode, string> = { dark: '#e8642b', light: '#0a8a85' };

const ACCENT_PRESETS: readonly { color: string; label: string }[] = [
  { color: '#e8642b', label: 'Orange' },
  { color: '#0a8a85', label: 'Petrol' },
  { color: '#2f7bf5', label: 'Blau' },
  { color: '#7c5cff', label: 'Violett' },
  { color: '#16a34a', label: 'Grün' },
  { color: '#e11d48', label: 'Rot' },
  { color: '#d4a017', label: 'Gold' },
];

const MODE_OPTIONS: readonly SegmentedOption<ThemeMode>[] = [
  { value: 'dark', label: 'Dunkel', icon: Moon },
  { value: 'light', label: 'Hell', icon: Sun },
];

/** `<input type="color">` only takes #rrggbb – stored accents may be #rgb or carry alpha. */
function toColorInputValue(hex: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/i.exec(hex);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex);
  return long ? `#${long[1].toLowerCase()}` : '#000000';
}

/** Native colour picker; while it is dragged only the last colour is written (after a short pause). */
const COLOR_COMMIT_DELAY_MS = 300;

function CustomColorInput({ value, onCommit }: { value: string; onCommit: (color: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(onCommit);
  useLayoutEffect(() => {
    commitRef.current = onCommit;
  });

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next !== null) commitRef.current(next);
  }, []);

  useEffect(() => () => flush(), [flush]);

  return (
    <label className="rk-custom-color" title="Eigene Farbe wählen">
      <input
        type="color"
        value={draft ?? toColorInputValue(value)}
        onChange={(event) => {
          setDraft(event.target.value);
          pending.current = event.target.value;
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(flush, COLOR_COMMIT_DELAY_MS);
        }}
        onBlur={() => {
          flush();
          setDraft(null);
        }}
      />
      <span>Eigene Farbe</span>
    </label>
  );
}

function DesignCard() {
  const mode = useAppState((s) => s.state.theme.mode);
  const accent = useAppState((s) => s.state.theme.accent);
  const current = (accent ?? THEME_ACCENTS[mode]).toLowerCase();
  const isPreset = (color: string): boolean => accent !== null && accent.toLowerCase() === color;

  const setAccent = (color: string | null) => void themeActions.setAccent(color);

  return (
    <Card
      title="Design"
      icon={Palette}
      subtitle="Erscheinungsbild des Kiosks. Die Darstellung dieser Fernsteuerung wird separat gewählt."
    >
      <div className="r-settings r-form">
        <Field label="Modus">
          <Segmented
            label="Modus des Kiosks"
            value={mode}
            options={MODE_OPTIONS}
            onChange={(next) => void themeActions.setMode(next)}
            block
          />
        </Field>
        <Field
          label="Akzentfarbe"
          description="Für Hervorhebungen, Schaltflächen und Diagramme auf dem Kiosk."
        >
          <div className="rk-swatches">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.color}
                type="button"
                className={`rk-swatch${isPreset(preset.color) ? ' is-active' : ''}`}
                style={{ backgroundColor: preset.color }}
                aria-pressed={isPreset(preset.color)}
                aria-label={preset.label}
                title={preset.label}
                onClick={() => setAccent(preset.color)}
              />
            ))}
            <CustomColorInput value={current} onCommit={setAccent} />
          </div>
          <div className="rk-accent-row">
            <span className="rk-accent-current">
              <span className="rk-accent-dot" style={{ backgroundColor: current }} aria-hidden="true" />
              {accent === null ? `Standardfarbe des Designs (${current.toUpperCase()})` : current.toUpperCase()}
            </span>
            <Button size="sm" variant="ghost" icon={RotateCcw} disabled={accent === null} onClick={() => setAccent(null)}>
              Standardfarbe
            </Button>
          </div>
        </Field>
      </div>
    </Card>
  );
}

// ── Raster ───────────────────────────────────────────────────────────────────

/** Column counts offered (the stored one is always among them). */
const COLS_MIN = 6;
const COLS_MAX = 24;

/** Grid before a column change – «Rückgängig» brings it back. */
interface GridSnapshot {
  cols: number;
  widgets: readonly WidgetInstance[];
}

function setColumns(cols: number, widgets: readonly WidgetInstance[]): Promise<boolean> {
  // Columns and positions in one write – the kiosk never shows the widgets in the wrong grid.
  return useAppState.getState().apply([
    { op: 'set', path: ['layout', 'cols'], value: cols },
    { op: 'set', path: ['layout', 'widgets'], value: widgets },
  ]);
}

/**
 * Column count as a deliberate step: choose, then «Übernehmen». Each change
 * rearranges every widget on the kiosk, so it must not run for in-between
 * values (typing pauses, spinner steps) that would each rescale the result
 * of the previous one. Widgets are rescaled from the grid as it is at the
 * click; the toast offers to undo the change.
 */
function ColumnsField() {
  const id = useId();
  const cols = useAppState((s) => s.state.layout.cols);
  const widgets = useAppState((s) => s.state.layout.widgets);
  const [choice, setChoice] = useState<number | null>(null);
  const target = choice ?? cols;
  const options = useMemo(() => {
    const range = Array.from({ length: COLS_MAX - COLS_MIN + 1 }, (_, index) => COLS_MIN + index);
    return range.includes(cols) ? range : [...range, cols].sort((a, b) => a - b);
  }, [cols]);
  // Rows on the kiosk before and after: minimum widths that do not fit side by side push widgets down.
  const rows = useMemo(
    () =>
      target === cols
        ? null
        : { before: bottomOf(compactWidgets(widgets, cols)), after: bottomOf(rescaleWidgets(widgets, cols, target)) },
    [widgets, cols, target],
  );

  const applyChoice = () => {
    const { layout } = useAppState.getState().state;
    const snapshot: GridSnapshot = { cols: layout.cols, widgets: layout.widgets };
    setChoice(null);
    if (target === snapshot.cols) return;
    void setColumns(target, rescaleWidgets(snapshot.widgets, snapshot.cols, target)).then((ok) => {
      if (!ok) return;
      toast.success(`Raster auf ${target} Spalten umgestellt – die Widgets wurden angepasst`, {
        action: {
          label: 'Rückgängig',
          run: () => {
            void setColumns(snapshot.cols, snapshot.widgets).then((restored) => {
              if (restored) toast.success(`Raster wieder auf ${snapshot.cols} Spalten`);
            });
          },
        },
      });
    });
  };

  return (
    <Field
      label="Spalten"
      htmlFor={id}
      description="Breite des Rasters. Beim Übernehmen werden alle Widgets proportional angepasst."
    >
      <div className="settings-input-row">
        <select id={id} className="settings-select" value={target} onChange={(event) => setChoice(Number(event.target.value))}>
          {options.map((count) => (
            <option key={count} value={count}>
              {count === cols ? `${count} (aktuell)` : count}
            </option>
          ))}
        </select>
        <Button variant="primary" disabled={target === cols} onClick={applyChoice}>
          Übernehmen
        </Button>
      </div>
      {rows && rows.after > rows.before && (
        <div className="rk-cols-warning">
          <Notice tone="warning">
            Bei {target} Spalten passen nicht alle Widgets nebeneinander – einige rutschen nach unten ({rows.before} →{' '}
            {rows.after} Zeilen).
          </Notice>
        </div>
      )}
    </Field>
  );
}

const GRID_SCHEMA: SettingsField[] = [
  {
    type: 'number',
    key: 'fitRows',
    label: 'Zeilen auf Bildschirmhöhe einpassen',
    description:
      '0 = aus: feste Zeilenhöhe, das Dashboard darf länger als der Bildschirm sein. Bei z.B. 8 wird die Zeilenhöhe so berechnet, dass genau 8 Zeilen den Bildschirm füllen.',
    min: 0,
    max: 20,
    step: 1,
    unit: 'Zeilen',
  },
  {
    type: 'number',
    key: 'rowHeight',
    label: 'Zeilenhöhe',
    description: 'Höhe einer Rasterzeile auf dem Kiosk.',
    min: 40,
    max: 200,
    step: 1,
    unit: 'px',
    showIf: (values) => values.fitRows === 0,
  },
];

function GridCard() {
  const rowHeight = useAppState((s) => s.state.layout.rowHeight);
  const fitRows = useAppState((s) => s.state.layout.fitRows);
  const viewport = useSystemInfo(VIEWPORT_POLL_MS).data?.viewport ?? null;
  const values = useMemo<Record<string, unknown>>(() => ({ rowHeight, fitRows }), [rowHeight, fitRows]);

  const onChange = useCallback((patch: Record<string, unknown>) => {
    void layoutActions.setGrid(patch);
  }, []);

  let info: string;
  if (!viewport) info = 'Der Kiosk hat seine Bildschirmgrösse noch nicht gemeldet.';
  else if (fitRows > 0) {
    info = `Auf dem Bildschirm des Kiosks (${viewport.width} × ${viewport.height} px) ergibt das eine Zeilenhöhe von ${formatNumber(fitRowHeight(viewport.height, fitRows), 0)} px.`;
  } else {
    info = `Auf dem Bildschirm des Kiosks (${viewport.width} × ${viewport.height} px) haben ${rowsOnScreen(viewport.height, rowHeight)} Zeilen Platz.`;
  }

  return (
    <Card
      title="Raster"
      icon={Grid3x3}
      subtitle="Aufteilung des Dashboards in Spalten und Zeilen."
      actions={
        <LinkButton href={href('layout')} size="sm" icon={LayoutGrid}>
          Layout
        </LinkButton>
      }
    >
      <div className="r-settings">
        <ColumnsField />
        <SettingsForm schema={GRID_SCHEMA} values={values} onChange={onChange} context="remote" />
      </div>
      <p className="r-hint">{info}</p>
    </Card>
  );
}

export function KioskPage() {
  return (
    <div className="r-page">
      <PageHeader title="Kiosk" description="Name, Bedienung, Bildschirmzeiten, Design und Raster – Änderungen gelten sofort." />
      <GeneralCard />
      <ScheduleCard />
      <DesignCard />
      <GridCard />
    </div>
  );
}
