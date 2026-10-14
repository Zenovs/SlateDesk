/**
 * planbar Zeit – heute und diese Woche erfasste Zeit pro Person aus
 * GET /api/v1/zeiten/zusammenfassung, mit laufendem Timer. planbar zählt den
 * laufenden Timer noch nicht mit; hier läuft er sekundengenau weiter und
 * zählt ab Mitternacht zu heute.
 */
import { useMemo } from 'react';
import { Timer, TriangleAlert, Users } from 'lucide-react';
import { normalizeSelection } from '../components/settings/multiselect';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { fetchZeitZusammenfassung } from '../planbar/client';
import type { PlanbarTimeEntry, PlanbarTimeSummary, PlanbarTimer } from '../planbar/types';
import type { WidgetProps } from '../types/widget';
import { PLANBAR_ZEIT_DEFAULTS, type PlanbarZeitSettings } from './manifests/planbar-zeit';
import { daysBetween } from './planbar/days';
import { formatElapsed, formatMinutes } from './planbar/format';
import { PersonAvatar, PlanbarErrorMessage, PlanbarHead, PlanbarSetupMessage, PlanbarStaleBanner } from './planbar/PlanbarParts';
import { orderEntries, targetPercent, timerElapsedMs, timerTodayMinutes, WORKDAYS_PER_WEEK } from './planbar/time';
import { usePlanbarPolling } from './planbar/usePlanbarPolling';
import { formatCount, formatPercent } from './shared/format';
import { useNow } from './shared/hooks';
import { WidgetMessage } from './shared/WidgetParts';
import { readBoolean, readNumber } from './shared/values';
import './styles/planbar-zeit.css';

const WEEKDAY_LETTERS = ['M', 'D', 'M', 'D', 'F', 'S', 'S'] as const;
const WEEKDAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'] as const;

function readSettings(raw: PlanbarZeitSettings): PlanbarZeitSettings {
  const defaults = PLANBAR_ZEIT_DEFAULTS;
  return {
    benutzer: normalizeSelection(raw.benutzer),
    showWeek: readBoolean(raw.showWeek, defaults.showWeek),
    sollStundenProTag: readNumber(raw.sollStundenProTag, defaults.sollStundenProTag, 0, 24, false),
    refreshSeconds: readNumber(raw.refreshSeconds, defaults.refreshSeconds, 30, 600),
  };
}

/** «Hosting klären · Website Relaunch» – without repeating the same text. */
function timerText(timer: PlanbarTimer): string {
  const parts = [timer.taskLabel ?? timer.label, timer.projectLabel].map((part) => part?.trim() ?? '');
  const unique = parts.filter((part, i) => part !== '' && parts.indexOf(part) === i);
  return unique.join(' · ') || 'Timer läuft';
}

interface WeekProps {
  days: readonly number[];
  /** 0 = Monday; -1 when the week is not this week. */
  todayIndex: number;
  /** Today's running timer in minutes (not in planbar's numbers yet). */
  running: number;
  dayTarget: number;
}

function WeekBars({ days, todayIndex, running, dayTarget }: WeekProps) {
  const values = WEEKDAY_LETTERS.map((_, i) => Math.max(0, days[i] ?? 0) + (i === todayIndex ? running : 0));
  const scale = Math.max(dayTarget, ...values, 1);
  return (
    <div className="pz-bars" aria-hidden="true">
      {values.map((minutes, i) => (
        <div
          key={WEEKDAY_NAMES[i]}
          className={`pz-bar${i === todayIndex ? ' pz-bar-today' : ''}${todayIndex >= 0 && i > todayIndex ? ' pz-bar-future' : ''}`}
          title={`${WEEKDAY_NAMES[i]}: ${formatMinutes(minutes)} h`}
        >
          <div className="pz-bar-column">
            <div className="pz-bar-fill" style={{ height: `${(minutes / scale) * 100}%` }} />
            {dayTarget > 0 && <div className="pz-bar-target" style={{ bottom: `${(dayTarget / scale) * 100}%` }} />}
          </div>
          <span className="pz-bar-letter">{WEEKDAY_LETTERS[i]}</span>
        </div>
      ))}
    </div>
  );
}

interface RowOptions {
  now: number;
  dayTarget: number;
  showWeek: boolean;
  todayIndex: number;
}

function PersonRow({ entry, options }: { entry: PlanbarTimeEntry; options: RowOptions }) {
  const { timer } = entry;
  const running = timer ? timerTodayMinutes(timer, options.now) : 0;
  const today = Math.max(0, entry.todayMinutes) + running;
  const week = Math.max(0, entry.weekMinutes) + running;
  const weekTarget = options.dayTarget * WORKDAYS_PER_WEEK;
  const percent = targetPercent(today, options.dayTarget);
  const bookedWidth = Math.min(100, targetPercent(Math.max(0, entry.todayMinutes), options.dayTarget));
  const runningWidth = Math.min(100 - bookedWidth, targetPercent(running, options.dayTarget));

  return (
    <li className={`pz-row${timer ? ' pz-row-running' : ''}`}>
      <PersonAvatar person={entry.user} />
      <div className="pz-main">
        <div className="pz-line">
          <span className="pz-name">{entry.user.name.trim() || 'Ohne Namen'}</span>
          <span className="pz-today" title="Heute erfasst">
            {formatMinutes(today)}&nbsp;h
          </span>
        </div>
        {options.dayTarget > 0 && (
          <div
            className={`pz-track${percent >= 100 ? ' pz-track-full' : ''}`}
            role="img"
            aria-label={`Heute ${formatPercent(percent)} vom Soll`}
          >
            <div className="pz-fill" style={{ width: `${bookedWidth}%` }} />
            {runningWidth > 0 && <div className="pz-fill-running" style={{ width: `${runningWidth}%` }} />}
          </div>
        )}
        {timer && (
          <div className="pz-timer">
            <span className="pz-timer-dot" aria-hidden="true" />
            <span className="pz-timer-label">{timerText(timer)}</span>
            <span className="pz-timer-time">{formatElapsed(timerElapsedMs(timer, options.now))}</span>
          </div>
        )}
      </div>
      {options.showWeek && (
        <div className="pz-week">
          <span className="pz-week-total" title="Diese Woche erfasst">
            Woche {formatMinutes(week)}
            {weekTarget > 0 && <span className="pz-week-target"> / {formatMinutes(weekTarget)}</span>}
            &nbsp;h
          </span>
          <WeekBars days={entry.weekDays} todayIndex={options.todayIndex} running={running} dayTarget={options.dayTarget} />
        </div>
      )}
    </li>
  );
}

export function PlanbarZeitWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings(instanceId, PLANBAR_ZEIT_DEFAULTS);
  const settings = useMemo(() => readSettings(raw), [raw]);

  const poll = usePlanbarPolling<PlanbarTimeSummary>(
    (signal) => fetchZeitZusammenfassung({ benutzer: settings.benutzer }, { signal }),
    settings.refreshSeconds * 1000,
    [settings.benutzer.join(',')],
  );
  const anyRunning = poll.data?.data.some((entry) => entry.timer !== null) ?? false;
  // Seconds tick only while a timer runs.
  const now = useNow(anyRunning ? 1000 : 30_000);
  const entries = useMemo(
    () => (poll.data ? orderEntries(poll.data.data, settings.benutzer) : []),
    [poll.data, settings.benutzer],
  );

  if (poll.setup !== 'ready') return <PlanbarSetupMessage setup={poll.setup} />;
  if (poll.data === null) {
    if (poll.failure) return <PlanbarErrorMessage failure={poll.failure} right="Aufgaben & Zeiten – Lesen" />;
    if (poll.error !== null) return <WidgetMessage icon={TriangleAlert} tone="error" title="planbar-Fehler" detail={poll.error} />;
    return <WidgetMessage busy title="Zeiten werden geladen …" />;
  }

  const stale = poll.failure !== null;
  const dayTarget = Math.round(settings.sollStundenProTag * 60);
  const todayIndex = daysBetween(poll.data.weekStart, poll.data.today) ?? -1;
  const options: RowOptions = {
    now,
    dayTarget,
    showWeek: settings.showWeek,
    todayIndex: todayIndex >= 0 && todayIndex < WEEKDAY_LETTERS.length ? todayIndex : -1,
  };
  const total = entries.reduce(
    (sum, entry) => sum + Math.max(0, entry.todayMinutes) + (entry.timer ? timerTodayMinutes(entry.timer, now) : 0),
    0,
  );
  const runningCount = entries.filter((entry) => entry.timer !== null).length;

  return (
    <div className="pz">
      <PlanbarHead icon={Timer} lastUpdated={poll.lastUpdated} stale={stale}>
        Heute {formatMinutes(total)}&nbsp;h
        {runningCount > 0 && ` · ${formatCount(runningCount)} ${runningCount === 1 ? 'Timer läuft' : 'Timer laufen'}`}
      </PlanbarHead>
      {poll.failure && <PlanbarStaleBanner failure={poll.failure} lastUpdated={poll.lastUpdated} />}
      {entries.length === 0 ? (
        <div className="pz-empty">
          <WidgetMessage
            icon={Users}
            title="Keine Personen"
            detail={
              settings.benutzer.length > 0
                ? 'Die ausgewählten Personen gibt es in planbar nicht mehr.'
                : 'planbar meldet keine Personen.'
            }
          />
        </div>
      ) : (
        <ul className={`pz-list${stale ? ' pz-list-stale' : ''}`}>
          {entries.map((entry) => (
            <PersonRow key={entry.user.id} entry={entry} options={options} />
          ))}
        </ul>
      )}
    </div>
  );
}
