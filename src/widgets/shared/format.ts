/**
 * Display formatting for widgets – de-CH, Swiss spelling.
 * Pure functions (no React): `now` is always passed in, never read here, so
 * components stay pure and re-render on their own clock tick.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const integerFormat = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const decimalFormats = new Map<number, Intl.NumberFormat>();

function decimalFormat(digits: number): Intl.NumberFormat {
  let format = decimalFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    decimalFormats.set(digits, format);
  }
  return format;
}

/** Whole number with Swiss grouping: 184220 → «184’220». */
export const formatCount = (value: number): string => (Number.isFinite(value) ? integerFormat.format(value) : '–');

/** Fixed decimals: 1.125 → «1.13» (digits 2). */
export const formatDecimal = (value: number, digits = 1): string =>
  Number.isFinite(value) ? decimalFormat(digits).format(value) : '–';

/** «37 %» – non-breaking space, no line break between number and unit. */
export const formatPercent = (value: number): string =>
  Number.isFinite(value) ? `${integerFormat.format(value)}\u00a0%` : '–';

export const formatTemperature = (celsius: number): string => `${integerFormat.format(celsius)}\u00a0°C`;

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Index into BYTE_UNITS that keeps the value below 1024. */
function byteUnit(bytes: number): number {
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit;
}

function bytesIn(bytes: number, unit: number): string {
  const value = Math.max(0, Number.isFinite(bytes) ? bytes : 0) / 1024 ** unit;
  return decimalFormat(unit === 0 || value >= 100 ? 0 : 1).format(value);
}

/** Binary steps like the file managers on the kiosk: 135089336320 → «125.8 GB». */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0\u00a0B';
  const unit = byteUnit(bytes);
  return `${bytesIn(bytes, unit)}\u00a0${BYTE_UNITS[unit]}`;
}

/** «38.4 / 125.8 GB» – the total decides the unit, so both read alike. */
export function formatBytesOf(used: number, total: number): string {
  const unit = byteUnit(total > 0 && Number.isFinite(total) ? total : Math.max(0, used));
  return `${bytesIn(used, unit)} / ${bytesIn(total, unit)}\u00a0${BYTE_UNITS[unit]}`;
}

/** Share in percent, clamped to 0–100 (0 when the total is unknown). */
export const percentOf = (part: number, total: number): number =>
  total > 0 && Number.isFinite(part) ? Math.min(100, Math.max(0, (part / total) * 100)) : 0;

/** Duration in seconds: «45 s», «12 Min.», «2 Std. 5 Min.», «3 Tage 4 Std.». */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '–';
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds}\u00a0s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}\u00a0Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}\u00a0Std. ${rest}\u00a0Min.` : `${hours}\u00a0Std.`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const dayText = `${days}\u00a0${days === 1 ? 'Tag' : 'Tage'}`;
  return rest > 0 ? `${dayText} ${rest}\u00a0Std.` : dayText;
}

/** ISO timestamp → epoch ms, null when missing or unparsable. */
export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * clamd's date text («Mon Oct 12 22:31:12 2026», local time of the server).
 * Parsed by hand: WebKit's Date.parse does not reliably read the asctime
 * layout with the year at the end.
 */
export function parseClamdDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(value.trim());
  const month = match ? MONTHS[match[1].toLowerCase()] : undefined;
  if (!match || month === undefined) return parseTime(value);
  const date = new Date(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** «14:05» */
export const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

/** «12.09.2026» */
const formatDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });

const startOfDay = (ms: number): number => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** Calendar days from `now` to `ms` (0 = today, 1 = tomorrow, -1 = yesterday). */
export const dayOffset = (ms: number, now: number): number => Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);

/**
 * A point in time near `now`, with the day only when it is not today:
 * «03:00», «morgen 03:00», «gestern 22:10», «Mi 03:00», «14.10. 03:00».
 */
export function formatDayTime(ms: number, now: number): string {
  const time = formatClock(ms);
  const offset = dayOffset(ms, now);
  if (offset === 0) return time;
  if (offset === 1) return `morgen ${time}`;
  if (offset === -1) return `gestern ${time}`;
  if (offset > 1 && offset < 7) {
    const weekday = new Date(ms).toLocaleDateString('de-CH', { weekday: 'short' }).replace(/\.$/, '');
    return `${weekday} ${time}`;
  }
  const day = new Date(ms).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
  return `${day}${day.endsWith('.') ? '' : '.'} ${time}`;
}

/** How long ago: «gerade eben», «vor 5 Min.», «vor 2 Std.», «vor 3 Tagen», «am 12.09.2026». */
export function formatAgo(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 45_000) return 'gerade eben';
  if (diff < HOUR_MS) return `vor ${Math.max(1, Math.round(diff / MINUTE_MS))}\u00a0Min.`;
  if (diff < DAY_MS) return `vor ${Math.floor(diff / HOUR_MS)}\u00a0Std.`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 14) return days === 1 ? 'vor 1\u00a0Tag' : `vor ${days}\u00a0Tagen`;
  return `am ${formatDate(ms)}`;
}

/** Age in whole days as text: «heute», «gestern», «vor 4 Tagen». */
export function formatDaysAgo(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  return `vor ${formatCount(days)}\u00a0Tagen`;
}
