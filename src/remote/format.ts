/**
 * Swiss German number, size and time formatting for the web UI.
 */
const LOCALE = 'de-CH';

const numberFormats = new Map<number, Intl.NumberFormat>();

/** 1234.5 → «1’234.5»; at most `digits` decimals. */
export function formatNumber(value: number, digits = 1): string {
  let format = numberFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits });
    numberFormats.set(digits, format);
  }
  return format.format(value);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Binary units, e.g. 8_000_000_000 → «7.5 GB». */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, value >= 100 || unit === 0 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** 0.42 → «42 %». */
export const formatPercent = (fraction: number): string => `${Math.round(fraction * 100)} %`;

/** Singular/plural with the number, e.g. plural(1, 'Tag', 'Tage') → «1 Tag». */
export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Uptime-style duration: «3 Tage 4 Std.», «5 Std. 12 Min.», «12 Min.». */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 60) return 'weniger als 1 Min.';
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86_400);
  if (days > 0) return hours > 0 ? `${plural(days, 'Tag', 'Tage')} ${hours} Std.` : plural(days, 'Tag', 'Tage');
  if (hours > 0) return minutes > 0 ? `${hours} Std. ${minutes} Min.` : `${hours} Std.`;
  return `${minutes} Min.`;
}

const timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const timeWithSecondsFormat = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Epoch ms → «14:05» (or «14:05:09»). */
export const formatTime = (ms: number, withSeconds = false): string =>
  (withSeconds ? timeWithSecondsFormat : timeFormat).format(ms);

/** Epoch ms → «13.10.2026, 14:05». */
export const formatDateTime = (ms: number): string => dateTimeFormat.format(ms);

const DAY_MS = 86_400_000;
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

/** Local midnight of the day containing `ms`. */
export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar days from the day of `now` to the day of `ms` (0 = same day; DST-safe). */
export const dayOffset = (ms: number, now: number): number => Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);

/** «heute», «morgen», «gestern», «Mo 13.10.» – with the year when it is not the current one. */
export function formatDay(ms: number, now: number): string {
  const offset = dayOffset(ms, now);
  if (offset === 0) return 'heute';
  if (offset === 1) return 'morgen';
  if (offset === -1) return 'gestern';
  const date = new Date(ms);
  const day = `${date.getDate()}.${date.getMonth() + 1}.`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${WEEKDAYS[date.getDay()]} ${day}`
    : `${day}${date.getFullYear()}`;
}

/** «heute 14:05», «Mo 13.10. 14:05». */
export const formatDayTime = (ms: number, now: number): string => `${formatDay(ms, now)} ${formatTime(ms)}`;

/** «gerade eben», «vor 5 Min.», «vor 3 Std.», «vor 2 Tagen»; in the future «in 5 Min.». */
export function formatRelative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff > 0 ? 'in weniger als 1 Min.' : 'gerade eben';
  const text =
    abs < 3_600_000
      ? `${Math.floor(abs / 60_000)} Min.`
      : abs < DAY_MS
        ? `${Math.floor(abs / 3_600_000)} Std.`
        : plural(Math.floor(abs / DAY_MS), 'Tag', 'Tagen');
  return diff > 0 ? `in ${text}` : `vor ${text}`;
}

/** ISO timestamp (lagra) → epoch ms; null for missing or unparsable values. */
export function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole numbers with thousands separators: 184220 → «184’220». */
export const formatCount = (value: number): string => formatNumber(value, 0);
