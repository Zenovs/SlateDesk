/**
 * Update: check for a new version (POST /api/actions/update-check), install
 * it (update-run) and follow its progress (GET /api/update/progress every
 * 3 s until it is done). An update already running when the page opens is
 * followed as well. The app restarts at the end, which ends this session.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { actions, errorText, updateProgress, type SystemInfo, type UpdateCheck, type UpdateProgress } from '../../api';
import { plural } from '../../format';
import { usePoll } from '../../hooks/usePoll';
import { Button, Card, ConfirmButton, LoadingRow, Notice, ProgressBar, Spinner, toast } from '../../ui';
import { observeRun, runOutcome, watchTriggeredRun, type RunOutcome, type RunWatch } from './updateRun';

const PROGRESS_POLL_MS = 3_000;

/** Steps written by scripts/auto-update.sh into update-status.json. */
const PHASE_LABELS: Record<string, string> = {
  start: 'Wird gestartet',
  network: 'Netzwerk prüfen',
  fetch: 'Neue Version laden',
  checkout: 'Quellcode aktualisieren',
  deps: 'Abhängigkeiten installieren',
  build: 'App bauen',
  install: 'Installieren',
  restart: 'Neustart',
  health: 'Funktionsprüfung',
  rollback: 'Zurück zur vorherigen Version',
  done: 'Fertig',
  uptodate: 'Bereits aktuell',
  skipped: 'Übersprungen',
  error: 'Fehler',
};

const phaseLabel = (phase: string | null | undefined): string =>
  (phase && PHASE_LABELS[phase]) || 'Update läuft';

const isFailed = (progress: UpdateProgress): boolean =>
  progress.error === true || (typeof progress.error === 'string' && progress.error.trim() !== '');

interface CheckState {
  busy: boolean;
  result: UpdateCheck | null;
  error: string | null;
}

function RunningView({ progress, connectionLost }: { progress: UpdateProgress | null; connectionLost: boolean }) {
  if (!progress) return <LoadingRow label="Update wird gestartet…" />;
  const percent = Math.round(Math.min(100, Math.max(0, progress.percent)));
  return (
    <div className="rs-update" aria-live="polite">
      <div className="rs-update-head">
        <Spinner size={18} label="Update läuft" />
        <span className="rs-update-phase">{phaseLabel(progress.phase)}</span>
        <span className="rs-update-percent">{percent} %</span>
      </div>
      <ProgressBar value={percent} label="Fortschritt des Updates" />
      {progress.message && <p className="rs-update-message">{progress.message}</p>}
      {connectionLost ? (
        <Notice tone="warning" title="Keine Verbindung zum Kiosk">
          Er startet vermutlich gerade neu. Der Fortschritt erscheint wieder, sobald er erreichbar ist – danach ist eine
          erneute Anmeldung nötig.
        </Notice>
      ) : (
        <p className="r-hint">Der Kiosk läuft während des Updates normal weiter und startet am Schluss neu.</p>
      )}
    </div>
  );
}

/** Outcome of a run followed on this page (prominent) or of the last run before (quiet). */
function LastRunView({ progress, outcome }: { progress: UpdateProgress; outcome: RunOutcome | null }) {
  if (outcome === 'not-started') {
    return (
      <>
        <Notice tone="error" title="Update nicht gestartet">
          Der Kiosk hat nach dem Auslösen keinen Fortschritt gemeldet – der Update-Dienst ist vermutlich nicht angelaufen.
          Details stehen im Update-Log des Kiosks.
        </Notice>
        {progress.message && <p className="r-hint">Letzter Update-Lauf davor: {progress.message}</p>}
      </>
    );
  }
  const followed = outcome === 'this-run';
  if (isFailed(progress)) {
    return (
      <Notice tone={followed ? 'error' : 'warning'} title={followed ? 'Update fehlgeschlagen' : 'Letztes Update fehlgeschlagen'}>
        {progress.message || 'Details stehen im Update-Log des Kiosks.'}
      </Notice>
    );
  }
  if (!followed) {
    return progress.phase && progress.message ? <p className="r-hint">Letzter Update-Lauf: {progress.message}</p> : null;
  }
  if (progress.phase === 'uptodate') {
    return (
      <Notice tone="success" title="Bereits auf dem neusten Stand">
        {progress.message}
      </Notice>
    );
  }
  if (progress.phase === 'skipped') {
    return (
      <Notice tone="info" title="Update übersprungen">
        {progress.message}
      </Notice>
    );
  }
  return (
    <Notice tone="success" title="Update installiert">
      {progress.message}
    </Notice>
  );
}

function CheckResult({ check, onInstall }: { check: CheckState; onInstall: () => Promise<void> }) {
  if (check.error !== null) {
    return (
      <Notice tone="error" title="Prüfung fehlgeschlagen">
        {check.error}
      </Notice>
    );
  }
  const result = check.result;
  if (!result) return null;
  if (!result.available) {
    return (
      <Notice tone="success" title="SlateDesk ist aktuell">
        Installiert ist der neuste Stand ({result.short_current}).
      </Notice>
    );
  }
  const changes = result.behind > 0 ? plural(result.behind, 'neue Änderung', 'neue Änderungen') : 'Eine neue Version';
  return (
    <Notice
      tone="info"
      title="Update verfügbar"
      action={
        <ConfirmButton
          variant="primary"
          icon={Download}
          tone="primary"
          confirmTitle="Update installieren?"
          confirmMessage="Der Kiosk lädt die neue Version, baut sie und startet danach neu. Das dauert einige Minuten; bis zum Neustart läuft er normal weiter. Nach dem Neustart ist eine erneute Anmeldung nötig."
          confirmLabel="Installieren"
          onConfirm={onInstall}
        >
          Update installieren
        </ConfirmButton>
      }
    >
      {changes} ({result.short_current} → {result.short_remote})
    </Notice>
  );
}

export function UpdateCard({ info }: { info: SystemInfo | null }) {
  /** Poll every 3 s while a run is not done (set from the answers themselves). */
  const [following, setFollowing] = useState(false);
  /** The run triggered or seen running here, until its first finished answer. */
  const watch = useRef<RunWatch | null>(null);
  /** Whether that answer is this run's outcome (shown prominently) – null: no run followed here. */
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  // busy: true – die Karte sucht beim Öffnen gleich nach (Effekt unten).
  const [check, setCheck] = useState<CheckState>({ busy: true, result: null, error: null });

  const fetchProgress = useCallback(async (signal: AbortSignal) => {
    const progress = await updateProgress(signal);
    if (!signal.aborted) {
      const now = Date.now();
      if (!progress.done) {
        watch.current = observeRun(watch.current, progress, now);
      } else if (watch.current) {
        setOutcome(runOutcome(watch.current, now));
        watch.current = null;
      }
      setFollowing(!progress.done);
    }
    return progress;
  }, []);
  // Interval 0 = one request (on open and after a run ended).
  const poll = usePoll(fetchProgress, following ? PROGRESS_POLL_MS : 0);
  const progress = poll.data;

  const loadCheck = useCallback(
    () =>
      actions.updateCheck().then(
        (result) => setCheck({ busy: false, result, error: null }),
        (err: unknown) => setCheck({ busy: false, result: null, error: errorText(err) }),
      ),
    [],
  );

  const runCheck = () => {
    setCheck((current) => ({ ...current, busy: true }));
    void loadCheck();
  };

  // Beim Öffnen gleich nachsehen: steht ein Update an, ist «Update installieren» sofort da.
  // Der Kiosk merkt sich das Ergebnis 30 s, Übersicht und System fragen also nicht doppelt.
  useEffect(() => {
    void loadCheck();
  }, [loadCheck]);

  const install = () =>
    actions.updateRun().then(() => {
      setCheck({ busy: false, result: null, error: null });
      watch.current = watchTriggeredRun(Date.now());
      setOutcome(null);
      setFollowing(true);
      toast.info('Update gestartet – der Fortschritt erscheint hier');
    });

  return (
    <Card
      title="Update"
      icon={Download}
      subtitle={info ? `Installiert: Version ${info.version}${info.commit ? ` (${info.commit})` : ''}` : undefined}
    >
      {following ? (
        <RunningView progress={progress && !progress.done ? progress : null} connectionLost={poll.error !== null} />
      ) : (
        <>
          {progress && <LastRunView progress={progress} outcome={outcome} />}
          <div className="r-form-actions r-form-actions-start">
            <Button icon={RefreshCw} busy={check.busy} onClick={runCheck}>
              Nach Updates suchen
            </Button>
          </div>
          <CheckResult check={check} onInstall={install} />
        </>
      )}
    </Card>
  );
}
