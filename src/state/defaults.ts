/**
 * Defaults and sanitizing for the persisted state.
 *
 * The backend stores whatever clients wrote; nothing in it is assumed to be
 * present or well-formed. `withDefaults()` turns any input into a complete,
 * render-safe AppStateData (one bad value must never blank the kiosk).
 */
import { isPlainObject } from './ops';
import type {
  Announcement,
  AnnouncementLevel,
  AppStateData,
  DisplaySchedule,
  KioskConfig,
  LagraConfig,
  LayoutData,
  PlanbarConfig,
  ThemeData,
  TodoItem,
  TodoPriority,
  WidgetInstance,
} from './types';

export const DEFAULT_LAGRA_URL = 'https://lagra.schnyder-werbung.ch';
export const DEFAULT_PLANBAR_URL = 'https://planbar.dev';
export const DEFAULT_TODO_LIST = 'Allgemein';

export const DEFAULT_COLS = 12;
export const DEFAULT_ROW_HEIGHT = 80;
export const MIN_COLS = 1;
export const MAX_COLS = 48;
export const MIN_ROW_HEIGHT = 20;
export const MAX_ROW_HEIGHT = 400;
export const MAX_FIT_ROWS = 48;
/** Upper bound for a single widget's height – guards against runaway values. */
export const MAX_WIDGET_ROWS = 100;

const DEFAULT_WIDGET_W = 4;
const DEFAULT_WIDGET_H = 3;

/**
 * First-start dashboard: 12 columns × 11 rows, which is what fits a 1920×1080
 * kiosk at the default row height below the top bar (52 px top bar, 12 px
 * margins and padding → 11 rows = 1024 of 1028 px). Clock, Weather (location
 * from the IP address) and News show content right away; the others explain
 * what to set up.
 */
export const DEFAULT_WIDGETS: readonly WidgetInstance[] = [
  { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 },
  { instanceId: 'messages-1', widgetId: 'messages', x: 0, y: 3, w: 3, h: 8 },
  { instanceId: 'calendar-1', widgetId: 'calendar', x: 3, y: 0, w: 5, h: 7 },
  { instanceId: 'news-1', widgetId: 'news', x: 3, y: 7, w: 5, h: 4 },
  { instanceId: 'weather-1', widgetId: 'weather', x: 8, y: 0, w: 4, h: 5 },
  { instanceId: 'todo-1', widgetId: 'todo', x: 8, y: 5, w: 4, h: 6 },
];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Frozen – used as initial store state before the backend answered. */
export const DEFAULT_STATE: AppStateData = deepFreeze({
  version: 1,
  layout: {
    widgets: DEFAULT_WIDGETS.map((w) => ({ ...w })),
    cols: DEFAULT_COLS,
    rowHeight: DEFAULT_ROW_HEIGHT,
    fitRows: 0,
  },
  widgetSettings: {},
  theme: { mode: 'dark', accent: null },
  kiosk: {
    name: 'SlateDesk',
    showTopBar: true,
    allowLocalEditing: true,
    editModeAutoExitMinutes: 10,
    cursorHideSeconds: 300,
    displaySchedule: { enabled: false, on: '07:00', off: '19:00', days: [1, 2, 3, 4, 5] },
  },
  lagra: { enabled: false, url: DEFAULT_LAGRA_URL, token: '' },
  planbar: { enabled: false, url: DEFAULT_PLANBAR_URL, apiKey: '' },
  data: { todos: {}, announcements: {} },
});

// ── Primitive helpers ────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const asObject = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const finiteInt = (value: unknown): number | null => {
  const n = finiteNumber(value);
  return n === null ? null : Math.round(n);
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const intInRange = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = finiteInt(value);
  return n === null ? fallback : clamp(n, min, max);
};

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && HEX_COLOR_RE.test(value);

export const isTimeOfDay = (value: unknown): value is string =>
  typeof value === 'string' && TIME_RE.test(value);

// ── Layout ───────────────────────────────────────────────────────────────────

/** First free row below all widgets. */
export function bottomOf(widgets: readonly Pick<WidgetInstance, 'y' | 'h'>[]): number {
  return widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
}

type Rect = Pick<WidgetInstance, 'x' | 'y' | 'w' | 'h'>;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Top-most, then left-most position where a w×h widget overlaps nothing –
 * a gap in the layout if there is one, else the first row below all widgets.
 */
export function firstFreeSlot(widgets: readonly Rect[], cols: number, w: number, h: number): { x: number; y: number } {
  const width = Math.max(1, Math.min(w, cols));
  const bottom = bottomOf(widgets);
  for (let y = 0; y < bottom; y += 1) {
    for (let x = 0; x + width <= cols; x += 1) {
      const candidate = { x, y, w: width, h };
      if (!widgets.some((other) => overlaps(candidate, other))) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}

/**
 * Finite integers only, w/h ≥ 1, x clamped so the widget fits into `cols`.
 * Items without a usable y (Infinity, null, negative) are stacked below the
 * rest. Items without ids and duplicate instanceIds are dropped.
 */
export function sanitizeWidgets(input: unknown, cols: number): WidgetInstance[] {
  if (!Array.isArray(input)) return [];
  const gridCols = Math.max(1, Math.round(cols));
  const seen = new Set<string>();
  const items: (WidgetInstance & { placed: boolean })[] = [];

  for (const raw of input) {
    if (!isPlainObject(raw)) continue;
    const instanceId = nonEmptyString(raw.instanceId);
    const widgetId = nonEmptyString(raw.widgetId);
    if (!instanceId || !widgetId || seen.has(instanceId)) continue;
    seen.add(instanceId);

    const w = intInRange(raw.w, 1, gridCols, Math.min(DEFAULT_WIDGET_W, gridCols));
    const h = intInRange(raw.h, 1, MAX_WIDGET_ROWS, DEFAULT_WIDGET_H);
    const x = intInRange(raw.x, 0, gridCols - w, 0);
    const y = finiteInt(raw.y);
    const placed = y !== null && y >= 0;
    items.push({ instanceId, widgetId, x, y: placed ? y : 0, w, h, placed });
  }

  let bottom = bottomOf(items.filter((item) => item.placed));
  return items.map(({ placed, ...item }) => {
    if (placed) return item;
    const stacked = { ...item, y: bottom };
    bottom += item.h;
    return stacked;
  });
}

function layoutWithDefaults(value: unknown): LayoutData {
  const raw = asObject(value);
  const cols = intInRange(raw.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
  return {
    // Missing list → default dashboard; an explicitly empty list stays empty.
    widgets: Array.isArray(raw.widgets)
      ? sanitizeWidgets(raw.widgets, cols)
      : sanitizeWidgets(DEFAULT_WIDGETS, cols),
    cols,
    rowHeight: intInRange(raw.rowHeight, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, DEFAULT_ROW_HEIGHT),
    fitRows: intInRange(raw.fitRows, 0, MAX_FIT_ROWS, 0),
  };
}

// ── Other sections ───────────────────────────────────────────────────────────

// Entries keyed '__proto__' would set the prototype on assignment – skip them.
const usableKey = (key: string): boolean => key !== '__proto__';

function widgetSettingsWithDefaults(value: unknown): AppStateData['widgetSettings'] {
  const out: AppStateData['widgetSettings'] = {};
  for (const [id, settings] of Object.entries(asObject(value))) {
    if (usableKey(id) && isPlainObject(settings)) out[id] = settings;
  }
  return out;
}

function themeWithDefaults(value: unknown): ThemeData {
  const raw = asObject(value);
  return {
    mode: raw.mode === 'light' || raw.mode === 'dark' ? raw.mode : DEFAULT_STATE.theme.mode,
    accent: isHexColor(raw.accent) ? raw.accent : null,
  };
}

function scheduleWithDefaults(value: unknown): DisplaySchedule {
  const raw = asObject(value);
  const fallback = DEFAULT_STATE.kiosk.displaySchedule;
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : [...fallback.days];
  return {
    enabled: bool(raw.enabled, fallback.enabled),
    on: isTimeOfDay(raw.on) ? raw.on : fallback.on,
    off: isTimeOfDay(raw.off) ? raw.off : fallback.off,
    days,
  };
}

function kioskWithDefaults(value: unknown): KioskConfig {
  const raw = asObject(value);
  const fallback = DEFAULT_STATE.kiosk;
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallback.name,
    showTopBar: bool(raw.showTopBar, fallback.showTopBar),
    allowLocalEditing: bool(raw.allowLocalEditing, fallback.allowLocalEditing),
    editModeAutoExitMinutes: intInRange(raw.editModeAutoExitMinutes, 0, 24 * 60, fallback.editModeAutoExitMinutes),
    cursorHideSeconds: intInRange(raw.cursorHideSeconds, 0, 24 * 3600, fallback.cursorHideSeconds),
    displaySchedule: scheduleWithDefaults(raw.displaySchedule),
  };
}

function lagraWithDefaults(value: unknown): LagraConfig {
  const raw = asObject(value);
  return {
    enabled: bool(raw.enabled, DEFAULT_STATE.lagra.enabled),
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : DEFAULT_LAGRA_URL,
    token: typeof raw.token === 'string' ? raw.token : '',
  };
}

function planbarWithDefaults(value: unknown): PlanbarConfig {
  const raw = asObject(value);
  return {
    enabled: bool(raw.enabled, DEFAULT_STATE.planbar.enabled),
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : DEFAULT_PLANBAR_URL,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
  };
}

const PRIORITIES: readonly TodoPriority[] = ['niedrig', 'normal', 'hoch'];
const LEVELS: readonly AnnouncementLevel[] = ['info', 'wichtig', 'erfolg'];

function sanitizeTodo(id: string, value: unknown): TodoItem | null {
  if (!isPlainObject(value) || typeof value.text !== 'string') return null;
  const item: TodoItem = {
    id,
    text: value.text,
    done: value.done === true,
    createdAt: finiteNumber(value.createdAt) ?? 0,
  };
  const list = nonEmptyString(value.list);
  if (list) item.list = list;
  if (PRIORITIES.includes(value.priority as TodoPriority)) item.priority = value.priority as TodoPriority;
  if (typeof value.due === 'string' && DATE_RE.test(value.due)) item.due = value.due;
  const assignee = nonEmptyString(value.assignee);
  if (assignee) item.assignee = assignee;
  const doneAt = finiteNumber(value.doneAt);
  if (doneAt !== null) item.doneAt = doneAt;
  return item;
}

function sanitizeAnnouncement(id: string, value: unknown): Announcement | null {
  if (!isPlainObject(value) || typeof value.title !== 'string') return null;
  const item: Announcement = {
    id,
    title: value.title,
    level: LEVELS.includes(value.level as AnnouncementLevel) ? (value.level as AnnouncementLevel) : 'info',
    createdAt: finiteNumber(value.createdAt) ?? 0,
  };
  if (typeof value.text === 'string' && value.text !== '') item.text = value.text;
  const author = nonEmptyString(value.author);
  if (author) item.author = author;
  const from = finiteNumber(value.from);
  if (from !== null) item.from = from;
  const until = finiteNumber(value.until);
  if (until !== null) item.until = until;
  if (typeof value.pinned === 'boolean') item.pinned = value.pinned;
  return item;
}

function recordOf<T>(value: unknown, sanitize: (id: string, item: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, item] of Object.entries(asObject(value))) {
    if (!usableKey(id)) continue;
    const clean = sanitize(id, item);
    if (clean) out[id] = clean;
  }
  return out;
}

/** Complete, sanitized AppStateData from any input (missing keys → defaults). */
export function withDefaults(input: unknown): AppStateData {
  const raw = asObject(input);
  const data = asObject(raw.data);
  return {
    version: 1,
    layout: layoutWithDefaults(raw.layout),
    widgetSettings: widgetSettingsWithDefaults(raw.widgetSettings),
    theme: themeWithDefaults(raw.theme),
    kiosk: kioskWithDefaults(raw.kiosk),
    lagra: lagraWithDefaults(raw.lagra),
    planbar: planbarWithDefaults(raw.planbar),
    data: {
      todos: recordOf(data.todos, sanitizeTodo),
      announcements: recordOf(data.announcements, sanitizeAnnouncement),
    },
  };
}
