/**
 * lagra Aufgaben – die Hintergrundaufgaben aus GET /api/v1/jobs.
 *
 * Je Aufgabe: Ampel des letzten abgeschlossenen Laufs, ob sie gerade läuft
 * (Fortschritt ohne Namen – lagra kürzt ihn ohne details=1), Dauer und
 * ungefähr der nächste Lauf. Steht der Zeitplan, gibt es eine Warnung.
 */
import { CircleCheck, ListChecks, TriangleAlert } from 'lucide-react';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { fetchJobs } from '../lagra/client';
import type { LagraJob, LagraJobLauf } from '../lagra/types';
import type { WidgetProps } from '../types/widget';
import { LAGRA_JOBS_DEFAULTS, type LagraJobsSettings } from './manifests/lagra-jobs';
import { formatAgo, formatClock, formatCount, formatDayTime, formatDuration, parseTime } from './shared/format';
import { useLagraPolling, useNow } from './shared/hooks';
import { LagraErrorMessage, LagraSetupMessage, LagraStaleBanner } from './shared/LagraParts';
import { Spinner, StatusDot, WidgetBanner, WidgetMessage } from './shared/WidgetParts';
import { readBoolean, readNumber, type Tone } from './shared/values';
import './styles/lagra-jobs.css';

/** Runs requested per job: last result plus a short history. */
const HISTORY = 3;
/** An estimate this close (or overdue) reads as «bald». */
const SOON_MS = 2 * 60_000;

interface JobView {
  job: LagraJob;
  /** Newest run that is not running any more. */
  last: LagraJobLauf | null;
  tone: Tone;
  problem: boolean;
}

function runTone(run: LagraJobLauf | null): Tone {
  if (!run) return 'neutral';
  if (run.status === 'fehler') return 'error';
  // «fertig» with an error text: finished, but e.g. skipped folders.
  if (run.status === 'abgebrochen' || run.fehler) return 'warn';
  return 'ok';
}

function runText(run: LagraJobLauf): string {
  if (run.status === 'fehler') return 'fehlgeschlagen';
  if (run.status === 'abgebrochen') return 'abgebrochen';
  return run.fehler ? 'mit Warnungen' : 'zuletzt';
}

function toView(job: LagraJob): JobView {
  const last = job.verlauf.find((run) => run.status !== 'laeuft') ?? null;
  const tone = runTone(last);
  return { job, last, tone, problem: tone === 'error' || tone === 'warn' };
}

function nextRunText(job: LagraJob, now: number): string | null {
  if (job.planArt === 'manuell') return 'nur von Hand';
  if (!job.aktiv) return 'Zeitplan aus';
  const next = parseTime(job.naechsterLaufEtwa);
  if (next === null) return null;
  return next - now <= SOON_MS ? 'nächster Lauf bald' : `nächster Lauf ~${formatDayTime(next, now)}`;
}

function JobRow({ view, now, showNextRun }: { view: JobView; now: number; showNextRun: boolean }) {
  const { job, last, tone } = view;
  const meta: string[] = [];

  if (job.laeuft) {
    const since = parseTime(job.seit);
    if (since !== null) meta.push(`seit ${formatDayTime(since, now)}`);
    if (job.fortschritt) meta.push(job.fortschritt);
  } else {
    const at = last ? parseTime(last.ende ?? last.beginn) : null;
    if (last && at !== null) meta.push(`${runText(last)} ${formatAgo(at, now)}`);
    else if (!last) meta.push('noch nie gelaufen');
    if (showNextRun) {
      const next = nextRunText(job, now);
      if (next) meta.push(next);
    }
  }

  // Oldest left, newest right – like a timeline.
  const history = job.verlauf
    .filter((run) => run.status !== 'laeuft')
    .slice(0, HISTORY)
    .reverse();
  const label = job.laeuft ? 'läuft' : last ? runText(last) : 'noch nie gelaufen';
  const duration = !job.laeuft && last && last.dauerSek !== null ? formatDuration(last.dauerSek) : null;

  return (
    <li className={`lj-row${view.problem ? ` lj-row-problem wp-tone-${tone}` : ''}`}>
      <StatusDot tone={job.laeuft ? 'accent' : tone} pulse={job.laeuft} label={label} />
      <div className="lj-main">
        <div className="lj-name">{job.name}</div>
        {meta.length > 0 && <div className="lj-meta">{meta.join(' · ')}</div>}
      </div>
      <div className="lj-side">
        {job.laeuft && (
          <span className="lj-running">
            <Spinner label="läuft" />
            läuft
          </span>
        )}
        {duration && (
          <span className="lj-duration" title="Dauer des letzten Laufs">
            {duration}
          </span>
        )}
        {history.length > 1 && (
          <span className="lj-history" aria-hidden="true">
            {history.map((run) => (
              <StatusDot key={run.beginn} tone={runTone(run)} size="sm" label={runText(run)} />
            ))}
          </span>
        )}
      </div>
    </li>
  );
}

export function LagraJobsWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings<LagraJobsSettings>(instanceId, LAGRA_JOBS_DEFAULTS);
  const onlyProblems = readBoolean(raw.onlyProblems, LAGRA_JOBS_DEFAULTS.onlyProblems);
  const showNextRun = readBoolean(raw.showNextRun, LAGRA_JOBS_DEFAULTS.showNextRun);
  const maxJobs = readNumber(raw.maxJobs, LAGRA_JOBS_DEFAULTS.maxJobs, 1, 20);
  const refreshMs = readNumber(raw.refreshSeconds, LAGRA_JOBS_DEFAULTS.refreshSeconds, 15, 600) * 1000;
  const now = useNow(30_000);

  const poll = useLagraPolling((signal) => fetchJobs({ verlauf: HISTORY }, { signal }), refreshMs, []);

  if (poll.setup !== 'ready') return <LagraSetupMessage setup={poll.setup} />;
  if (poll.data === null) {
    if (poll.error !== null) return <LagraErrorMessage kind={poll.errorKind} status={poll.errorStatus} />;
    return <WidgetMessage busy title="Aufgaben werden geladen …" />;
  }

  const { zeitplan, treffer } = poll.data;
  const views = treffer.map(toView);
  const running = views.filter((view) => view.job.laeuft).length;
  const problems = views.filter((view) => view.problem).length;
  // Running first, then problems; otherwise lagra's own order (grouped by topic).
  const rank = (view: JobView): number => (view.job.laeuft ? 0 : view.problem ? 1 : 2);
  const ordered = views
    .map((view, index) => ({ view, index }))
    .sort((a, b) => rank(a.view) - rank(b.view) || a.index - b.index)
    .map(({ view }) => view)
    .filter((view) => !onlyProblems || view.problem);
  const shown = ordered.slice(0, maxJobs);
  const hidden = ordered.length - shown.length;
  const lastTick = parseTime(zeitplan.letzterTakt);
  const stale = poll.error !== null;

  const summary = [
    `${formatCount(treffer.length)} ${treffer.length === 1 ? 'Aufgabe' : 'Aufgaben'}`,
    running > 0 ? `${formatCount(running)} ${running === 1 ? 'läuft' : 'laufen'}` : null,
    problems > 0 ? `${formatCount(problems)} mit Problemen` : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="lj">
      <div className="lj-head">
        <ListChecks className="lj-head-icon" aria-hidden="true" />
        <span className="lj-summary">{summary.join(' · ')}</span>
        {!stale && poll.lastUpdated !== null && <span className="lj-time">Stand {formatClock(poll.lastUpdated)}</span>}
      </div>
      {stale && (
        <LagraStaleBanner
          kind={poll.errorKind}
          status={poll.errorStatus}
          failingSince={poll.failingSince}
          lastUpdated={poll.lastUpdated}
        />
      )}
      {zeitplan.steht === true && (
        <WidgetBanner tone="error" icon={TriangleAlert}>
          Zeitplan steht{lastTick !== null ? ` – letzter Takt ${formatDayTime(lastTick, now)}` : ''}
        </WidgetBanner>
      )}
      {shown.length === 0 ? (
        onlyProblems ? (
          <WidgetMessage icon={CircleCheck} tone="ok" title="Keine Probleme" detail="Alle Aufgaben liefen zuletzt fehlerfrei." />
        ) : (
          <WidgetMessage icon={ListChecks} title="Keine Aufgaben" detail="lagra meldet keine Hintergrundaufgaben." />
        )
      ) : (
        <ul className={`lj-list${stale ? ' lj-list-stale' : ''}`}>
          {shown.map((view) => (
            <JobRow key={view.job.id} view={view} now={now} showNextRun={showNextRun} />
          ))}
          {hidden > 0 && <li className="lj-more">+{formatCount(hidden)} weitere</li>}
        </ul>
      )}
    </div>
  );
}
