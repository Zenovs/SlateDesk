/**
 * One-time import of the pre-backend localStorage state and initial fill of
 * missing top-level sections. Runs only in the kiosk (or local dev) context –
 * the web UI never writes defaults on its own.
 */
import { DEFAULT_STATE, isHexColor, sanitizeWidgets, DEFAULT_COLS } from './defaults';
import { isPlainObject } from './ops';
import type { RawState, StateOp, ThemeData, WidgetInstance } from './types';
// Type-only imports in clock.ts: no import cycle.
import { upgradeLegacyClockSettings } from '../widgets/manifests/clock';

export const LEGACY_KEYS = {
  layout: 'slatedesk-layout',
  widgetSettings: 'slatedesk-widget-settings',
  theme: 'slatedesk-theme',
  accent: 'slatedesk-accent',
} as const;

export const MIGRATED_KEY = 'slatedesk-migrated';

/** Widget ids that existed before the backend state – the only ones legacy data can contain. */
const LEGACY_WIDGET_IDS: readonly string[] = [
  'clock',
  'calendar',
  'weather',
  'messages',
  'todo',
  'news',
  'nas',
  'speedtest',
  'volumio',
  'camera',
  'sleeper',
  'whisper',
];

/** The old default accent; it was never user-chosen (no UI) and clashed with the light theme. */
const LEGACY_DEFAULT_ACCENT = '#e8642b';

export type LegacyStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface LegacyState {
  /** null = no stored layout. */
  widgets: WidgetInstance[] | null;
  widgetSettings: Record<string, Record<string, unknown>>;
  theme: ThemeData | null;
}

function readJson(storage: LegacyStorage, key: string): unknown {
  try {
    const text = storage.getItem(key);
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

function readString(storage: LegacyStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Reads and sanitizes the legacy keys (finite numbers, known widget ids). */
export function readLegacyState(
  storage: LegacyStorage,
  knownWidgetIds: readonly string[] = LEGACY_WIDGET_IDS,
): LegacyState {
  const known = new Set(knownWidgetIds);
  const layout = readJson(storage, LEGACY_KEYS.layout);
  const widgets = Array.isArray(layout)
    ? sanitizeWidgets(
        layout.filter((item) => isPlainObject(item) && known.has(item.widgetId as string)),
        DEFAULT_COLS,
      )
    : null;

  const widgetSettings: Record<string, Record<string, unknown>> = {};
  const storedSettings = readJson(storage, LEGACY_KEYS.widgetSettings);
  if (isPlainObject(storedSettings) && widgets) {
    for (const { instanceId, widgetId } of widgets) {
      const settings = storedSettings[instanceId];
      if (!isPlainObject(settings)) continue;
      widgetSettings[instanceId] = widgetId === 'clock' ? upgradeLegacyClockSettings(settings) : settings;
    }
  }

  const mode = readString(storage, LEGACY_KEYS.theme);
  const accent = readString(storage, LEGACY_KEYS.accent);
  const hasAccent = isHexColor(accent) && accent.toLowerCase() !== LEGACY_DEFAULT_ACCENT;
  const theme: ThemeData | null =
    mode === 'light' || mode === 'dark' || hasAccent
      ? { mode: mode === 'light' ? 'light' : 'dark', accent: hasAccent ? accent : null }
      : null;

  return { widgets, widgetSettings, theme };
}

const isMissing = (raw: RawState, key: string): boolean => raw[key] === undefined || raw[key] === null;

/**
 * Ops that bring a freshly loaded backend state up to date:
 * - no `layout` yet → import the legacy layout/settings/theme (once, unless
 *   `slatedesk-migrated=1`), otherwise the default dashboard
 * - every other missing top-level section → its defaults
 * Returns [] when nothing needs to be written.
 */
export function buildInitialOps(
  raw: RawState,
  storage: LegacyStorage | null,
  knownWidgetIds: readonly string[] = LEGACY_WIDGET_IDS,
): StateOp[] {
  const ops: StateOp[] = [];
  let legacy: LegacyState | null = null;

  if (isMissing(raw, 'layout')) {
    if (storage && readString(storage, MIGRATED_KEY) !== '1') legacy = readLegacyState(storage, knownWidgetIds);
    ops.push({
      op: 'set',
      path: ['layout'],
      value: { ...DEFAULT_STATE.layout, widgets: legacy?.widgets ?? DEFAULT_STATE.layout.widgets },
    });
  }

  if (isMissing(raw, 'version')) ops.push({ op: 'set', path: ['version'], value: DEFAULT_STATE.version });

  const legacySettings = legacy?.widgetSettings ?? {};
  if (isMissing(raw, 'widgetSettings')) {
    ops.push({ op: 'set', path: ['widgetSettings'], value: legacySettings });
  } else if (isPlainObject(raw.widgetSettings)) {
    const existing = raw.widgetSettings;
    for (const [instanceId, settings] of Object.entries(legacySettings)) {
      if (existing[instanceId] === undefined) ops.push({ op: 'set', path: ['widgetSettings', instanceId], value: settings });
    }
  }

  if (isMissing(raw, 'theme')) ops.push({ op: 'set', path: ['theme'], value: legacy?.theme ?? DEFAULT_STATE.theme });
  if (isMissing(raw, 'kiosk')) ops.push({ op: 'set', path: ['kiosk'], value: DEFAULT_STATE.kiosk });
  if (isMissing(raw, 'lagra')) ops.push({ op: 'set', path: ['lagra'], value: DEFAULT_STATE.lagra });
  if (isMissing(raw, 'planbar')) ops.push({ op: 'set', path: ['planbar'], value: DEFAULT_STATE.planbar });
  if (isMissing(raw, 'data')) ops.push({ op: 'set', path: ['data'], value: DEFAULT_STATE.data });

  return ops;
}

/** The legacy keys stay (harmless) but are never read again. */
function markMigrated(storage: LegacyStorage | null): void {
  try {
    storage?.setItem(MIGRATED_KEY, '1');
  } catch {
    // Storage blocked – the backend already has a layout, so it won't be read again anyway.
  }
}

function browserStorage(): LegacyStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Writes the initial/migrated sections via `apply`. Marks the migration as
 * done only after the backend accepted it, so a failed write is retried on
 * the next start.
 */
export async function migrateLegacyState(
  raw: RawState,
  apply: (ops: StateOp[]) => Promise<boolean>,
  storage: LegacyStorage | null = browserStorage(),
  knownWidgetIds?: readonly string[],
): Promise<boolean> {
  const ops = buildInitialOps(raw, storage, knownWidgetIds);
  if (ops.length > 0 && !(await apply(ops))) return false;
  markMigrated(storage);
  return true;
}
