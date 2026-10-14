/** Details of a task (list, due date, priority, assignee) – shared by the add form and the editor. */
import { useState } from 'react';
import { X } from 'lucide-react';
import { DEFAULT_TODO_LIST } from '../../../state/defaults';
import { Field, Segmented } from '../../ui';
import { ASSIGNEE_MAX, LIST_MAX, PRIORITY_OPTIONS, type TodoDraft } from './todos';

/** Option value that can never be a list name. */
const NEW_LIST = '\u0000neue-liste';

export interface TodoFieldsProps {
  /** Prefix for input ids (useId()). */
  idPrefix: string;
  draft: TodoDraft;
  /** Existing lists, «Allgemein» included. */
  lists: readonly string[];
  /** Suggestions for «Zuständig». */
  assignees: readonly string[];
  onChange: (patch: Partial<TodoDraft>) => void;
}

/**
 * Remount (key) after the list set changed from outside, e.g. after a task
 * created a new list – the list field then shows it in the selection.
 */
export function TodoFields({ idPrefix, draft, lists, assignees, onChange }: TodoFieldsProps) {
  const options = lists.includes(DEFAULT_TODO_LIST) ? lists : [DEFAULT_TODO_LIST, ...lists];
  // A list name that is not (yet) in the selection is being typed.
  const [creating, setCreating] = useState(() => !options.includes(draft.list));

  return (
    <div className="r-form-grid">
      <Field
        label="Liste"
        htmlFor={`${idPrefix}-list`}
        description={creating ? 'Neue Liste – sie entsteht mit dieser Aufgabe.' : undefined}
      >
        {creating ? (
          <div className="settings-input-row">
            <input
              id={`${idPrefix}-list`}
              className="settings-input"
              value={draft.list}
              maxLength={LIST_MAX}
              placeholder="Name der neuen Liste"
              autoComplete="off"
              onChange={(event) => onChange({ list: event.target.value })}
            />
            <button
              type="button"
              className="settings-icon-btn"
              title="Bestehende Liste wählen"
              aria-label="Bestehende Liste wählen"
              onClick={() => {
                setCreating(false);
                onChange({ list: options[0] });
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <select
            id={`${idPrefix}-list`}
            className="settings-select"
            value={draft.list}
            onChange={(event) => {
              if (event.target.value === NEW_LIST) {
                setCreating(true);
                onChange({ list: '' });
              } else {
                onChange({ list: event.target.value });
              }
            }}
          >
            {options.map((list) => (
              <option key={list} value={list}>
                {list}
              </option>
            ))}
            <option value={NEW_LIST}>Neue Liste …</option>
          </select>
        )}
      </Field>

      <Field label="Fällig am" hint="optional" htmlFor={`${idPrefix}-due`}>
        <div className="settings-input-row">
          <input
            id={`${idPrefix}-due`}
            className="settings-input"
            type="date"
            value={draft.due}
            onChange={(event) => onChange({ due: event.target.value })}
          />
          {draft.due && (
            <button
              type="button"
              className="settings-icon-btn"
              title="Fälligkeit entfernen"
              aria-label="Fälligkeit entfernen"
              onClick={() => onChange({ due: '' })}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </Field>

      <Field label="Priorität">
        <Segmented
          label="Priorität"
          value={draft.priority}
          options={PRIORITY_OPTIONS}
          onChange={(priority) => onChange({ priority })}
          block
        />
      </Field>

      <Field label="Zuständig" hint="optional" htmlFor={`${idPrefix}-assignee`}>
        <input
          id={`${idPrefix}-assignee`}
          className="settings-input"
          value={draft.assignee}
          maxLength={ASSIGNEE_MAX}
          autoComplete="off"
          list={assignees.length > 0 ? `${idPrefix}-assignees` : undefined}
          onChange={(event) => onChange({ assignee: event.target.value })}
        />
        {assignees.length > 0 && (
          <datalist id={`${idPrefix}-assignees`}>
            {assignees.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
      </Field>
    </div>
  );
}
