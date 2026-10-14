/**
 * Calendar days of the planbar widgets. planbar counts days in
 * Europe/Zurich (`dueDay`, `today`, `weekStart`, …): they stay `YYYY-MM-DD`
 * strings and are compared as UTC day numbers, so daylight saving time never
 * moves a day. Only `zurichDay` / `zurichMinuteOfDay` look at a clock.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

let zurichClock: Intl.DateTimeFormat | null = null;

function clock(): Intl.DateTimeFormat {
  if (zurichClock) return zurichClock;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    zurichClock = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Europe/Zurich' });
  } catch {
    // Engine without time zone data: the kiosk's own zone – it stands in Zurich.
    zurichClock = new Intl.DateTimeFormat('en-GB', options);
  }
  return zurichClock;
}

function zurichParts(ms: number): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const out = { year: '', month: '', day: '', hour: '', minute: '' };
  for (const part of clock().formatToParts(ms)) {
    if (part.type in out) out[part.type as keyof typeof out] = part.value;
  }
  return out;
}

/** The Zurich calendar day of a point in time (epoch ms) – planbar's «today». */
export function zurichDay(ms: number): string {
  const { year, month, day } = zurichParts(ms);
  return `${year}-${month}-${day}`;
}

/** Minutes since midnight on the Zurich wall clock. */
export function zurichMinuteOfDay(ms: number): number {
  const { hour, minute } = zurichParts(ms);
  return Number(hour) * 60 + Number(minute);
}

/** `YYYY-MM-DD` → days since 1970-01-01; null when missing or not a real date (2026-02-31). */
export function dayNumber(day: string | null | undefined): number | null {
  const match = day ? DAY_PATTERN.exec(day) : null;
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, date);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return utc / DAY_MS;
}

const dayFromNumber = (value: number): string => new Date(value * DAY_MS).toISOString().slice(0, 10);

/** `day` plus `days` calendar days; an invalid day stays as it is. */
export function addDays(day: string, days: number): string {
  const value = dayNumber(day);
  return value === null ? day : dayFromNumber(value + days);
}

/** Calendar days from `from` to `to` (tomorrow = 1), null if one is invalid. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a === null || b === null ? null : b - a;
}

/** 0 = Montag … 6 = Sonntag; null for an invalid day. */
export function weekdayIndex(day: string): number | null {
  const value = dayNumber(day);
  // 1970-01-01 was a Thursday.
  return value === null ? null : (((value + 3) % 7) + 7) % 7;
}

/** Sunday of the week (Monday to Sunday) that contains `day`. */
export function endOfWeek(day: string): string {
  const weekday = weekdayIndex(day);
  return weekday === null ? day : addDays(day, 6 - weekday);
}

/**
 * The later of two days. Data that could not be refreshed since yesterday
 * must not keep yesterday as «heute»; invalid days lose.
 */
export function laterDay(a: string, b: string): string {
  const x = dayNumber(a);
  const y = dayNumber(b);
  if (x === null) return b;
  if (y === null) return a;
  return y > x ? b : a;
}

/** «Fr 17.10.» – with the year when it differs from `today`'s: «Mo 05.01.27». */
export function formatDay(day: string, today: string): string {
  const match = DAY_PATTERN.exec(day);
  const weekday = weekdayIndex(day);
  if (!match || weekday === null) return day;
  const year = today.slice(0, 4) === match[1] ? '' : match[1].slice(2);
  return `${WEEKDAYS[weekday]} ${match[3]}.${match[2]}.${year}`;
}

/** «Do» */
export function formatWeekday(day: string): string {
  const weekday = weekdayIndex(day);
  return weekday === null ? day : WEEKDAYS[weekday];
}
