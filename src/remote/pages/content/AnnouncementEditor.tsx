/**
 * Create/edit form of a Pinnwand entry (bottom sheet on phones): title,
 * text, kind, author, pinned and the visibility window.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { jsonEqual } from '../../../state/ops';
import type { Announcement, AnnouncementLevel } from '../../../state/types';
import { Button, Field, Modal, Notice, Segmented, Toggle, type SegmentedOption } from '../../ui';
import {
  AUTHOR_MAX,
  checkDraft,
  draftOf,
  editedFields,
  fromLocalInput,
  LEVEL_ORDER,
  LEVELS,
  TEXT_MAX,
  TITLE_MAX,
  untilDefault,
  type AnnouncementDraft,
  type AnnouncementField,
  type AnnouncementValues,
  type FromMode,
  type UntilMode,
} from './announcements';

const LEVEL_OPTIONS: readonly SegmentedOption<AnnouncementLevel>[] = LEVEL_ORDER.map((level) => ({
  value: level,
  label: LEVELS[level].label,
  icon: LEVELS[level].icon,
}));

const FROM_OPTIONS: readonly SegmentedOption<FromMode>[] = [
  { value: 'sofort', label: 'Sofort' },
  { value: 'zeitpunkt', label: 'Ab Zeitpunkt' },
];

const UNTIL_OPTIONS: readonly SegmentedOption<UntilMode>[] = [
  { value: 'ohne', label: 'Ohne Ende' },
  { value: 'zeitpunkt', label: 'Bis Zeitpunkt' },
];

export interface AnnouncementEditorRequest {
  mode: 'create' | 'edit';
  draft: AnnouncementDraft;
}

export interface AnnouncementEditorProps {
  /** null = closed. */
  request: AnnouncementEditorRequest | null;
  /** Current version of the edited entry (edit mode) – changes from elsewhere show in untouched fields. */
  current: Announcement | undefined;
  /** The edited entry was deleted in the meantime (on the kiosk or in another browser). */
  missing: boolean;
  now: number;
  /**
   * Resolves true when stored – the editor closes then. `edited`: the fields
   * changed in the form (when editing, only these are to be written).
   */
  onSave: (values: AnnouncementValues, edited: readonly AnnouncementField[]) => Promise<boolean>;
  onClose: () => void;
}

interface EditorDialogProps extends Omit<AnnouncementEditorProps, 'request'> {
  request: AnnouncementEditorRequest;
}

function EditorDialog({ request, current, missing, now, onSave, onClose }: EditorDialogProps) {
  const formId = useId();
  const creating = request.mode === 'create';
  /** The entry as it was when the editor opened, and when that was (fixed defaults for the time fields). */
  const [opened] = useState(() => ({ item: current, at: Date.now() }));
  // Only what is changed here is kept and saved: untouched fields show the
  // entry's current values (changes from elsewhere appear live), and live
  // changes never overwrite the typing.
  const [edited, setEdited] = useState<Partial<AnnouncementDraft>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = current ?? opened.item;
  const base = useMemo(
    () => (!creating && live ? draftOf(live, opened.at) : request.draft),
    [creating, live, opened.at, request.draft],
  );
  const draft: AnnouncementDraft = { ...base, ...edited };
  const check = checkDraft(draft, now);
  // Not while saving: our own optimistic write changes the entry as well.
  const changedElsewhere =
    !busy && !creating && current !== undefined && opened.item !== undefined && !jsonEqual(current, opened.item);

  const update = (patch: Partial<AnnouncementDraft>) => setEdited((previous) => ({ ...previous, ...patch }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!check.values || missing || busy) return;
    setBusy(true);
    void onSave(check.values, editedFields(edited)).then((ok) => {
      if (ok) onClose();
      else setBusy(false);
    });
  };

  const scheduled = draft.fromMode === 'zeitpunkt' && (fromLocalInput(draft.from) ?? 0) > now;
  const saveLabel = creating ? (scheduled ? 'Planen' : 'Veröffentlichen') : 'Speichern';

  return (
    <Modal
      open
      onClose={onClose}
      title={creating ? 'Neue Mitteilung' : 'Mitteilung bearbeiten'}
      description="Erscheint im Widget «Pinnwand» auf dem Kiosk."
      variant="sheet"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" form={formId} variant="primary" icon={Check} busy={busy} disabled={missing}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="r-settings r-form" onSubmit={submit} noValidate>
        {missing && (
          <Notice tone="error" title="Mitteilung gelöscht">
            Diese Mitteilung wurde inzwischen gelöscht – Änderungen lassen sich nicht mehr speichern.
          </Notice>
        )}
        {changedElsewhere && (
          <Notice tone="info" title="Inzwischen geändert">
            Diese Mitteilung wurde gerade anderswo geändert. Die Felder zeigen den neuen Stand – gespeichert wird nur, was
            hier bearbeitet wurde.
          </Notice>
        )}

        <Field label="Titel" htmlFor={`${formId}-title`} error={submitted ? check.errors.title : undefined}>
          <input
            id={`${formId}-title`}
            className="settings-input"
            value={draft.title}
            maxLength={TITLE_MAX}
            autoComplete="off"
            aria-invalid={submitted && check.errors.title ? true : undefined}
            data-autofocus={creating ? true : undefined}
            onChange={(event) => update({ title: event.target.value })}
          />
        </Field>

        <Field label="Text" hint="optional" htmlFor={`${formId}-text`}>
          <textarea
            id={`${formId}-text`}
            className="settings-input settings-textarea"
            rows={4}
            value={draft.text}
            maxLength={TEXT_MAX}
            onChange={(event) => update({ text: event.target.value })}
          />
        </Field>

        <Field label="Art">
          <Segmented
            label="Art der Mitteilung"
            value={draft.level}
            options={LEVEL_OPTIONS}
            onChange={(level) => update({ level })}
            block
          />
        </Field>

        <Field label="Verfasst von" hint="optional" htmlFor={`${formId}-author`}>
          <input
            id={`${formId}-author`}
            className="settings-input"
            value={draft.author}
            maxLength={AUTHOR_MAX}
            autoComplete="off"
            onChange={(event) => update({ author: event.target.value })}
          />
        </Field>

        <Toggle
          checked={draft.pinned}
          onChange={(pinned) => update({ pinned })}
          label="Anheften"
          description="Erscheint auf dem Kiosk vor allen anderen Mitteilungen."
        />

        <div className="r-form-grid">
          <Field label="Sichtbar ab" error={check.errors.from}>
            <Segmented
              label="Sichtbar ab"
              value={draft.fromMode}
              options={FROM_OPTIONS}
              onChange={(fromMode) => update({ fromMode, from: draft.from })}
              block
            />
            {draft.fromMode === 'zeitpunkt' && (
              <input
                type="datetime-local"
                className="settings-input"
                aria-label="Sichtbar ab – Datum und Uhrzeit"
                value={draft.from}
                onChange={(event) => update({ from: event.target.value })}
              />
            )}
          </Field>
          <Field label="Sichtbar bis" error={check.errors.until}>
            <Segmented
              label="Sichtbar bis"
              value={draft.untilMode}
              options={UNTIL_OPTIONS}
              onChange={(untilMode) =>
                update(untilMode === 'zeitpunkt' ? { untilMode, until: untilDefault(draft, Date.now()) } : { untilMode })
              }
              block
            />
            {draft.untilMode === 'zeitpunkt' && (
              <input
                type="datetime-local"
                className="settings-input"
                aria-label="Sichtbar bis – Datum und Uhrzeit"
                value={draft.until}
                onChange={(event) => update({ until: event.target.value })}
              />
            )}
          </Field>
        </div>

        {check.expired && (
          <Notice tone="warning">Das Ende liegt in der Vergangenheit – die Mitteilung wird auf dem Kiosk nicht angezeigt.</Notice>
        )}
      </form>
    </Modal>
  );
}

/** Editor sheet for a Pinnwand entry; its form state resets on every opening, only edited fields are saved. */
export function AnnouncementEditor({ request, ...props }: AnnouncementEditorProps) {
  return request ? <EditorDialog request={request} {...props} /> : null;
}
