/**
 * Sicherung: download the state (GET /api/export, secrets redacted) and
 * restore one (POST /api/import) after a preview of what it contains.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { DatabaseBackup, Download, Upload } from 'lucide-react';
import { useAppState } from '../../../state/appState';
import { downloadExport, importState, readBackupFile } from '../../api';
import { formatDateTime, plural } from '../../format';
import { Button, Card, ConfirmDialog, Notice, toast, toastResult } from '../../ui';
import { previewBackup, type BackupPreview } from './backup';

function PreviewContent({ preview }: { preview: BackupPreview }) {
  const rows: [string, string][] = [
    ['Kiosk', preview.kioskName],
    ['Widgets', `${preview.widgets} (${preview.configuredWidgets} mit eigenen Einstellungen)`],
    ['Pinnwand', plural(preview.announcements, 'Mitteilung', 'Mitteilungen')],
    ['Aufgaben', `${preview.todos} (${preview.openTodos} offen)`],
    ['Design', preview.darkMode ? 'Dunkel' : 'Hell'],
    ['lagra', preview.lagraEnabled ? 'eingeschaltet' : 'ausgeschaltet'],
    ['planbar', preview.planbarEnabled ? 'eingeschaltet' : 'ausgeschaltet'],
  ];
  return (
    <div className="rs-preview">
      <p className="r-confirm-message">
        «{preview.fileName}»{preview.exportedAt !== null ? `, erstellt am ${formatDateTime(preview.exportedAt)}` : ''}. Die
        Sicherung ersetzt den gesamten aktuellen Zustand des Kiosks.
      </p>
      <dl className="r-dl r-dl-compact">
        {rows.map(([label, value]) => (
          <div key={label} className="r-dl-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {preview.missing.length > 0 && (
        <Notice tone="warning" title="Unvollständige Sicherung">
          Nicht enthalten und deshalb auf Standardwerte zurückgesetzt: {preview.missing.join(', ')}.
        </Notice>
      )}
      {preview.redactedSecrets > 0 && (
        <Notice tone="info" title="Zugangsdaten">
          {plural(preview.redactedSecrets, 'Passwort oder Token ist', 'Passwörter oder Tokens sind')} nur als «gesetzt»
          gespeichert. Der Kiosk übernimmt dafür seine aktuell gespeicherten Werte – wo keiner vorhanden ist, muss der
          Zugang neu eingegeben werden.
        </Notice>
      )}
      {preview.ignored.length > 0 && <p className="r-hint">Unbekannte Einträge werden ignoriert: {preview.ignored.join(', ')}.</p>}
    </div>
  );
}

export function BackupCard() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<BackupPreview | null>(null);

  const exportNow = () => {
    setExporting(true);
    void toastResult(downloadExport(), 'Sicherung heruntergeladen').finally(() => setExporting(false));
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allows choosing the same file again.
    event.target.value = '';
    if (!file) return;
    setReading(true);
    readBackupFile(file).then(
      (backup) => {
        setReading(false);
        setPreview(previewBackup(file.name, backup));
      },
      (err: unknown) => {
        setReading(false);
        toast.error(err);
      },
    );
  };

  const confirmImport = () => {
    if (!preview) return;
    setImporting(true);
    importState(preview.state).then(
      () => {
        setImporting(false);
        setPreview(null);
        toast.success('Sicherung wiederhergestellt');
        // The event stream brings the new state as well; this makes it immediate.
        void useAppState.getState().reload();
      },
      (err: unknown) => {
        setImporting(false);
        toast.error(err);
      },
    );
  };

  return (
    <Card title="Sicherung" icon={DatabaseBackup} subtitle="Layout, Widget-Einstellungen, Inhalte und Kiosk-Einstellungen als Datei.">
      <div className="r-manage">
        <div className="r-manage-row">
          <div className="r-manage-text">
            <p className="r-manage-title">Sicherung herunterladen</p>
            <p className="r-manage-description">
              Passwörter und Tokens sind nicht enthalten, nur als «gesetzt» markiert.
            </p>
          </div>
          <Button icon={Download} busy={exporting} onClick={exportNow}>
            Herunterladen
          </Button>
        </div>
        <div className="r-manage-row">
          <div className="r-manage-text">
            <p className="r-manage-title">Sicherung wiederherstellen</p>
            <p className="r-manage-description">Ersetzt den gesamten Zustand – vorher wird der Inhalt der Datei angezeigt.</p>
          </div>
          <Button icon={Upload} busy={reading} onClick={() => fileInput.current?.click()}>
            Datei wählen
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="r-sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={onFile}
          />
        </div>
      </div>
      <ConfirmDialog
        open={preview !== null}
        title="Sicherung wiederherstellen?"
        message={preview ? <PreviewContent preview={preview} /> : undefined}
        confirmLabel="Wiederherstellen"
        busy={importing}
        onConfirm={confirmImport}
        onCancel={() => setPreview(null)}
      />
    </Card>
  );
}
