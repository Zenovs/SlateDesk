/**
 * Pinnwand tab: every entry grouped into aktiv / geplant / abgelaufen, with
 * create, edit, duplicate and delete. Writes go through announcementActions
 * (optimistic); entries changed on the kiosk arrive live over the event
 * stream.
 */
import { useMemo, useState } from 'react';
import { Copy, Megaphone, Pencil, Pin, Plus, Trash2 } from 'lucide-react';
import { useAppState } from '../../../state/appState';
import { announcementActions } from '../../../state/dataActions';
import type { Announcement, StateOp } from '../../../state/types';
import { plural } from '../../format';
import { useNow } from '../../hooks/useNow';
import { Button, ConfirmButton, ConfirmDialog, EmptyState, Section, toast } from '../../ui';
import { AnnouncementEditor, type AnnouncementEditorRequest } from './AnnouncementEditor';
import {
  draftOf,
  duplicateOf,
  groupAnnouncements,
  LEVELS,
  newDraft,
  pickValues,
  windowText,
  type AnnouncementField,
  type AnnouncementStatus,
  type AnnouncementValues,
} from './announcements';
import { WidgetMissingNotice } from './WidgetMissingNotice';

/** Entries move between aktiv / geplant / abgelaufen without a reload. */
const NOW_TICK_MS = 15_000;

const SECTIONS: readonly { status: AnnouncementStatus; title: string; description: string }[] = [
  { status: 'aktiv', title: 'Aktiv', description: 'Wird jetzt auf dem Kiosk angezeigt – angeheftete zuerst.' },
  { status: 'geplant', title: 'Geplant', description: 'Erscheint automatisch ab dem gewählten Zeitpunkt.' },
  { status: 'abgelaufen', title: 'Abgelaufen', description: 'Wird nicht mehr angezeigt.' },
];

interface EditorState extends AnnouncementEditorRequest {
  /** null while creating. */
  id: string | null;
}

interface ItemProps {
  item: Announcement;
  status: AnnouncementStatus;
  now: number;
  onEdit: (item: Announcement) => void;
  onDuplicate: (item: Announcement) => void;
  onDelete: (item: Announcement) => void;
}

function AnnouncementItem({ item, status, now, onEdit, onDuplicate, onDelete }: ItemProps) {
  const level = LEVELS[item.level];
  const LevelIcon = level.icon;
  const meta = [item.author, windowText(item, status, now)].filter(Boolean).join(' · ');
  return (
    <li className={`rc-ann rc-ann-${item.level} is-${status}`}>
      <div className="rc-ann-badges">
        <span className={`rc-level rc-level-${item.level}`}>
          <LevelIcon size={14} aria-hidden="true" />
          {level.label}
        </span>
        {item.pinned && (
          <span className="rc-pinned">
            <Pin size={14} aria-hidden="true" />
            Angeheftet
          </span>
        )}
      </div>
      <h3 className="rc-ann-title">{item.title}</h3>
      {item.text && <p className="rc-ann-text">{item.text}</p>}
      {meta && <p className="rc-ann-meta">{meta}</p>}
      <div className="rc-item-actions">
        <Button size="sm" variant="ghost" className="r-btn-collapse" icon={Pencil} onClick={() => onEdit(item)} aria-label={`«${item.title}» bearbeiten`}>
          Bearbeiten
        </Button>
        <Button size="sm" variant="ghost" className="r-btn-collapse" icon={Copy} onClick={() => onDuplicate(item)} aria-label={`«${item.title}» duplizieren`}>
          Duplizieren
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rc-delete r-btn-collapse"
          icon={Trash2}
          onClick={() => onDelete(item)}
          aria-label={`«${item.title}» löschen`}
        >
          Löschen
        </Button>
      </div>
    </li>
  );
}

export function AnnouncementsPanel() {
  const announcements = useAppState((s) => s.state.data.announcements);
  const now = useNow(NOW_TICK_MS);
  const groups = useMemo(() => groupAnnouncements(announcements, now), [announcements, now]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null);
  const total = Object.keys(announcements).length;
  const editedEntry = editor !== null && editor.id !== null ? announcements[editor.id] : undefined;
  const editedMissing = editor !== null && editor.id !== null && editedEntry === undefined;

  const openCreate = () => setEditor({ id: null, mode: 'create', draft: newDraft(Date.now()) });
  const openEdit = (item: Announcement) => setEditor({ id: item.id, mode: 'edit', draft: draftOf(item, Date.now()) });

  const save = async (values: AnnouncementValues, fields: readonly AnnouncementField[]): Promise<boolean> => {
    if (!editor) return false;
    if (editor.id === null) {
      if (!announcementActions.add(values)) return false;
      toast.success(values.from !== undefined && values.from > Date.now() ? 'Mitteilung geplant' : 'Mitteilung veröffentlicht');
      return true;
    }
    const id = editor.id;
    // Only the fields edited in the form – changes made elsewhere meanwhile stay.
    const ok = await announcementActions.update(id, pickValues(values, fields));
    if (ok) toast.success('Mitteilung gespeichert');
    else if (useAppState.getState().state.data.announcements[id] === undefined) {
      toast.error('Die Mitteilung wurde inzwischen gelöscht');
    }
    return ok;
  };

  const duplicate = (item: Announcement) => {
    const { values, reposted } = duplicateOf(item, Date.now());
    if (!announcementActions.add(values)) return;
    toast.success(
      reposted ? `«${item.title}» erneut veröffentlicht – ab sofort sichtbar, ohne Ende` : `«${item.title}» dupliziert`,
    );
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    void announcementActions.remove(target.id).then((ok) => {
      if (ok) toast.success(`«${target.title}» gelöscht`);
    });
  };

  const removeExpired = () => {
    const expired = groups.abgelaufen;
    const ops: StateOp[] = expired.map((item) => ({ op: 'delete', path: ['data', 'announcements', item.id] }));
    return useAppState
      .getState()
      .apply(ops)
      .then((ok) => {
        if (ok) toast.success(`${plural(expired.length, 'abgelaufene Mitteilung', 'abgelaufene Mitteilungen')} gelöscht`);
      });
  };

  const newButton = (
    <Button variant="primary" icon={Plus} onClick={openCreate}>
      Neue Mitteilung
    </Button>
  );

  return (
    <div className="rc-panel">
      <div className="rc-toolbar">
        <p className="r-hint">Mitteilungen für das Widget «Pinnwand» – mit Zeitraum, Art und Verfasser.</p>
        {total > 0 && newButton}
      </div>

      <WidgetMissingNotice widgetId="messages" subject="Mitteilungen" />

      {total === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Noch keine Mitteilungen"
          description="Mitteilungen erscheinen auf der Pinnwand des Kiosks – sofort oder ab einem gewählten Zeitpunkt."
          action={newButton}
        />
      ) : (
        SECTIONS.map(({ status, title, description }) => {
          const items = groups[status];
          if (items.length === 0 && status !== 'aktiv') return null;
          return (
            <Section
              key={status}
              title={`${title} (${items.length})`}
              description={description}
              actions={
                status === 'abgelaufen' ? (
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    icon={Trash2}
                    confirmTitle="Abgelaufene Mitteilungen löschen?"
                    confirmMessage={`${plural(items.length, 'abgelaufene Mitteilung wird', 'abgelaufene Mitteilungen werden')} endgültig gelöscht.`}
                    confirmLabel="Löschen"
                    onConfirm={removeExpired}
                  >
                    Alle löschen
                  </ConfirmButton>
                ) : undefined
              }
            >
              {items.length === 0 ? (
                <p className="rc-empty-line">Zurzeit wird keine Mitteilung angezeigt.</p>
              ) : (
                <ul className="rc-anns">
                  {items.map((item) => (
                    <AnnouncementItem
                      key={item.id}
                      item={item}
                      status={status}
                      now={now}
                      onEdit={openEdit}
                      onDuplicate={duplicate}
                      onDelete={setDeleteTarget}
                    />
                  ))}
                </ul>
              )}
            </Section>
          );
        })
      )}

      <AnnouncementEditor
        request={editor}
        current={editedEntry}
        missing={editedMissing}
        now={now}
        onSave={save}
        onClose={() => setEditor(null)}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Mitteilung löschen?"
        message={deleteTarget ? `«${deleteTarget.title}» wird von der Pinnwand entfernt.` : undefined}
        confirmLabel="Löschen"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
