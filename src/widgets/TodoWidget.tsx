/**
 * Aufgaben (id 'todo') – gemeinsame Aufgabenlisten aus `state.data.todos`.
 *
 * Die Fälligkeitsgruppen werden aus dem Datum relativ zu heute berechnet und
 * rollen deshalb von selbst weiter. Änderungen aus der Fernsteuerung kommen
 * über den State live an; am Kiosk kann man je nach Einstellung abhaken und
 * neue Aufgaben erfassen.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Flag, ListTodo, PartyPopper, Plus, User } from 'lucide-react';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { useAppState } from '../state/appState';
import { todoActions, todoListOf, widgetSettingsActions } from '../state/dataActions';
import { DEFAULT_TODO_LIST } from '../state/defaults';
import type { TodoItem, TodoPriority } from '../state/types';
import type { WidgetProps } from '../types/widget';
import { TODO_HIDE_DONE_MAX_HOURS, todoDefaultSettings, type TodoSettings } from './manifests/todo';
import './styles/todo.css';

/** Due groups and "erledigt" timeouts are re-evaluated this often. */
const NOW_TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Toggle feedback: the item stays where it was this long, then moves or leaves. */
const SETTLE_MS = 1_100;
const LEAVE_MS = 320;
const MAX_TEXT_LENGTH = 300;

type DueGroup = 'ueberfaellig' | 'heute' | 'morgen' | 'woche' | 'spaeter' | 'ohne' | 'erledigt';

const GROUP_ORDER: readonly DueGroup[] = ['ueberfaellig', 'heute', 'morgen', 'woche', 'spaeter', 'ohne', 'erledigt'];

const GROUP_LABELS: Record<DueGroup, string> = {
  ueberfaellig: 'Überfällig',
  heute: 'Heute',
  morgen: 'Morgen',
  woche: 'Diese Woche',
  spaeter: 'Später',
  ohne: 'Ohne Datum',
  erledigt: 'Erledigt',
};

const PRIORITY_RANK: Record<TodoPriority, number> = { hoch: 0, normal: 1, niedrig: 2 };
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

const LEGACY_SORT_VALUES: readonly unknown[] = ['category', 'name', 'status'];

// ── Settings ─────────────────────────────────────────────────────────────────

const boolOr = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** Stored settings are not trusted (old versions, hand-edited state). */
function sanitizeSettings(settings: TodoSettings): TodoSettings {
  const defaults = todoDefaultSettings;
  const hours = settings.hideDoneAfterHours;
  return {
    list: typeof settings.list === 'string' ? settings.list.trim() : '',
    show: settings.show === 'alle' ? 'alle' : 'offen',
    hideDoneAfterHours:
      typeof hours === 'number' && Number.isFinite(hours)
        ? Math.min(TODO_HIDE_DONE_MAX_HOURS, Math.max(0, hours))
        : defaults.hideDoneAfterHours,
    sortBy: settings.sortBy === 'prioritaet' || settings.sortBy === 'erstellt' ? settings.sortBy : 'faelligkeit',
    groupByDue: boolOr(settings.groupByDue, defaults.groupByDue),
    allowToggle: boolOr(settings.allowToggle, defaults.allowToggle),
    allowAdd: boolOr(settings.allowAdd, defaults.allowAdd),
    showAssignee: boolOr(settings.showAssignee, defaults.showAssignee),
    showListName: boolOr(settings.showListName, defaults.showListName),
  };
}

/**
 * Settings of widget version 2 (sortBy category/name/status, filter, source)
 * → patch to the current keys, or null when there is nothing to migrate.
 */
function legacySettingsPatch(stored: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!stored) return null;
  const legacySort = LEGACY_SORT_VALUES.includes(stored.sortBy);
  if (!legacySort && !('filter' in stored) && !('source' in stored)) return null;
  const patch: Record<string, unknown> = { filter: undefined, source: undefined };
  if (legacySort) {
    patch.sortBy = 'faelligkeit';
    if (stored.groupByDue === undefined) patch.groupByDue = stored.sortBy === 'category';
  }
  if (stored.show === undefined && (stored.filter === 'all' || stored.filter === 'done')) patch.show = 'alle';
  return patch;
}

// ── Dates ────────────────────────────────────────────────────────────────────

interface DayInfo {
  /** Days since 1970-01-01 (calendar days, no DST effects). */
  epochDay: number;
  /** 0 = Sonntag. */
  weekday: number;
  day: number;
  month: number;
  year: number;
}

const toDayInfo = (year: number, month: number, day: number): DayInfo => {
  const utc = Date.UTC(year, month - 1, day);
  return { epochDay: Math.round(utc / DAY_MS), weekday: new Date(utc).getUTCDay(), day, month, year };
};

function todayInfo(now: number): DayInfo {
  const date = new Date(now);
  return toDayInfo(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** 'YYYY-MM-DD' → DayInfo; null for impossible dates such as 2026-02-31. */
function parseDue(due: string | undefined): DayInfo | null {
  if (!due) return null;
  const [year, month, day] = due.split('-').map(Number);
  if (!year || !month || !day) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return toDayInfo(year, month, day);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function dueLabel(due: DayInfo, today: DayInfo): string {
  const diff = due.epochDay - today.epochDay;
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === -1) return 'Gestern';
  const year = due.year === today.year ? '' : String(due.year).slice(-2);
  return `${WEEKDAYS[due.weekday]} ${pad2(due.day)}.${pad2(due.month)}.${year}`;
}

function dueGroup(due: DayInfo | null, today: DayInfo): DueGroup {
  if (!due) return 'ohne';
  const diff = due.epochDay - today.epochDay;
  if (diff < 0) return 'ueberfaellig';
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  // Week = Monday to Sunday.
  const daysToSunday = (7 - today.weekday) % 7;
  return diff <= daysToSunday ? 'woche' : 'spaeter';
}

/** Current time for due groups and done timeouts, refreshed every minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** Kiosk tap feedback: `wasDone` keeps the item at its old place until it settled. */
interface Feedback {
  wasDone: boolean;
  phase: 'settle' | 'leave';
}

interface Row {
  todo: TodoItem;
  due: DayInfo | null;
  group: DueGroup;
  /** Done state used for ordering (the old one while settling). */
  sortDone: boolean;
  overdue: boolean;
  feedback: Feedback | undefined;
}

const listKey = (name: string): string => name.toLocaleLowerCase('de-CH');

const priorityRank = (todo: TodoItem): number => PRIORITY_RANK[todo.priority ?? 'normal'];

function compareDue(a: Row, b: Row): number {
  if (a.due && b.due) return a.due.epochDay - b.due.epochDay;
  return a.due ? -1 : b.due ? 1 : 0;
}

function compareRows(a: Row, b: Row, sortBy: TodoSettings['sortBy']): number {
  if (a.sortDone !== b.sortDone) return a.sortDone ? 1 : -1;
  if (a.sortDone) {
    // Most recently done first.
    const byDone = (b.todo.doneAt ?? b.todo.createdAt) - (a.todo.doneAt ?? a.todo.createdAt);
    if (byDone !== 0) return byDone;
  }
  // Equal rank: the older task first.
  const tie = a.todo.createdAt - b.todo.createdAt || a.todo.id.localeCompare(b.todo.id);
  switch (sortBy) {
    case 'erstellt':
      return b.todo.createdAt - a.todo.createdAt || a.todo.id.localeCompare(b.todo.id);
    case 'prioritaet':
      return priorityRank(a.todo) - priorityRank(b.todo) || compareDue(a, b) || tie;
    case 'faelligkeit':
      return compareDue(a, b) || priorityRank(a.todo) - priorityRank(b.todo) || tie;
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Existing spelling of a list name (case-insensitive), undefined for the default list. */
function canonicalListName(todos: Record<string, TodoItem>, wanted: string): string | undefined {
  if (!wanted || listKey(wanted) === listKey(DEFAULT_TODO_LIST)) return undefined;
  const key = listKey(wanted);
  for (const todo of Object.values(todos)) {
    const name = todoListOf(todo);
    if (listKey(name) === key) return name;
  }
  return wanted;
}

interface RowViewProps {
  row: Row;
  settings: TodoSettings;
  today: DayInfo;
  showDue: boolean;
  onToggle: (todo: TodoItem) => void;
}

function TodoRow({ row, settings, today, showDue, onToggle }: RowViewProps) {
  const { todo, due, overdue, feedback } = row;
  const classes = ['todo-row'];
  if (todo.done) classes.push('todo-row--done');
  if (overdue) classes.push('todo-row--overdue');
  if (todo.priority === 'hoch') classes.push('todo-row--high');
  if (todo.priority === 'niedrig') classes.push('todo-row--low');
  if (feedback) classes.push(todo.done ? 'todo-row--checked' : 'todo-row--reopened');
  if (feedback?.phase === 'leave' && feedback.wasDone !== todo.done) classes.push('todo-row--leaving');

  const showList = settings.showListName && !settings.list;
  const content = (
    <>
      <span className="todo-check" aria-hidden="true">
        <Check />
      </span>
      <span className="todo-text">{todo.text}</span>
      <span className="todo-tags">
        {todo.priority === 'hoch' && (
          <span className="todo-priority" role="img" aria-label="Hohe Priorität" title="Hohe Priorität">
            <Flag aria-hidden="true" />
          </span>
        )}
        {showDue && due && <span className="todo-due">{dueLabel(due, today)}</span>}
        {settings.showAssignee && todo.assignee && (
          <span className="todo-chip">
            <User aria-hidden="true" />
            {todo.assignee}
          </span>
        )}
        {showList && <span className="todo-chip todo-chip--list">{todoListOf(todo)}</span>}
      </span>
    </>
  );

  return (
    <li className={classes.join(' ')}>
      {settings.allowToggle ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={todo.done}
          className="todo-row-main todo-row-main--toggle"
          onClick={() => onToggle(todo)}
        >
          {content}
        </button>
      ) : (
        <div className="todo-row-main">{content}</div>
      )}
    </li>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function TodoWidget({ instanceId }: WidgetProps) {
  const [storedSettings] = useWidgetSettings(instanceId, todoDefaultSettings);
  const settings = useMemo(() => sanitizeSettings(storedSettings), [storedSettings]);
  const rawSettings = useAppState((s) => s.state.widgetSettings[instanceId]);
  const todos = useAppState((s) => s.state.data.todos);
  const now = useNow();
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [draft, setDraft] = useState('');
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>[]>());

  useEffect(() => {
    const patch = legacySettingsPatch(rawSettings);
    if (patch) void widgetSettingsActions.update(instanceId, patch);
  }, [instanceId, rawSettings]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const list of pending.values()) list.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const today = useMemo(() => todayInfo(now), [now]);
  /** The configured list as it is spelled in the data ('' = alle Listen). */
  const listName = useMemo(
    () => (settings.list ? (canonicalListName(todos, settings.list) ?? DEFAULT_TODO_LIST) : ''),
    [todos, settings.list],
  );

  const { rows, inListCount } = useMemo(() => {
    const wanted = settings.list ? listKey(settings.list) : null;
    const hideAfterMs = settings.show === 'alle' ? settings.hideDoneAfterHours * HOUR_MS : 0;
    const result: Row[] = [];
    let count = 0;
    for (const todo of Object.values(todos)) {
      if (wanted !== null && listKey(todoListOf(todo)) !== wanted) continue;
      count++;
      const fb = feedback[todo.id];
      const doneVisible = hideAfterMs > 0 && now - (todo.doneAt ?? todo.createdAt) < hideAfterMs;
      if (todo.done && !doneVisible && !fb) continue;
      const due = parseDue(todo.due);
      const sortDone = fb ? fb.wasDone : todo.done;
      result.push({
        todo,
        due,
        group: sortDone ? 'erledigt' : dueGroup(due, today),
        sortDone,
        overdue: !todo.done && due !== null && due.epochDay < today.epochDay,
        feedback: fb,
      });
    }
    result.sort((a, b) => compareRows(a, b, settings.sortBy));
    return { rows: result, inListCount: count };
  }, [todos, feedback, now, today, settings.list, settings.show, settings.hideDoneAfterHours, settings.sortBy]);

  const toggle = (todo: TodoItem) => {
    const { id } = todo;
    void todoActions.toggle(id);
    timers.current.get(id)?.forEach(clearTimeout);
    setFeedback((prev) => ({ ...prev, [id]: { wasDone: prev[id]?.wasDone ?? todo.done, phase: 'settle' } }));
    timers.current.set(id, [
      setTimeout(() => {
        setFeedback((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], phase: 'leave' } } : prev));
      }, SETTLE_MS),
      setTimeout(() => {
        timers.current.delete(id);
        setFeedback((prev) => withoutKey(prev, id));
      }, SETTLE_MS + LEAVE_MS),
    ]);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (todoActions.add(text.slice(0, MAX_TEXT_LENGTH), { list: listName || undefined }) !== null) {
      setDraft('');
    }
  };

  const openCount = rows.filter((row) => !row.todo.done).length;
  const header =
    listName && settings.showListName ? (
      <div className="todo-header">
        <ListTodo aria-hidden="true" />
        <span className="todo-header-name">{listName}</span>
        <span className="todo-header-count">{openCount} offen</span>
      </div>
    ) : null;

  let body: ReactNode;
  if (rows.length === 0) {
    const nothingYet = inListCount === 0;
    const where = listName ? ` in «${listName}»` : '';
    body = (
      <div className="todo-empty">
        {nothingYet ? (
          <ListTodo className="todo-empty-icon" aria-hidden="true" />
        ) : (
          <PartyPopper className="todo-empty-icon" aria-hidden="true" />
        )}
        <div className="todo-empty-title">{nothingYet ? `Keine Aufgaben${where}` : 'Alles erledigt'}</div>
        {nothingYet && (
          <div className="todo-empty-hint">
            {settings.allowAdd
              ? 'Neue Aufgaben unten eingeben oder in der Fernsteuerung erfassen (Inhalte → Aufgaben).'
              : 'Aufgaben erfassen Sie in der Fernsteuerung (Inhalte → Aufgaben).'}
          </div>
        )}
      </div>
    );
  } else if (settings.groupByDue) {
    body = GROUP_ORDER.map((group) => {
      const groupRows = rows.filter((row) => row.group === group);
      if (groupRows.length === 0) return null;
      const showDue = group !== 'heute' && group !== 'morgen';
      return (
        <section key={group} className={`todo-group todo-group--${group}`}>
          <h3 className="todo-group-title">
            <span>{GROUP_LABELS[group]}</span>
            <span className="todo-group-count">{groupRows.length}</span>
          </h3>
          <ul className="todo-list">
            {groupRows.map((row) => (
              <TodoRow
                key={row.todo.id}
                row={row}
                settings={settings}
                today={today}
                showDue={showDue}
                onToggle={toggle}
              />
            ))}
          </ul>
        </section>
      );
    });
  } else {
    body = (
      <ul className="todo-list">
        {rows.map((row) => (
          <TodoRow key={row.todo.id} row={row} settings={settings} today={today} showDue onToggle={toggle} />
        ))}
      </ul>
    );
  }

  return (
    <div className="todo">
      {header}
      <div className="todo-scroll">{body}</div>
      {settings.allowAdd && (
        <form className="todo-add no-drag" onSubmit={submit}>
          <input
            className="todo-add-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={listName ? `Neue Aufgabe in «${listName}»` : 'Neue Aufgabe'}
            maxLength={MAX_TEXT_LENGTH}
            enterKeyHint="done"
            aria-label="Neue Aufgabe"
          />
          <button type="submit" className="todo-add-button" disabled={!draft.trim()} aria-label="Aufgabe hinzufügen">
            <Plus aria-hidden="true" />
          </button>
        </form>
      )}
    </div>
  );
}
