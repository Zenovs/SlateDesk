/**
 * Clock widget – digital or analog clock with date, ISO calendar week, live
 * time zone label (DST-aware) and up to four world clocks.
 *
 * All text sizes come from the widget's real size (container query units in
 * clock.css); the component only passes the text lengths as CSS variables.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { WidgetProps } from '../types/widget';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import {
  CLOCK_DEFAULT_SETTINGS,
  DEFAULT_TIMEZONE,
  MAX_WORLD_CLOCKS,
  TIMEZONE_OPTIONS,
  type ClockDateFormat,
  type ClockSettings,
  type ClockTimeFormat,
} from './manifests/clock';
import './styles/clock.css';

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sonntag */
  weekday: number;
}

interface TimeText {
  main: string;
  period: 'AM' | 'PM' | null;
}

interface WorldEntry {
  key: string;
  label: string;
  time: TimeText;
  dayOffset: string | null;
}

const WEEKDAYS_SHORT = ['SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA'];
const MS_PER_DAY = 86_400_000;
const GMT_OFFSET_NAME = /^(GMT|UTC)[+\-−]/;
/** de-CH knows MEZ/MESZ, en-US the US zones, en-GB BST – the first real abbreviation wins. */
const ABBREVIATION_LOCALES = ['de-CH', 'en-US', 'en-GB'];
const ZONE_LABELS = new Map(TIMEZONE_OPTIONS.map((option) => [option.value, option.label]));

// Creating Intl formatters is expensive and the clock renders every second.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
}

/** Settings may come from the web UI or an import – an unknown zone must not crash the widget. */
function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    formatter('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatter('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

const dayNumber = (p: ZonedParts): number => Math.round(Date.UTC(p.year, p.month - 1, p.day) / MS_PER_DAY);

/** ISO 8601 week: weeks start on Monday, week 1 contains the first Thursday. */
function isoWeek(p: ZonedParts): number {
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / MS_PER_DAY + 1) / 7);
}

const pad = (n: number): string => String(n).padStart(2, '0');

function timeText(p: ZonedParts, format: ClockTimeFormat, withSeconds: boolean): TimeText {
  const rest = `:${pad(p.minute)}${withSeconds ? `:${pad(p.second)}` : ''}`;
  if (format === '12h') return { main: `${p.hour % 12 || 12}${rest}`, period: p.hour < 12 ? 'AM' : 'PM' };
  return { main: `${pad(p.hour)}${rest}`, period: null };
}

/** Approximate width in digit widths, for the font size in clock.css. */
function timeUnits(text: TimeText): number {
  const colons = text.main.split(':').length - 1;
  return text.main.length - colons * 0.5 + (text.period ? 1.4 : 0);
}

function dateText(date: Date, p: ZonedParts, format: ClockDateFormat, timeZone: string): string {
  const weekday = WEEKDAYS_SHORT[p.weekday];
  const dd = pad(p.day);
  const mm = pad(p.month);
  const yyyy = String(p.year);
  switch (format) {
    case 'none':
      return '';
    case 'DD.MM.YY':
      return `${weekday} ${dd}.${mm}.${yyyy.slice(-2)}`;
    case 'DD.MM.YYYY':
      return `${weekday} ${dd}.${mm}.${yyyy}`;
    case 'MM/DD/YYYY':
      return `${weekday} ${mm}/${dd}/${yyyy}`;
    case 'YYYY-MM-DD':
      return `${weekday} ${yyyy}-${mm}-${dd}`;
    default:
      return formatter('de-CH', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }
}

/** Short zone name for this instant – MEZ in winter, MESZ in summer; GMT±x where no name exists. */
function zoneAbbreviation(date: Date, timeZone: string): string {
  let fallback = '';
  for (const locale of ABBREVIATION_LOCALES) {
    const name =
      formatter(locale, { timeZone, timeZoneName: 'short' })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (name && !GMT_OFFSET_NAME.test(name)) return name;
    if (!fallback) fallback = name;
  }
  return fallback;
}

/** «Zürich», «Los Angeles» – from the curated list, else the last segment of the IANA id. */
function zoneCity(timeZone: string): string {
  if (timeZone === 'UTC') return 'UTC';
  const label = ZONE_LABELS.get(timeZone);
  if (label) return label.split(' / ')[0].replace(/\s*\(.*\)$/, '');
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
}

function zoneLabel(date: Date, timeZone: string): string {
  const city = zoneCity(timeZone);
  const abbreviation = zoneAbbreviation(date, timeZone);
  return abbreviation && abbreviation !== city ? `${city} · ${abbreviation}` : city;
}

/**
 * The current time, updated right after every full second (or minute). A
 * timeout chain re-aligned on each tick never drifts and catches up after
 * the machine was suspended.
 */
function useAlignedNow(unitMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      // A few ms past the boundary, so a slightly early timer never shows the old value.
      timer = setTimeout(tick, unitMs - (Date.now() % unitMs) + 15);
    };
    const tick = () => {
      setNow(new Date());
      schedule();
    };
    schedule();
    return () => clearTimeout(timer);
  }, [unitMs]);
  return now;
}

const HAND_ROTATION = (angle: number): string => `rotate(${angle.toFixed(2)} 100 100)`;
const DIAL_TICKS = Array.from({ length: 60 }, (_, i) => i);

function AnalogFace({ parts, showSeconds, label }: { parts: ZonedParts; showSeconds: boolean; label: string }) {
  const hourAngle = ((parts.hour % 12) + parts.minute / 60) * 30;
  const minuteAngle = (parts.minute + (showSeconds ? parts.second / 60 : 0)) * 6;
  const secondAngle = parts.second * 6;
  return (
    <svg className="clock-analog" viewBox="0 0 200 200" role="img" aria-label={label}>
      <circle className="clock-analog-face" cx="100" cy="100" r="96" />
      {DIAL_TICKS.map((i) => {
        const kind = i % 15 === 0 ? 'quarter' : i % 5 === 0 ? 'hour' : 'minute';
        return (
          <line
            key={i}
            className={`clock-analog-tick ${kind}`}
            x1="100"
            y1="10"
            x2="100"
            y2={kind === 'minute' ? 16 : kind === 'hour' ? 24 : 28}
            transform={HAND_ROTATION(i * 6)}
          />
        );
      })}
      <line className="clock-analog-hand hour" x1="100" y1="114" x2="100" y2="52" transform={HAND_ROTATION(hourAngle)} />
      <line className="clock-analog-hand minute" x1="100" y1="116" x2="100" y2="26" transform={HAND_ROTATION(minuteAngle)} />
      {showSeconds && (
        <g transform={HAND_ROTATION(secondAngle)}>
          <line className="clock-analog-hand second" x1="100" y1="126" x2="100" y2="22" />
          <circle className="clock-analog-second-tip" cx="100" cy="34" r="4" />
        </g>
      )}
      <circle className="clock-analog-center" cx="100" cy="100" r="5" />
    </svg>
  );
}

export function ClockWidget({ instanceId }: WidgetProps) {
  // A missing `showTimezoneLabel` means «never switched on» – pre-3.0 clocks get
  // it once at the legacy import (upgradeLegacyClockSettings), never at runtime.
  const [settings] = useWidgetSettings<ClockSettings>(instanceId, CLOCK_DEFAULT_SETTINGS);

  const analog = settings.style === 'analog';
  const format: ClockTimeFormat = settings.timeFormat === '12h' ? '12h' : '24h';
  const showSeconds = settings.showSeconds === true;
  const zoneValid = isValidTimeZone(settings.timezone);
  const timeZone = zoneValid ? settings.timezone : DEFAULT_TIMEZONE;

  const worldClocks = useMemo(
    () =>
      (Array.isArray(settings.worldClocks) ? settings.worldClocks : [])
        .filter((entry) => typeof entry === 'object' && entry !== null && isValidTimeZone(entry.timezone))
        .slice(0, MAX_WORLD_CLOCKS)
        .map((entry, index) => ({
          key: `${index}:${entry.timezone}`,
          timezone: entry.timezone,
          label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : zoneCity(entry.timezone),
        })),
    [settings.worldClocks],
  );

  const now = useAlignedNow(showSeconds ? 1000 : 60_000);
  const parts = zonedParts(now, timeZone);
  const time = timeText(parts, format, showSeconds);
  const date = dateText(now, parts, settings.dateFormat, timeZone);
  const week = settings.showWeekNumber ? `KW ${isoWeek(parts)}` : '';
  const dateLine = [date, week].filter(Boolean).join(' · ');
  const showZone = settings.showTimezoneLabel === true || !zoneValid;
  const zone = zoneValid
    ? zoneLabel(now, timeZone)
    : `Zeitzone «${String(settings.timezone)}» unbekannt – ${zoneLabel(now, timeZone)}`;

  const today = dayNumber(parts);
  const world: WorldEntry[] = worldClocks.map((entry) => {
    const local = zonedParts(now, entry.timezone);
    const offset = dayNumber(local) - today;
    return {
      key: entry.key,
      label: entry.label,
      time: timeText(local, format, false),
      dayOffset: offset === 0 ? null : `${offset > 0 ? '+' : '−'}${Math.abs(offset)} Tag`,
    };
  });

  // Vertical share of the big time, in cqh – whatever the other rows leave.
  const timeShare = 72 - (dateLine ? 14 : 0) - (showZone ? 9 : 0) - (world.length > 0 ? 20 : 0);
  const style = {
    '--clock-time-units': timeUnits(time),
    '--clock-time-share': `${timeShare}cqh`,
    '--clock-date-chars': Math.max(dateLine.length, 8),
    '--clock-world-count': Math.max(world.length, 1),
  } as CSSProperties;

  const dateRow = dateLine && (
    <div className="clock-date">
      {date && <span className="clock-date-text">{date}</span>}
      {week && <span className="clock-week">{week}</span>}
    </div>
  );

  return (
    <div className={`clock ${analog ? 'clock-is-analog' : 'clock-is-digital'}`} style={style}>
      {analog ? (
        <>
          <div className="clock-analog-wrap">
            <AnalogFace parts={parts} showSeconds={showSeconds} label={`${time.main}${time.period ? ` ${time.period}` : ''}`} />
          </div>
          {dateRow}
        </>
      ) : (
        <>
          {dateRow}
          <div className="clock-time" role="timer" aria-live="off">
            {time.main}
            {time.period && <span className="clock-period">{time.period}</span>}
          </div>
        </>
      )}
      {showZone && <div className={`clock-zone${zoneValid ? '' : ' invalid'}`}>{zone}</div>}
      {world.length > 0 && (
        <div className="clock-world">
          {world.map((entry) => (
            <div key={entry.key} className="clock-world-item">
              <span className="clock-world-label">{entry.label}</span>
              <span className="clock-world-time">
                {entry.time.main}
                {entry.time.period && <span className="clock-world-period">{entry.time.period}</span>}
                {entry.dayOffset && <span className="clock-world-offset">{entry.dayOffset}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
