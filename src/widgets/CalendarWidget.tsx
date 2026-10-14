/**
 * Calendar widget – ICS/webcal calendars (Office 365, Google, iCloud …),
 * downloaded and expanded by the backend (`calendar_events`).
 *
 * Views: agenda grouped by day, today, and a room board "Jetzt / Als
 * Nächstes". Everything that depends on the current time is recomputed every
 * 30 s; the calendars themselves reload every `refreshMinutes`. When a
 * calendar fails, its last good events stay on screen with a small hint.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, CalendarDays, Loader2, RefreshCw } from 'lucide-react';
import type { WidgetProps } from '../types/widget';
import { useAppState } from '../state/appState';
import { widgetSettingsActions } from '../state/dataActions';
import { isHexColor } from '../state/defaults';
import { usePolling } from '../hooks/usePolling';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { calendarEvents, type CalendarEventItem } from '../utils/backend';
import {
  CALENDAR_DEFAULT_SETTINGS,
  OFFICE365_ICS_HINT,
  type CalendarPrivacy,
  type CalendarSettings,
  type CalendarView,
} from './manifests/calendar';
import './styles/calendar.css';

const NOW_TICK_MS = 30_000;
const MINUTE_MS = 60_000;
/** Old `timeRange` setting (before 3.0) → `daysAhead`. */
const LEGACY_RANGE_DAYS: Record<string, number> = { today: 1, week: 7, month: 30 };

interface CalendarSourceInfo {
  url: string;
  /** Configured name, or the host of the link. */
  name: string;
  color: string | null;
  enabled: boolean;
}

interface SourceFailure {
  name: string;
  error: string;
  /** Older events of this calendar are still shown. */
  stale: boolean;
}

interface CalendarData {
  events: CalendarEventItem[];
  failures: SourceFailure[];
}

type SourceResult = { source: CalendarSourceInfo; events: CalendarEventItem[] } | { source: CalendarSourceInfo; error: string };

type EventPhase = 'past' | 'running' | 'upcoming';

interface ShownEvent {
  id: string;
  title: string;
  location: string | null;
  start: number;
  end: number;
  allDay: boolean;
  color: string | null;
  phase: EventPhase;
  /** Day (local midnight) the event is listed under: its start day, at the earliest today. */
  day: number;
}

interface DayGroup {
  day: number;
  events: ShownEvent[];
}

interface ListModel {
  groups: DayGroup[];
  /** Upcoming events cut off by `maxEvents`. */
  hidden: number;
  /** Events that are not over yet. */
  active: number;
  /** First event that is not over, when finished ones precede it – the list scrolls there. */
  anchorId: string | null;
}

interface BoardModel {
  current: ShownEvent | null;
  parallel: number;
  next: ShownEvent | null;
  later: ShownEvent[];
  allDay: ShownEvent[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TIME = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });
const SHORT_DATE = new Intl.DateTimeFormat('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' });
const LONG_DATE = new Intl.DateTimeFormat('de-CH', { weekday: 'long', day: 'numeric', month: 'long' });
const WEEKDAY = new Intl.DateTimeFormat('de-CH', { weekday: 'long' });
const DAY_MONTH = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'long' });

const time = (ms: number): string => TIME.format(ms);
const shortDate = (ms: number): string => SHORT_DATE.format(ms);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Unbekannter Fehler';
}

/** Local midnight (the kiosk's zone – the backend anchors all-day events there too). */
function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar days, not 24 h – stays on midnight across DST changes. */
function addDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^webcals?:/i, 'https:')).hostname || url;
  } catch {
    return url;
  }
}

/** Calendars with a link, in settings order (disabled ones included). */
function configuredSources(raw: unknown): CalendarSourceInfo[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const sources: CalendarSourceInfo[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    sources.push({
      url,
      name: name || hostOf(url),
      color: isHexColor(item.color) ? item.color : null,
      enabled: item.enabled !== false,
    });
  }
  return sources;
}

/**
 * One backend call per calendar, so a failure is attributed exactly and the
 * other calendars still show. A failed calendar keeps its previous events.
 */
async function loadCalendars(
  sources: CalendarSourceInfo[],
  days: number,
  previous: ReadonlyMap<string, CalendarEventItem[]>,
): Promise<{ data: CalendarData; cache: Map<string, CalendarEventItem[]> }> {
  const from = startOfDay(Date.now());
  // One spare day keeps the list complete across midnight until the next reload.
  const to = addDays(from, days + 1);
  const results = await Promise.all(
    sources.map(async (source): Promise<SourceResult> => {
      try {
        const result = await calendarEvents(
          [{ url: source.url, name: source.name, color: source.color ?? undefined }],
          from,
          to,
        );
        const failure = result.errors[0];
        return failure ? { source, error: failure.error } : { source, events: result.events };
      } catch (err) {
        return { source, error: errorMessage(err) };
      }
    }),
  );

  const cache = new Map<string, CalendarEventItem[]>();
  const failures: SourceFailure[] = [];
  for (const result of results) {
    if ('events' in result) {
      cache.set(result.source.url, result.events);
      continue;
    }
    const last = previous.get(result.source.url);
    if (last) cache.set(result.source.url, last);
    failures.push({ name: result.source.name, error: result.error, stale: last !== undefined });
  }

  // The same meeting often sits in several calendars (team + room) – show it once.
  const seen = new Set<string>();
  const events = [...cache.values()].flat().filter((event) => {
    const key = `${event.title}|${event.start}|${event.end}|${event.allDay}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { data: { events, failures }, cache };
}

function toShown(
  event: CalendarEventItem,
  now: number,
  today: number,
  privacy: CalendarPrivacy,
  showLocation: boolean,
  showColors: boolean,
): ShownEvent {
  const busyOnly = privacy === 'besetzt';
  return {
    id: event.id,
    title: busyOnly ? 'Besetzt' : event.title.trim() || '(ohne Titel)',
    location: busyOnly || !showLocation ? null : event.location?.trim() || null,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    color: showColors && isHexColor(event.color) ? event.color : null,
    phase: event.end <= now ? 'past' : event.start <= now ? 'running' : 'upcoming',
    day: Math.max(startOfDay(event.start), today),
  };
}

/** Finished first (they are above the fold), then all-day, then by start. */
const phaseRank = (event: ShownEvent): number => (event.phase === 'past' ? 0 : event.allDay ? 1 : 2);

function compareShown(a: ShownEvent, b: ShownEvent): number {
  return (
    a.day - b.day ||
    phaseRank(a) - phaseRank(b) ||
    a.start - b.start ||
    a.end - b.end ||
    a.title.localeCompare(b.title, 'de-CH')
  );
}

/** Agenda / today: events overlapping [today, windowEnd), today's finished ones included. */
function buildList(events: ShownEvent[], today: number, windowEnd: number, maxEvents: number): ListModel {
  const groups: DayGroup[] = [];
  let active = 0;
  let hidden = 0;
  let hasPast = false;
  let anchorId: string | null = null;
  for (const event of events) {
    if (event.end <= today || event.start >= windowEnd) continue;
    if (event.phase === 'past') {
      hasPast = true;
    } else {
      if (active >= maxEvents) {
        hidden += 1;
        continue;
      }
      if (active === 0 && hasPast) anchorId = event.id;
      active += 1;
    }
    const group = groups[groups.length - 1];
    if (group && group.day === event.day) group.events.push(event);
    else groups.push({ day: event.day, events: [event] });
  }
  return { groups, hidden, active, anchorId };
}

function buildBoard(events: ShownEvent[], windowEnd: number, maxEvents: number): BoardModel {
  const running = events.filter((e) => !e.allDay && e.phase === 'running').sort((a, b) => a.start - b.start);
  const upcoming = events
    .filter((e) => !e.allDay && e.phase === 'upcoming' && e.start < windowEnd)
    .sort((a, b) => a.start - b.start);
  return {
    current: running[0] ?? null,
    parallel: Math.max(0, running.length - 1),
    next: upcoming[0] ?? null,
    later: upcoming.slice(1, Math.max(1, maxEvents)),
    allDay: events.filter((e) => e.allDay && e.phase === 'running'),
  };
}

function dayHeading(day: number, today: number): { name: string; date: string } {
  if (day === today) return { name: 'Heute', date: LONG_DATE.format(day) };
  if (day === addDays(today, 1)) return { name: 'Morgen', date: LONG_DATE.format(day) };
  return { name: WEEKDAY.format(day), date: DAY_MONTH.format(day) };
}

function durationText(minutes: number): string {
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} Std. ${rest} Min.` : `${hours} Std.`;
}

/** «in 12 Min.», «in 2 Std. 5 Min.», «morgen, 09:00», «Do., 15.10., 09:00». */
function startsIn(start: number, now: number, today: number): string {
  const minutes = Math.ceil((start - now) / MINUTE_MS);
  if (minutes <= 0) return 'jetzt';
  if (minutes < 60 || start < addDays(today, 1)) return `in ${durationText(minutes)}`;
  if (start < addDays(today, 2)) return `morgen, ${time(start)}`;
  return `${shortDate(start)}, ${time(start)}`;
}

/** «noch 25 Min.», for events lasting longer than a day «bis Do., 15.10.». */
function remainingText(event: ShownEvent, now: number): string {
  const minutes = Math.max(1, Math.ceil((event.end - now) / MINUTE_MS));
  return minutes < 24 * 60 ? `noch ${durationText(minutes)}` : `bis ${shortDate(event.end)}`;
}

/** «09:00 – 10:30», across midnight «22:00 – Mi., 14.10. 02:00». */
function rangeText(event: ShownEvent): string {
  if (event.end <= event.start) return time(event.start);
  const sameDay = startOfDay(event.end - 1) === startOfDay(event.start);
  return `${time(event.start)} – ${sameDay ? time(event.end) : `${shortDate(event.end)} ${time(event.end)}`}`;
}

/** Start and end as shown in the time column of a row listed under `day`. */
function rowTimes(event: ShownEvent, day: number): { start: string; end: string | null } {
  const nextDay = addDays(day, 1);
  if (event.allDay) {
    // DTEND of all-day events is exclusive: the last day is the one before.
    const lastDay = addDays(event.end, -1);
    return { start: 'Ganztägig', end: lastDay >= nextDay ? `bis ${shortDate(lastDay)}` : null };
  }
  const start = event.start < day ? `seit ${shortDate(event.start)}` : time(event.start);
  if (event.end <= event.start) return { start, end: null };
  return { start, end: event.end <= nextDay ? time(event.end) : `${shortDate(event.end)} ${time(event.end)}` };
}

function progressOf(event: ShownEvent, now: number): number {
  const span = event.end - event.start;
  if (span <= 0) return 100;
  return Math.min(100, Math.max(0, ((now - event.start) / span) * 100));
}

const colorStyle = (color: string | null): CSSProperties | undefined =>
  color ? ({ '--cal-color': color } as CSSProperties) : undefined;

/** Current time, refreshed every `intervalMs` – for running events, "in 12 Min." and the progress bars. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// ── Parts ────────────────────────────────────────────────────────────────────

function EmptyState({ title, text, hint, error }: { title: string; text?: string; hint?: string; error?: boolean }) {
  const Icon = error ? AlertTriangle : CalendarDays;
  return (
    <div className={`cal-empty${error ? ' error' : ''}`} role={error ? 'alert' : undefined}>
      <Icon className="cal-empty-icon" aria-hidden="true" />
      <div className="cal-empty-title">{title}</div>
      {text && <div className="cal-empty-text">{text}</div>}
      {hint && <div className="cal-empty-hint">{hint}</div>}
    </div>
  );
}

function EventRow({ event, day, now, anchor }: { event: ShownEvent; day: number; now: number; anchor: boolean }) {
  const times = rowTimes(event, day);
  const runningTimed = event.phase === 'running' && !event.allDay;
  // All-day events run all day long – no "Jetzt" highlight for them.
  const state = event.allDay && event.phase === 'running' ? 'all-day' : event.phase;
  return (
    <div className={`cal-event ${state}`} style={colorStyle(event.color)} data-anchor={anchor ? 'true' : undefined}>
      <div className="cal-event-time">
        <span className="cal-event-start">{times.start}</span>
        {times.end && <span className="cal-event-end">{times.end}</span>}
      </div>
      <div className="cal-event-main">
        <div className="cal-event-title">
          <span className="cal-event-title-text">{event.title}</span>
          {runningTimed && <span className="cal-badge">Jetzt</span>}
        </div>
        {event.location && <div className="cal-event-location">{event.location}</div>}
      </div>
      {runningTimed && <div className="cal-event-progress" style={{ width: `${progressOf(event, now)}%` }} />}
    </div>
  );
}

function EventList({
  model,
  today,
  now,
  dayLabels,
  emptyText,
  doneText,
}: {
  model: ListModel;
  today: number;
  now: number;
  dayLabels: boolean;
  /** Nothing in the range at all. */
  emptyText: string;
  /** Only finished events of today. */
  doneText: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep "now" at the top: finished events of today stay readable above it.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const anchor = model.anchorId ? list.querySelector<HTMLElement>('[data-anchor="true"]') : null;
    if (!anchor) {
      list.scrollTop = 0;
      return;
    }
    const label = anchor.closest('.cal-day')?.querySelector<HTMLElement>('.cal-day-label');
    list.scrollTop = Math.max(0, anchor.offsetTop - (label?.offsetHeight ?? 0));
  }, [model.anchorId]);

  if (model.groups.length === 0) return <div className="cal-list-empty">{emptyText}</div>;

  return (
    <div className="cal-list" ref={listRef}>
      {model.groups.map((group) => {
        const heading = dayHeading(group.day, today);
        return (
          <section key={group.day} className="cal-day">
            {dayLabels && (
              <div className="cal-day-label">
                <span className="cal-day-name">{heading.name}</span>
                <span className="cal-day-date">{heading.date}</span>
              </div>
            )}
            {group.events.map((event) => (
              <EventRow key={event.id} event={event} day={group.day} now={now} anchor={event.id === model.anchorId} />
            ))}
          </section>
        );
      })}
      {model.active === 0 && <div className="cal-list-note">{doneText}</div>}
    </div>
  );
}

function Board({ model, now, today, daysAhead }: { model: BoardModel; now: number; today: number; daysAhead: number }) {
  const { current, parallel, next, later, allDay } = model;
  const tomorrow = addDays(today, 1);
  const progress = current ? progressOf(current, now) : 0;
  return (
    <div className="cal-board">
      <div className={`cal-board-now ${current ? 'busy' : 'free'}`}>
        <div className="cal-board-head">
          <span className="cal-section-label">Jetzt</span>
          {current && <span className="cal-board-remaining">{remainingText(current, now)}</span>}
        </div>
        {current ? (
          <>
            <div className="cal-board-title">{current.title}</div>
            <div className="cal-board-meta">{[rangeText(current), current.location].filter(Boolean).join(' · ')}</div>
            <div
              className="cal-progress"
              role="progressbar"
              aria-label="Verstrichene Zeit"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <div className="cal-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            {parallel > 0 && (
              <div className="cal-board-parallel">
                {parallel === 1 ? '+1 weiterer Termin gleichzeitig' : `+${parallel} weitere Termine gleichzeitig`}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="cal-board-title">Frei</div>
            <div className="cal-board-meta">
              {next && next.start < tomorrow ? `bis ${time(next.start)}` : 'für den Rest des Tages'}
            </div>
          </>
        )}
      </div>

      {allDay.length > 0 && (
        <div className="cal-board-allday">
          {allDay.map((event) => (
            <span key={event.id} className="cal-chip" style={colorStyle(event.color)}>
              {event.title}
            </span>
          ))}
        </div>
      )}

      <div className="cal-board-next">
        <span className="cal-section-label">Als Nächstes</span>
        {next ? (
          <div className="cal-board-next-event" style={colorStyle(next.color)}>
            <div className="cal-board-next-row">
              <span className="cal-board-next-title">{next.title}</span>
              <span className="cal-board-in">{startsIn(next.start, now, today)}</span>
            </div>
            <div className="cal-board-meta">{[rangeText(next), next.location].filter(Boolean).join(' · ')}</div>
          </div>
        ) : (
          <div className="cal-board-none">
            {daysAhead === 1 ? 'Heute keine weiteren Termine' : `Keine Termine in den nächsten ${daysAhead} Tagen`}
          </div>
        )}
        {later.length > 0 && (
          <ul className="cal-board-later">
            {later.map((event) => (
              <li key={event.id} style={colorStyle(event.color)}>
                <span className="cal-board-later-time">
                  {event.start < tomorrow ? time(event.start) : `${shortDate(event.start)} ${time(event.start)}`}
                </span>
                <span className="cal-board-later-title">{event.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Footer({ hidden, failures, error }: { hidden: number; failures: SourceFailure[]; error: string | null }) {
  let warning: string | null = null;
  let detail = '';
  if (failures.length === 1) {
    const [failure] = failures;
    warning = `${failure.name}: ${failure.error}`;
    detail = failure.stale ? `${warning} – es werden die zuletzt geladenen Termine gezeigt` : warning;
  } else if (failures.length > 1) {
    warning = `${failures.length} Kalender nicht erreichbar`;
    detail = failures.map((f) => `${f.name}: ${f.error}`).join('\n');
  } else if (error) {
    warning = `Aktualisierung fehlgeschlagen: ${error}`;
    detail = warning;
  }
  if (hidden === 0 && !warning) return null;
  return (
    <div className="cal-footer">
      {hidden > 0 && <span className="cal-more">{hidden === 1 ? '+1 weiterer Termin' : `+${hidden} weitere Termine`}</span>}
      {warning && (
        <span className="cal-warning" title={detail}>
          <AlertTriangle aria-hidden="true" />
          <span>{warning}</span>
        </span>
      )}
    </div>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function CalendarWidget({ instanceId }: WidgetProps) {
  const [settings] = useWidgetSettings<CalendarSettings>(instanceId, CALENDAR_DEFAULT_SETTINGS);
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);

  // Before 3.0: `timeRange` ('today' | 'week' | 'month') and a demo `source`.
  useEffect(() => {
    if (!stored || (stored.timeRange === undefined && stored.source === undefined)) return;
    const patch: Record<string, unknown> = { timeRange: undefined, source: undefined };
    if (stored.daysAhead === undefined && typeof stored.timeRange === 'string') {
      patch.daysAhead = LEGACY_RANGE_DAYS[stored.timeRange] ?? CALENDAR_DEFAULT_SETTINGS.daysAhead;
    }
    void widgetSettingsActions.update(instanceId, patch);
  }, [stored, instanceId]);

  const view: CalendarView = settings.view === 'heute' || settings.view === 'jetzt' ? settings.view : 'agenda';
  const daysAhead = clampInt(settings.daysAhead, 1, 60, CALENDAR_DEFAULT_SETTINGS.daysAhead);
  const maxEvents = clampInt(settings.maxEvents, 1, 50, CALENDAR_DEFAULT_SETTINGS.maxEvents);
  const refreshMinutes = clampInt(settings.refreshMinutes, 1, 24 * 60, CALENDAR_DEFAULT_SETTINGS.refreshMinutes);
  const privacy: CalendarPrivacy = settings.privacy === 'besetzt' ? 'besetzt' : 'normal';
  const showLocation = settings.showLocation !== false;
  const showColors = settings.showSourceColors !== false;

  const configured = useMemo(() => configuredSources(settings.sources), [settings.sources]);
  const sources = useMemo(() => configured.filter((source) => source.enabled), [configured]);
  const sourcesKey = JSON.stringify(sources.map((source) => [source.url, source.name, source.color]));
  const lastGood = useRef<ReadonlyMap<string, CalendarEventItem[]>>(new Map());

  const { data, error, refresh } = usePolling<CalendarData>(
    async (signal) => {
      // Always the full range, so switching the view needs no reload.
      const result = await loadCalendars(sources, daysAhead, lastGood.current);
      if (!signal.aborted) lastGood.current = result.cache;
      return result.data;
    },
    refreshMinutes * MINUTE_MS,
    [sourcesKey, daysAhead],
    { enabled: sources.length > 0 },
  );

  const now = useNow(NOW_TICK_MS);
  const today = startOfDay(now);

  // A new day moves the requested range – reload now instead of at the next interval.
  const loadedDay = useRef(today);
  useEffect(() => {
    if (loadedDay.current === today) return;
    loadedDay.current = today;
    refresh();
  }, [today, refresh]);

  const shown = useMemo(
    () =>
      (data?.events ?? [])
        .map((event) => toShown(event, now, today, privacy, showLocation, showColors))
        .sort(compareShown),
    [data, now, today, privacy, showLocation, showColors],
  );

  const windowEnd = addDays(today, view === 'heute' ? 1 : daysAhead);
  const list = useMemo(
    () => (view === 'jetzt' ? null : buildList(shown, today, windowEnd, maxEvents)),
    [view, shown, today, windowEnd, maxEvents],
  );
  const board = useMemo(
    () => (view === 'jetzt' ? buildBoard(shown, windowEnd, maxEvents) : null),
    [view, shown, windowEnd, maxEvents],
  );

  if (configured.length === 0) {
    return (
      <div className="cal">
        <EmptyState
          title="Kein Kalender verbunden"
          text="In den Einstellungen (oder über die Fernsteuerung) einen ICS-Link eintragen."
          hint={`Office 365: ${OFFICE365_ICS_HINT}`}
        />
      </div>
    );
  }
  if (sources.length === 0) {
    return (
      <div className="cal">
        <EmptyState title="Alle Kalender ausgeblendet" text="In den Einstellungen bei einem Kalender «Anzeigen» einschalten." />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cal">
        {error ? (
          <EmptyState title="Kalender nicht erreichbar" text={error} error />
        ) : (
          <div className="cal-loading">
            <Loader2 className="spin" aria-hidden="true" />
            Kalender wird geladen …
          </div>
        )}
      </div>
    );
  }
  if (data.events.length === 0 && data.failures.length >= sources.length) {
    return (
      <div className="cal">
        <EmptyState
          title={sources.length === 1 ? 'Kalender nicht erreichbar' : 'Keine Kalender erreichbar'}
          text={data.failures.map((failure) => `${failure.name}: ${failure.error}`).join(' · ')}
          hint={refreshMinutes === 1 ? 'Neuer Versuch jede Minute.' : `Neuer Versuch alle ${refreshMinutes} Minuten.`}
          error
        />
      </div>
    );
  }

  const range = view === 'heute' || daysAhead === 1 ? 'heute' : `in den nächsten ${daysAhead} Tagen`;
  const emptyText = range === 'heute' ? 'Heute keine Termine' : `Keine Termine ${range}`;
  const doneText = range === 'heute' ? 'Heute keine weiteren Termine' : `Keine weiteren Termine ${range}`;

  return (
    <div className={`cal cal-view-${view}`}>
      {view === 'heute' && (
        <div className="cal-day-label cal-today-head">
          <span className="cal-day-name">Heute</span>
          <span className="cal-day-date">{LONG_DATE.format(today)}</span>
        </div>
      )}
      {board && <Board model={board} now={now} today={today} daysAhead={daysAhead} />}
      {list && (
        <EventList
          model={list}
          today={today}
          now={now}
          dayLabels={view === 'agenda'}
          emptyText={emptyText}
          doneText={doneText}
        />
      )}
      <Footer hidden={list?.hidden ?? 0} failures={data.failures} error={error} />
    </div>
  );
}

// ── Settings extra (kiosk) ───────────────────────────────────────────────────

interface SourceCheck {
  ok: boolean;
  text: string;
}

/** Tests every configured link right in the settings dialog – handy while pasting ICS links. */
export function CalendarSettingsExtra({ instanceId }: { instanceId: string }) {
  const [settings] = useWidgetSettings<CalendarSettings>(instanceId, CALENDAR_DEFAULT_SETTINGS);
  const sources = useMemo(() => configuredSources(settings.sources), [settings.sources]);
  const days = clampInt(settings.daysAhead, 1, 60, CALENDAR_DEFAULT_SETTINGS.daysAhead);
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({});
  const [checking, setChecking] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (sources.length === 0) return null;

  const check = async () => {
    setChecking(true);
    const from = startOfDay(Date.now());
    const to = addDays(from, days);
    const entries = await Promise.all(
      sources.map(async (source): Promise<[string, SourceCheck]> => {
        try {
          const result = await calendarEvents([{ url: source.url, name: source.name }], from, to);
          const failure = result.errors[0];
          if (failure) return [source.url, { ok: false, text: failure.error }];
          const count = result.events.length === 1 ? '1 Termin' : `${result.events.length} Termine`;
          return [source.url, { ok: true, text: `${count} ${days === 1 ? 'heute' : `in den nächsten ${days} Tagen`}` }];
        } catch (err) {
          return [source.url, { ok: false, text: errorMessage(err) }];
        }
      }),
    );
    if (!mounted.current) return;
    setChecks(Object.fromEntries(entries));
    setChecking(false);
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">Verbindung prüfen</div>
      <div className="cal-check">
        {sources.map((source) => {
          const result = checks[source.url];
          const dot = !result ? 'var(--text-tertiary)' : result.ok ? 'var(--success-color)' : 'var(--error-color)';
          return (
            <div key={source.url} className="settings-status">
              <span className="settings-status-dot" style={{ background: dot }} />
              <div className="cal-check-text">
                <strong>
                  {source.name}
                  {!source.enabled && ' (ausgeblendet)'}
                </strong>
                <span>{result ? result.text : 'Noch nicht geprüft'}</span>
              </div>
            </div>
          );
        })}
        <button type="button" className="settings-btn" onClick={() => void check()} disabled={checking}>
          {checking ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          Kalender jetzt prüfen
        </button>
      </div>
    </div>
  );
}
