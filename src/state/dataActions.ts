/**
 * Op builders for everything both kiosk and web UI edit. All writes go
 * through useAppState.apply (optimistic, then persisted by the backend).
 * Records are keyed by id and written per entry, so concurrent edits from
 * kiosk and web UI don't overwrite each other.
 */
import { uid } from '../utils/uid';
import { useAppState } from './appState';
import { bottomOf, DEFAULT_TODO_LIST, isHexColor, sanitizeWidgets } from './defaults';
import { jsonEqual } from './ops';
import type {
  Announcement,
  AppStateData,
  LayoutData,
  StateOp,
  ThemeMode,
  TodoItem,
  WidgetInstance,
} from './types';

const apply = (ops: StateOp[]): Promise<boolean> => useAppState.getState().apply(ops);
const current = (): AppStateData => useAppState.getState().state;

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/**
 * Splits a patch into one merge op (changed values) and delete ops (undefined values).
 * `create: false` for edits of an existing record: should another client have
 * deleted it meanwhile, the edit must not bring back a record holding only
 * the patched fields.
 */
function patchOps(
  path: (string | number)[],
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  create = true,
): StateOp[] {
  const merge: Record<string, unknown> = {};
  const ops: StateOp[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (existing[key] !== undefined) ops.push({ op: 'delete', path: [...path, key] });
    } else if (!jsonEqual(existing[key], value)) {
      merge[key] = value;
    }
  }
  if (Object.keys(merge).length > 0) {
    ops.unshift(create ? { op: 'merge', path, value: merge } : { op: 'merge', path, value: merge, create: false });
  }
  return ops;
}

const hasInstance = (instanceId: string): boolean =>
  current().layout.widgets.some((w) => w.instanceId === instanceId);

/** `undefined` means "remove" in patches – never for required fields. */
function withoutRequiredUndefined(patch: object, required: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => value !== undefined || !required.includes(key)),
  );
}

// ── Widget settings ──────────────────────────────────────────────────────────

export const widgetSettingsActions = {
  /**
   * Merges `patch` into the instance's settings. Unchanged values are not
   * sent, `undefined` removes a key and non-finite numbers (NaN from an
   * emptied number input) are ignored. Resolves false for an instance that
   * is no longer on the dashboard: a settings form flushing its draft while
   * the widget is being removed would otherwise leave orphaned settings
   * (possibly with a secret) behind.
   */
  update(instanceId: string, patch: Record<string, unknown>): Promise<boolean> {
    if (!hasInstance(instanceId)) return Promise.resolve(false);
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => typeof value !== 'number' || Number.isFinite(value)),
    );
    const stored = current().widgetSettings[instanceId];
    const ops = patchOps(['widgetSettings', instanceId], stored ?? {}, clean, stored === undefined);
    return ops.length > 0 ? apply(ops) : Promise.resolve(true);
  },

  replace(instanceId: string, settings: Record<string, unknown>): Promise<boolean> {
    return apply([{ op: 'set', path: ['widgetSettings', instanceId], value: settings }]);
  },

  remove(instanceId: string): Promise<boolean> {
    return apply([{ op: 'delete', path: ['widgetSettings', instanceId] }]);
  },
};

// ── Layout ───────────────────────────────────────────────────────────────────

/** Anything with react-grid-layout's item shape. */
export interface LayoutItemLike {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NewWidget = Omit<WidgetInstance, 'instanceId'> & { instanceId?: string };

function writeWidgets(next: WidgetInstance[]): Promise<boolean> {
  if (jsonEqual(current().layout.widgets, next)) return Promise.resolve(true);
  return apply([{ op: 'set', path: ['layout', 'widgets'], value: next }]);
}

export const layoutActions = {
  /**
   * Adds a widget; a non-finite y (e.g. Infinity) places it below all others.
   * Returns the instanceId.
   */
  add(widget: NewWidget): string {
    const { widgets, cols } = current().layout;
    const instanceId = widget.instanceId ?? `${widget.widgetId}-${uid()}`;
    if (widgets.some((w) => w.instanceId === instanceId)) return instanceId;
    const y = Number.isFinite(widget.y) && widget.y >= 0 ? widget.y : bottomOf(widgets);
    void writeWidgets(sanitizeWidgets([...widgets, { ...widget, instanceId, y }], cols));
    return instanceId;
  },

  /** Removes the widget and its settings (they may hold secrets). */
  remove(instanceId: string): Promise<boolean> {
    const state = current();
    const ops: StateOp[] = [];
    if (state.layout.widgets.some((w) => w.instanceId === instanceId)) {
      ops.push({
        op: 'set',
        path: ['layout', 'widgets'],
        value: state.layout.widgets.filter((w) => w.instanceId !== instanceId),
      });
    }
    if (state.widgetSettings[instanceId] !== undefined) {
      ops.push({ op: 'delete', path: ['widgetSettings', instanceId] });
    }
    return ops.length > 0 ? apply(ops) : Promise.resolve(true);
  },

  /** Takes positions/sizes from grid items; writes only if something changed. */
  update(items: readonly LayoutItemLike[]): Promise<boolean> {
    const { widgets, cols } = current().layout;
    const byId = new Map(items.map((item) => [item.i, item]));
    const next = widgets.map((w) => {
      const item = byId.get(w.instanceId);
      return item ? { ...w, x: item.x, y: item.y, w: item.w, h: item.h } : w;
    });
    return writeWidgets(sanitizeWidgets(next, cols));
  },

  /** Replaces the whole widget list (web UI layout editor). */
  setWidgets(widgets: readonly WidgetInstance[]): Promise<boolean> {
    return writeWidgets(sanitizeWidgets(widgets, current().layout.cols));
  },

  setGrid(patch: Partial<Pick<LayoutData, 'cols' | 'rowHeight' | 'fitRows'>>): Promise<boolean> {
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
    );
    const ops = patchOps(['layout'], { ...current().layout }, clean);
    return ops.length > 0 ? apply(ops) : Promise.resolve(true);
  },
};

// ── Theme ────────────────────────────────────────────────────────────────────

export const themeActions = {
  setMode(mode: ThemeMode): Promise<boolean> {
    if (current().theme.mode === mode) return Promise.resolve(true);
    return apply([{ op: 'set', path: ['theme', 'mode'], value: mode }]);
  },

  toggle(): Promise<boolean> {
    return themeActions.setMode(current().theme.mode === 'dark' ? 'light' : 'dark');
  },

  /** `null` = accent of the active theme. Only hex colours are accepted. */
  setAccent(color: string | null): Promise<boolean> {
    const accent = isHexColor(color) ? color : null;
    if (current().theme.accent === accent) return Promise.resolve(true);
    return apply([{ op: 'set', path: ['theme', 'accent'], value: accent }]);
  },
};

// ── Todos ────────────────────────────────────────────────────────────────────

export interface TodoOptions {
  list?: string;
  priority?: TodoItem['priority'];
  due?: string;
  assignee?: string;
}

export type TodoPatch = Partial<Omit<TodoItem, 'id' | 'createdAt' | 'doneAt'>>;

/** List a todo belongs to (missing = 'Allgemein'). */
export const todoListOf = (todo: Pick<TodoItem, 'list'>): string => todo.list ?? DEFAULT_TODO_LIST;

export const todoActions = {
  /** Returns the new id, or null for an empty text. */
  add(text: string, opts: TodoOptions = {}): string | null {
    const clean = text.trim();
    if (!clean) return null;
    const id = uid();
    const item: TodoItem = { id, text: clean, done: false, createdAt: Date.now() };
    const list = trimmed(opts.list);
    if (list && list !== DEFAULT_TODO_LIST) item.list = list;
    if (opts.priority) item.priority = opts.priority;
    const due = trimmed(opts.due);
    if (due) item.due = due;
    const assignee = trimmed(opts.assignee);
    if (assignee) item.assignee = assignee;
    void apply([{ op: 'set', path: ['data', 'todos', id], value: item }]);
    return id;
  },

  toggle(id: string): Promise<boolean> {
    const todo = current().data.todos[id];
    if (!todo) return Promise.resolve(false);
    return todoActions.update(id, { done: !todo.done });
  },

  /** `undefined` values remove optional fields; `done` maintains `doneAt`. */
  update(id: string, patch: TodoPatch): Promise<boolean> {
    const todo = current().data.todos[id];
    if (!todo) return Promise.resolve(false);
    const next = withoutRequiredUndefined(patch, ['text', 'done']);
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      if (!text) return Promise.resolve(false);
      next.text = text;
    }
    if (patch.done !== undefined && patch.done !== todo.done) next.doneAt = patch.done ? Date.now() : undefined;
    const ops = patchOps(['data', 'todos', id], { ...todo }, next, false);
    return ops.length > 0 ? apply(ops) : Promise.resolve(true);
  },

  remove(id: string): Promise<boolean> {
    return apply([{ op: 'delete', path: ['data', 'todos', id] }]);
  },

  /** Removes all done todos, optionally only those of one list. */
  clearDone(list?: string): Promise<boolean> {
    const ops: StateOp[] = Object.values(current().data.todos)
      .filter((todo) => todo.done && (list === undefined || todoListOf(todo) === list))
      .map((todo) => ({ op: 'delete', path: ['data', 'todos', todo.id] }));
    return ops.length > 0 ? apply(ops) : Promise.resolve(true);
  },
};

// ── Announcements (Pinnwand) ─────────────────────────────────────────────────

export type NewAnnouncement = Omit<Announcement, 'id' | 'createdAt' | 'level'> & {
  level?: Announcement['level'];
};

export type AnnouncementPatch = Partial<Omit<Announcement, 'id' | 'createdAt'>>;

export const announcementActions = {
  /** Returns the new id, or null for an empty title. */
  add(announcement: NewAnnouncement): string | null {
    const title = announcement.title.trim();
    if (!title) return null;
    const id = uid();
    const item: Announcement = { ...announcement, id, title, level: announcement.level ?? 'info', createdAt: Date.now() };
    for (const key of Object.keys(item) as (keyof Announcement)[]) {
      if (item[key] === undefined) delete item[key];
    }
    void apply([{ op: 'set', path: ['data', 'announcements', id], value: item }]);
    return id;
  },

  /** `undefined` values remove optional fields. */
  update(id: string, patch: AnnouncementPatch): Promise<boolean> {
    const existing = current().data.announcements[id];
    if (!existing) return Promise.resolve(false);
    const next = withoutRequiredUndefined(patch, ['title', 'level']);
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) return Promise.resolve(false);
      next.title = title;
    }
    const ops = patchOps(['data', 'announcements', id], { ...existing }, next, false);
    return ops.length > 0 ? apply(ops) : Promise.resolve(true);
  },

  remove(id: string): Promise<boolean> {
    return apply([{ op: 'delete', path: ['data', 'announcements', id] }]);
  },
};
