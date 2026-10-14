/**
 * Aufgaben tab: add tasks, filter by list, tick them off, edit and delete –
 * one card per list with «Erledigte entfernen». Writes go through
 * todoActions (optimistic); ticks made on the kiosk arrive live.
 */
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, CalendarDays, Check, ChevronDown, Flag, ListChecks, ListTodo, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useAppState } from '../../../state/appState';
import { todoActions, todoListOf } from '../../../state/dataActions';
import { DEFAULT_TODO_LIST } from '../../../state/defaults';
import type { TodoItem } from '../../../state/types';
import { plural } from '../../format';
import { useLocalChoice } from '../../hooks/useLocalChoice';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useNow } from '../../hooks/useNow';
import { Button, Card, ConfirmButton, ConfirmDialog, EmptyState, Field, toast, Toggle } from '../../ui';
import { TodoEditor } from './TodoEditor';
import { TodoFields } from './TodoFields';
import {
  dueInfo,
  emptyTodoDraft,
  PRIORITY_LABELS,
  sortTodos,
  TEXT_MAX,
  todoAssignees,
  todoLists,
  todoOptionsOf,
  type TodoDraft,
} from './todos';
import { WidgetMissingNotice } from './WidgetMissingNotice';

/** Due labels («heute fällig») switch over at midnight. */
const NOW_TICK_MS = 60_000;
const SHOW_DONE_KEY = 'slatedesk-remote:todos-show-done';
const SHOW_DONE_OPTIONS = ['an', 'aus'] as const;

// ── Add form ─────────────────────────────────────────────────────────────────

interface AddFormProps {
  lists: readonly string[];
  assignees: readonly string[];
  /** List of the current filter – used until another list is picked. */
  defaultList: string;
}

function detailSummary(draft: TodoDraft): string {
  const parts = [draft.list || DEFAULT_TODO_LIST];
  if (draft.priority !== 'normal') parts.push(`Priorität ${PRIORITY_LABELS[draft.priority].toLowerCase()}`);
  if (draft.assignee.trim()) parts.push(draft.assignee.trim());
  return parts.join(' · ');
}

function TodoAddForm({ lists, assignees, defaultList }: AddFormProps) {
  const idPrefix = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<TodoDraft>(() => emptyTodoDraft(defaultList));
  const [listPicked, setListPicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Remounts the detail fields after a task created a new list. */
  const [fieldsKey, setFieldsKey] = useState(0);
  const wide = useMediaQuery('(min-width: 720px)');
  const [detailsChoice, setDetailsChoice] = useState<boolean | null>(null);
  const detailsOpen = detailsChoice ?? wide;

  const effective: TodoDraft = listPicked ? draft : { ...draft, list: defaultList };

  const update = (patch: Partial<TodoDraft>) => {
    if (patch.list !== undefined) setListPicked(true);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = effective.text.trim();
    if (!text) {
      setError('Bitte eine Aufgabe eingeben');
      inputRef.current?.focus();
      return;
    }
    const options = todoOptionsOf(effective, lists);
    if (!todoActions.add(text, options)) return;
    toast.success(`Aufgabe zu «${options.list ?? DEFAULT_TODO_LIST}» hinzugefügt`);
    // List, priority and assignee stay for the next task.
    setDraft((current) => ({ ...current, text: '', due: '', list: listPicked ? (options.list ?? DEFAULT_TODO_LIST) : current.list }));
    setError(null);
    setFieldsKey((key) => key + 1);
    inputRef.current?.focus();
  };

  return (
    <Card title="Neue Aufgabe" icon={Plus}>
      <form className="r-settings r-form" onSubmit={submit} noValidate>
        <Field label="Aufgabe" htmlFor={`${idPrefix}-text`} error={error ?? undefined}>
          <input
            ref={inputRef}
            id={`${idPrefix}-text`}
            className="settings-input"
            value={draft.text}
            maxLength={TEXT_MAX}
            placeholder="z.B. Kaffeebohnen bestellen"
            autoComplete="off"
            enterKeyHint="done"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setError(null);
              update({ text: event.target.value });
            }}
          />
        </Field>

        <button
          type="button"
          className="rc-disclosure"
          aria-expanded={detailsOpen}
          aria-controls={`${idPrefix}-details`}
          onClick={() => setDetailsChoice(!detailsOpen)}
        >
          <ChevronDown className="rc-disclosure-icon" size={18} aria-hidden="true" />
          <span className="rc-disclosure-label">Weitere Angaben</span>
          {!detailsOpen && <span className="rc-disclosure-summary">{detailSummary(effective)}</span>}
        </button>
        <div id={`${idPrefix}-details`} hidden={!detailsOpen}>
          <TodoFields
            key={fieldsKey}
            idPrefix={idPrefix}
            draft={effective}
            lists={lists}
            assignees={assignees}
            onChange={update}
          />
        </div>

        <div className="r-form-actions">
          <Button type="submit" variant="primary" icon={Plus}>
            Hinzufügen
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────

interface RowProps {
  todo: TodoItem;
  now: number;
  onEdit: (id: string) => void;
  onDelete: (todo: TodoItem) => void;
}

function TodoRow({ todo, now, onEdit, onDelete }: RowProps) {
  const due = dueInfo(todo.due, todo.done, now);
  const hasMeta = due !== null || (todo.priority !== undefined && todo.priority !== 'normal') || todo.assignee !== undefined;
  return (
    <li className={`rc-todo${todo.done ? ' is-done' : ''}`}>
      <label className="rc-check">
        <input type="checkbox" checked={todo.done} onChange={() => void todoActions.toggle(todo.id)} />
        <span className="rc-check-box" aria-hidden="true">
          <Check size={16} strokeWidth={3} />
        </span>
        <span className="r-sr-only">{`«${todo.text}» erledigt`}</span>
      </label>
      <div className="rc-todo-main">
        <span className="rc-todo-text">{todo.text}</span>
        {hasMeta && (
          <span className="rc-todo-meta">
            {due && (
              <span className={`r-tag rc-due-${due.tone}`}>
                <CalendarDays size={14} aria-hidden="true" />
                {due.label}
              </span>
            )}
            {todo.priority === 'hoch' && (
              <span className="r-tag rc-prio-hoch">
                <Flag size={14} aria-hidden="true" />
                Priorität hoch
              </span>
            )}
            {todo.priority === 'niedrig' && (
              <span className="r-tag">
                <ArrowDown size={14} aria-hidden="true" />
                Priorität niedrig
              </span>
            )}
            {todo.assignee && (
              <span className="r-tag">
                <UserRound size={14} aria-hidden="true" />
                {todo.assignee}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="rc-todo-actions">
        <Button size="sm" variant="ghost" iconOnly icon={Pencil} onClick={() => onEdit(todo.id)}>
          {`«${todo.text}» bearbeiten`}
        </Button>
        <Button size="sm" variant="ghost" iconOnly icon={Trash2} className="rc-delete" onClick={() => onDelete(todo)}>
          {`«${todo.text}» löschen`}
        </Button>
      </div>
    </li>
  );
}

interface ListCardProps {
  list: string;
  items: readonly TodoItem[];
  showDone: boolean;
  now: number;
  onEdit: (id: string) => void;
  onDelete: (todo: TodoItem) => void;
}

function TodoListCard({ list, items, showDone, now, onEdit, onDelete }: ListCardProps) {
  const open = items.filter((todo) => !todo.done).length;
  const done = items.length - open;
  const visible = showDone ? items : items.filter((todo) => !todo.done);

  const clearDone = () =>
    todoActions.clearDone(list).then((ok) => {
      if (ok) toast.success(`${plural(done, 'erledigte Aufgabe', 'erledigte Aufgaben')} aus «${list}» entfernt`);
    });

  return (
    <Card
      className="rc-list-card"
      title={list}
      icon={ListTodo}
      subtitle={`${open} offen · ${done} erledigt`}
      actions={
        <ConfirmButton
          size="sm"
          variant="ghost"
          icon={ListChecks}
          className="r-btn-collapse"
          disabled={done === 0}
          aria-label={`Erledigte aus «${list}» entfernen`}
          confirmTitle="Erledigte entfernen?"
          confirmMessage={`${plural(done, 'erledigte Aufgabe', 'erledigte Aufgaben')} aus «${list}» ${done === 1 ? 'wird' : 'werden'} gelöscht.`}
          confirmLabel="Entfernen"
          onConfirm={clearDone}
        >
          Erledigte entfernen
        </ConfirmButton>
      }
    >
      {visible.length === 0 ? (
        <p className="rc-empty-line">{done > 0 ? 'Alles erledigt.' : 'Keine Aufgaben in dieser Liste.'}</p>
      ) : (
        <ul className="rc-todos">
          {visible.map((todo) => (
            <TodoRow key={todo.id} todo={todo} now={now} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </ul>
      )}
      {!showDone && done > 0 && visible.length > 0 && (
        <p className="r-hint">{`${plural(done, 'erledigte Aufgabe', 'erledigte Aufgaben')} ausgeblendet`}</p>
      )}
    </Card>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function TodosPanel() {
  const record = useAppState((s) => s.state.data.todos);
  const now = useNow(NOW_TICK_MS);
  const todos = useMemo(() => Object.values(record), [record]);
  const lists = useMemo(() => todoLists(todos), [todos]);
  const formLists = useMemo(() => todoLists(todos, [DEFAULT_TODO_LIST]), [todos]);
  const assignees = useMemo(() => todoAssignees(todos), [todos]);
  const byList = useMemo(() => {
    const map = new Map<string, TodoItem[]>();
    for (const todo of todos) {
      const list = todoListOf(todo);
      map.set(list, [...(map.get(list) ?? []), todo]);
    }
    for (const [list, items] of map) map.set(list, sortTodos(items));
    return map;
  }, [todos]);

  const [filter, setFilter] = useState<string | null>(null);
  // A filtered list whose last task was deleted (here or on the kiosk) falls back to «Alle».
  const activeFilter = filter !== null && lists.includes(filter) ? filter : null;
  const [showDoneChoice, setShowDoneChoice] = useLocalChoice(SHOW_DONE_KEY, SHOW_DONE_OPTIONS, 'an');
  const showDone = showDoneChoice === 'an';
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TodoItem | null>(null);

  const openCount = (list: string | null): number =>
    (list === null ? todos : (byList.get(list) ?? [])).filter((todo) => !todo.done).length;
  const shownLists = activeFilter !== null ? [activeFilter] : lists;

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    void todoActions.remove(target.id).then((ok) => {
      if (ok) toast.success(`«${target.text}» gelöscht`);
    });
  };

  return (
    <div className="rc-panel">
      <WidgetMissingNotice widgetId="todo" subject="Aufgaben" />

      <TodoAddForm lists={formLists} assignees={assignees} defaultList={activeFilter ?? DEFAULT_TODO_LIST} />

      {todos.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="Noch keine Aufgaben"
          description="Erfasste Aufgaben erscheinen im Widget «Aufgaben» und lassen sich dort auch abhaken."
        />
      ) : (
        <>
          <div className="rc-filters">
            {lists.length > 1 && (
              <div className="r-chipbar" role="group" aria-label="Nach Liste filtern">
                {[null, ...lists].map((list) => {
                  const active = list === activeFilter;
                  return (
                    <button
                      key={list ?? '\u0000alle'}
                      type="button"
                      className={`r-chip-btn${active ? ' is-active' : ''}`}
                      aria-pressed={active}
                      onClick={() => setFilter(list)}
                    >
                      <span>{list ?? 'Alle Listen'}</span>
                      <span className="r-chip-count" aria-hidden="true">
                        {openCount(list)}
                      </span>
                      <span className="r-sr-only">{`, ${openCount(list)} offen`}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="rc-filter-toggle">
              <Toggle checked={showDone} onChange={(on) => setShowDoneChoice(on ? 'an' : 'aus')} label="Erledigte anzeigen" />
            </div>
          </div>

          {shownLists.map((list) => (
            <TodoListCard
              key={list}
              list={list}
              items={byList.get(list) ?? []}
              showDone={showDone}
              now={now}
              onEdit={setEditId}
              onDelete={setDeleteTarget}
            />
          ))}
        </>
      )}

      <TodoEditor
        editId={editId}
        todo={editId !== null ? record[editId] : undefined}
        lists={formLists}
        assignees={assignees}
        onClose={() => setEditId(null)}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Aufgabe löschen?"
        message={deleteTarget ? `«${deleteTarget.text}» wird gelöscht.` : undefined}
        confirmLabel="Löschen"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
