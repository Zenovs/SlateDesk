/** Edit sheet of one task (text, details, done). */
import { useId, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { todoActions } from '../../../state/dataActions';
import { jsonEqual } from '../../../state/ops';
import type { TodoItem } from '../../../state/types';
import { Button, Field, Modal, Notice, toast, Toggle } from '../../ui';
import { TodoFields } from './TodoFields';
import { editedTodoPatch, emptyTodoDraft, TEXT_MAX, todoDraftOf, type TodoDraft } from './todos';

export interface TodoEditorProps {
  /** Task being edited (null = closed). */
  editId: string | null;
  /** Current version of the task; undefined once it was deleted elsewhere. */
  todo: TodoItem | undefined;
  lists: readonly string[];
  assignees: readonly string[];
  onClose: () => void;
}

interface DialogProps extends Omit<TodoEditorProps, 'editId'> {
  id: string;
}

function EditorDialog({ id, todo, lists, assignees, onClose }: DialogProps) {
  const formId = useId();
  /** The task as it was when the sheet opened (shown on if it is deleted meanwhile). */
  const [opened] = useState(todo);
  // Only what is typed here is kept and saved: fields nobody touched show the
  // task's current values (changes from the kiosk appear live), and live
  // changes never overwrite the typing.
  const [edited, setEdited] = useState<Partial<TodoDraft>>({});
  const [editedDone, setEditedDone] = useState<boolean | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const missing = todo === undefined;
  const current = todo ?? opened;
  const base = current ? todoDraftOf(current) : emptyTodoDraft('');
  const draft: TodoDraft = { ...base, ...edited };
  const done = editedDone ?? current?.done ?? false;
  // Not while saving: our own optimistic write changes the task as well.
  const changedElsewhere = !busy && !missing && opened !== undefined && !jsonEqual(todo, opened);
  const textError = draft.text.trim() ? undefined : 'Bitte eine Aufgabe eingeben';

  const update = (patch: Partial<TodoDraft>) => setEdited((previous) => ({ ...previous, ...patch }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (textError || missing || busy) return;
    setBusy(true);
    const patch = { ...editedTodoPatch(edited, base, lists), ...(editedDone !== null ? { done: editedDone } : {}) };
    void todoActions.update(id, patch).then((ok) => {
      if (ok) {
        toast.success('Aufgabe gespeichert');
        onClose();
      } else {
        setBusy(false);
      }
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Aufgabe bearbeiten"
      variant="sheet"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" form={formId} variant="primary" icon={Check} busy={busy} disabled={missing}>
            Speichern
          </Button>
        </>
      }
    >
      <form id={formId} className="r-settings r-form" onSubmit={submit} noValidate>
        {missing && (
          <Notice tone="error" title="Aufgabe gelöscht">
            Diese Aufgabe wurde inzwischen gelöscht – Änderungen lassen sich nicht mehr speichern.
          </Notice>
        )}
        {changedElsewhere && (
          <Notice tone="info" title="Inzwischen geändert">
            Diese Aufgabe wurde gerade anderswo geändert. Die Felder zeigen den neuen Stand – gespeichert wird nur, was hier
            bearbeitet wurde.
          </Notice>
        )}
        <Field label="Aufgabe" htmlFor={`${formId}-text`} error={submitted ? textError : undefined}>
          <input
            id={`${formId}-text`}
            className="settings-input"
            value={draft.text}
            maxLength={TEXT_MAX}
            autoComplete="off"
            aria-invalid={submitted && textError ? true : undefined}
            onChange={(event) => update({ text: event.target.value })}
          />
        </Field>
        <TodoFields idPrefix={formId} draft={draft} lists={lists} assignees={assignees} onChange={update} />
        <Toggle checked={done} onChange={setEditedDone} label="Erledigt" />
      </form>
    </Modal>
  );
}

/** Sheet to edit a task; only the fields edited in it are saved. */
export function TodoEditor({ editId, ...props }: TodoEditorProps) {
  return editId === null ? null : <EditorDialog key={editId} id={editId} {...props} />;
}
