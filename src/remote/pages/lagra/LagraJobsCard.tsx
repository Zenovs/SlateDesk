/**
 * lagra's background jobs (GET /api/v1/jobs?verlauf=3): status of the last
 * runs, what runs right now and roughly when each job runs next. Refreshed
 * every 30 s while the page is visible.
 */
import { ListChecks, RefreshCw } from 'lucide-react';
import { fetchJobs, isLagraEndpointMissing } from '../../../lagra/client';
import type { LagraJob, LagraJobs } from '../../../lagra/types';
import { formatDayTime, formatDuration, formatTime, parseIso, plural } from '../../format';
import { useNow } from '../../hooks/useNow';
import { usePoll } from '../../hooks/usePoll';
import { Button, Card, EmptyState, LoadingRow, Notice, StatusDot } from '../../ui';
import { loadLagra } from './lagraLoad';
import { planText, runLabel, runTone, schedulerProblem, sinceText } from './lagraText';

const JOBS_POLL_MS = 30_000;
/** Runs per job: the last result plus a short history. */
const HISTORY = 3;
/** An estimate this close (or overdue) reads as «bald». */
const SOON_MS = 2 * 60_000;

type JobsResult = { kind: 'ok'; data: LagraJobs } | { kind: 'missing' };

const loadJobs = (signal: AbortSignal): Promise<JobsResult> =>
  loadLagra(async () => {
    try {
      return { kind: 'ok', data: await fetchJobs({ verlauf: HISTORY }, { signal }) };
    } catch (err) {
      if (isLagraEndpointMissing(err)) return { kind: 'missing' };
      throw err;
    }
  }, signal);

const lastFinished = (job: LagraJob) => job.verlauf.find((run) => run.status !== 'laeuft') ?? null;

function isProblem(job: LagraJob): boolean {
  const tone = runTone(lastFinished(job));
  return tone === 'error' || tone === 'warn';
}

function nextRunText(job: LagraJob, now: number): string | null {
  if (job.planArt === 'manuell' || !job.aktiv || job.laeuft) return null;
  const next = parseIso(job.naechsterLaufEtwa);
  if (next === null) return null;
  return next - now <= SOON_MS ? 'nächster Lauf bald' : `nächster Lauf etwa ${formatDayTime(next, now)}`;
}

function JobRow({ job, now }: { job: LagraJob; now: number }) {
  const last = lastFinished(job);
  const tone = job.laeuft ? 'info' : runTone(last);
  const lastAt = last ? parseIso(last.ende ?? last.beginn) : null;
  const meta = [
    planText(job),
    job.laeuft
      ? ['läuft', sinceText(job.seit, now)].filter(Boolean).join(' ')
      : last
        ? `${runLabel(last)}${lastAt !== null ? ` ${formatDayTime(lastAt, now)}` : ''}${last.dauerSek !== null ? ` (${formatDuration(last.dauerSek)})` : ''}`
        : 'noch nie gelaufen',
    nextRunText(job, now),
  ].filter(Boolean);
  // Oldest left, newest right – like a timeline.
  const history = job.verlauf
    .filter((run) => run.status !== 'laeuft')
    .slice(0, HISTORY)
    .reverse();

  return (
    <li className={`rg-job${isProblem(job) && !job.laeuft ? ' is-problem' : ''}`}>
      <StatusDot tone={tone} pulse={job.laeuft} label={job.laeuft ? 'läuft' : runLabel(last)} />
      <div className="rg-job-main">
        <p className="rg-job-name">
          {job.name}
          {job.schwer && <span className="r-tag">aufwendig</span>}
        </p>
        {job.beschreibung && <p className="rg-job-description">{job.beschreibung}</p>}
        <p className="rg-job-meta">{meta.join(' · ')}</p>
        {job.laeuft && job.fortschritt && <p className="rg-job-progress">{job.fortschritt}</p>}
        {!job.laeuft && last?.ergebnis && <p className="rg-job-result">{last.ergebnis}</p>}
      </div>
      {history.length > 1 && (
        <span className="rg-job-history" role="img" aria-label={`Letzte Läufe: ${history.map((run) => runLabel(run)).join(', ')}`}>
          {history.map((run) => (
            <StatusDot key={run.beginn} tone={runTone(run)} />
          ))}
        </span>
      )}
    </li>
  );
}

export function LagraJobsCard() {
  const { data, error, loading, lastUpdated, refresh } = usePoll(loadJobs, JOBS_POLL_MS);
  const now = useNow(JOBS_POLL_MS);
  const jobs = data?.kind === 'ok' ? data.data : null;

  // Running first, then problems; otherwise lagra's own order (grouped by topic).
  const rank = (job: LagraJob): number => (job.laeuft ? 0 : isProblem(job) ? 1 : 2);
  const sorted = jobs ? [...jobs.treffer].sort((a, b) => rank(a) - rank(b)) : [];
  const running = sorted.filter((job) => job.laeuft).length;
  const problems = sorted.filter((job) => !job.laeuft && isProblem(job)).length;
  const scheduler = jobs ? schedulerProblem(jobs.zeitplan, now) : null;

  const subtitle = jobs
    ? [
        plural(sorted.length, 'Aufgabe', 'Aufgaben'),
        running > 0 ? `${running} ${running === 1 ? 'läuft' : 'laufen'}` : null,
        problems > 0 ? plural(problems, 'mit Problem', 'mit Problemen') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Zeitplan und letzte Läufe';

  return (
    <Card
      className="rg-jobs-card"
      icon={ListChecks}
      title="Hintergrundaufgaben"
      subtitle={subtitle}
      actions={
        <Button size="sm" variant="ghost" iconOnly icon={RefreshCw} busy={loading && data !== null} onClick={refresh}>
          Aufgaben aktualisieren
        </Button>
      }
      footer={lastUpdated !== null ? `Aktualisiert um ${formatTime(lastUpdated, true)}` : undefined}
    >
      {error && (
        <Notice tone={jobs ? 'warning' : 'error'} title={jobs ? 'Keine aktuelle Antwort von lagra' : 'Aufgaben nicht verfügbar'}>
          {error}
        </Notice>
      )}
      {data?.kind === 'missing' && (
        <Notice tone="warning" title="lagra-Update nötig: Endpunkt /api/v1/jobs fehlt">
          Diese lagra-Version liefert die Aufgaben für SlateDesk noch nicht.
        </Notice>
      )}
      {data === null && !error && <LoadingRow label="Aufgaben werden geladen…" />}
      {scheduler && <Notice tone={scheduler.tone}>{scheduler.text}</Notice>}
      {jobs &&
        (sorted.length === 0 ? (
          <EmptyState compact icon={ListChecks} title="Keine Aufgaben" description="lagra meldet keine Hintergrundaufgaben." />
        ) : (
          <ul className="rg-jobs">
            {sorted.map((job) => (
              <JobRow key={job.id} job={job} now={now} />
            ))}
          </ul>
        ))}
    </Card>
  );
}
