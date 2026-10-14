/**
 * Aufgaben (state.data.todos) for the web UI: lists, order, due-date texts
 * and the form draft. Lists exist only through their tasks (todo.list,
 * missing = «Allgemein»).
 */
import { todoListOf, type TodoOptions, type TodoPatch } from '../../../state/dataActions';
import { DEFAULT_TODO_LIST } from '../../../state/defaults';
import type { TodoItem, TodoPriority } from '../../../state/types';
import { dayOffset, formatDay } from '../../format';
import type { SegmentedOption } from '../../ui';

export const TEXT_MAX = 200;
export const LIST_MAX = 40;
export const ASSIGNEE_MAX = 40;

export const PRIORITY_LABELS: Record<TodoPriority, string> = { niedrig: 'Niedrig', normal: 'Normal', hoch: 'Hoch' };

export const PRIORITY_OPTIONS: readonly SegmentedOption<TodoPriority>[] = [
  { value: 'niedrig', label: PRIORITY_LABELS.niedrig },
  { value: 'normal', label: PRIORITY_LABELS.normal },
  { value: 'hoch', label: PRIORITY_LABELS.hoch },
];

const PRIORITY_RANK: Record<TodoPriority, number> = { hoch: 0, normal: 1, niedrig: 2 };

const collator = new Intl.Collator('de-CH', { sensitivity: 'base', numeric: true });

/** «Allgemein» first, then alphabetical. */
const compareLists = (a: string, b: string): number =>
  a === DEFAULT_TODO_LIST ? -1 : b === DEFAULT_TODO_LIST ? 1 : collator.compare(a, b) || a.localeCompare(b);

/** Names of all lists that have tasks, plus `extra` (e.g. the default list for the form). */
export function todoLists(todos: readonly TodoItem[], extra: readonly string[] = []): string[] {
  return [...new Set([...todos.map(todoListOf), ...extra])].sort(compareLists);
}

/** Assignees used so far (suggestions for the input). */
export function todoAssignees(todos: readonly TodoItem[]): string[] {
  return [...new Set(todos.flatMap((todo) => (todo.assignee ? [todo.assignee] : [])))].sort(collator.compare);
}

/** A typed list name in the spelling of an existing list («einkauf» → «Einkauf»); empty = «Allgemein». */
function normalizeListName(name: string, lists: readonly string[]): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return DEFAULT_TODO_LIST;
  return lists.find((list) => collator.compare(list, clean) === 0) ?? clean;
}

const dueRank = (todo: TodoItem): string => todo.due ?? '9999-99-99';

/**
 * Open tasks first – by due date (none last), priority, age; done tasks
 * after them, most recently done first. Same order as the kiosk widget.
 */
export function sortTodos(todos: readonly TodoItem[]): TodoItem[] {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.doneAt ?? 0) - (a.doneAt ?? 0) || b.createdAt - a.createdAt;
    return (
      dueRank(a).localeCompare(dueRank(b)) ||
      PRIORITY_RANK[a.priority ?? 'normal'] - PRIORITY_RANK[b.priority ?? 'normal'] ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id)
    );
  });
}

export type DueTone = 'overdue' | 'today' | 'later';

/** «heute fällig», «überfällig (Mo 6.10.)», «fällig Mi 15.10.»; null without (valid) due date. */
export function dueInfo(due: string | undefined, done: boolean, now: number): { label: string; tone: DueTone } | null {
  const match = due ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(due) : null;
  if (!match) return null;
  const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  const offset = dayOffset(ms, now);
  const day = formatDay(ms, now);
  if (done) return { label: `fällig ${day}`, tone: 'later' };
  if (offset < 0) return { label: `überfällig (${day})`, tone: 'overdue' };
  if (offset === 0) return { label: 'heute fällig', tone: 'today' };
  return { label: `fällig ${day}`, tone: 'later' };
}

// ── Form draft ───────────────────────────────────────────────────────────────

export interface TodoDraft {
  text: string;
  list: string;
  /** YYYY-MM-DD or ''. */
  due: string;
  priority: TodoPriority;
  assignee: string;
}

export const emptyTodoDraft = (list: string): TodoDraft => ({
  text: '',
  list,
  due: '',
  priority: 'normal',
  assignee: '',
});

export const todoDraftOf = (todo: TodoItem): TodoDraft => ({
  text: todo.text,
  list: todoListOf(todo),
  due: todo.due ?? '',
  priority: todo.priority ?? 'normal',
  assignee: todo.assignee ?? '',
});

/** Options for todoActions.add (normal priority and «Allgemein» are not stored). */
export function todoOptionsOf(draft: TodoDraft, lists: readonly string[]): TodoOptions {
  return {
    list: normalizeListName(draft.list, lists),
    priority: draft.priority === 'normal' ? undefined : draft.priority,
    due: draft.due || undefined,
    assignee: draft.assignee.trim() || undefined,
  };
}

/** Patch for todoActions.update – cleared fields are removed. */
export function todoPatchOf(draft: TodoDraft, lists: readonly string[]): TodoPatch {
  const list = normalizeListName(draft.list, lists);
  return {
    text: draft.text,
    list: list === DEFAULT_TODO_LIST ? undefined : list,
    priority: draft.priority === 'normal' ? undefined : draft.priority,
    due: draft.due || undefined,
    assignee: draft.assignee.trim() || undefined,
  };
}

/**
 * Patch with only the fields edited in the form (`edited`, on top of the
 * task's current values `base`): a field changed elsewhere while the form
 * was open – e.g. ticked off on the kiosk – is not written back.
 */
export function editedTodoPatch(edited: Partial<TodoDraft>, base: TodoDraft, lists: readonly string[]): TodoPatch {
  const patch = todoPatchOf({ ...base, ...edited }, lists);
  return Object.fromEntries(
    (Object.keys(edited) as (keyof TodoDraft)[]).map((key) => [key, patch[key]]),
  ) as TodoPatch;
}
