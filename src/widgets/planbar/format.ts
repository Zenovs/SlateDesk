/**
 * Display texts of the planbar widgets – de-CH, Swiss spelling. Pure
 * functions: the current day / time is always passed in.
 */
import { formatCount, formatDecimal } from '../shared/format';
import { daysBetween, formatDay, formatWeekday, weekdayIndex } from './days';

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Booked time as hours:minutes: 450 → «7:30» (whole minutes, never negative). */
export function formatMinutes(minutes: number): string {
  const total = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

/** Running time of a timer: 3_909_000 ms → «1:05:09». */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return `${Math.floor(total / 3600)}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
}

/** Hours with at most one decimal: 2 → «2», 1.25 → «1.3», 1234 → «1’234». */
function hoursNumber(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? formatCount(rounded) : formatDecimal(rounded, 1);
}

/** «2 Std.», «1.5 Std.» */
export const formatHours = (hours: number): string =>
  Number.isFinite(hours) ? `${hoursNumber(Math.max(0, hours))}\u00a0Std.` : '–';

/** Booked against budget: «12.5 / 16 Std.» */
export const formatHoursOf = (part: number, total: number): string =>
  Number.isFinite(part) && Number.isFinite(total)
    ? `${hoursNumber(Math.max(0, part))} / ${hoursNumber(Math.max(0, total))}\u00a0Std.`
    : '–';

/**
 * Two letters for an avatar: first and last name («Hans-Peter Müller» → «HM»),
 * the first two letters of a single name, the local part of an e-mail address
 * (planbar shows the e-mail when a person has no name).
 */
export function initials(name: string): string {
  const base = name.includes('@') ? name.slice(0, name.indexOf('@')) : name;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0]);
  if (words.length === 1) return first.slice(0, 2).join('').toLocaleUpperCase('de-CH');
  const last = Array.from(words[words.length - 1]);
  return `${first[0]}${last[0]}`.toLocaleUpperCase('de-CH');
}

/** Stable hue (0–359) per person id – the same person has the same colour in every widget. */
export function personHue(id: string): number {
  // FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

export type DeadlineTone = 'overdue' | 'soon' | 'normal';

export interface DeadlineText {
  text: string;
  tone: DeadlineTone;
}

/** Days from 0 to this are «soon» (warning colour). */
const SOON_DAYS = 3;
/** From this many days on the date is shown instead of «in N Tagen». */
const DATE_FROM_DAYS = 14;

/** A project deadline relative to today: «2 Tage überfällig», «heute fällig», «in 5 Tagen», «bis Mo 27.10.». */
export function deadlineText(day: string, today: string): DeadlineText {
  const diff = daysBetween(today, day);
  if (diff === null) return { text: day, tone: 'normal' };
  if (diff < 0) return { text: diff === -1 ? '1 Tag überfällig' : `${formatCount(-diff)} Tage überfällig`, tone: 'overdue' };
  if (diff === 0) return { text: 'heute fällig', tone: 'soon' };
  if (diff === 1) return { text: 'morgen fällig', tone: 'soon' };
  if (diff < DATE_FROM_DAYS) return { text: `in ${diff} Tagen`, tone: diff <= SOON_DAYS ? 'soon' : 'normal' };
  return { text: `bis ${formatDay(day, today)}`, tone: 'normal' };
}

/** Due day of a work list entry: «Heute», «Morgen», «Gestern», «Do» (later this week), «Mo 27.10.». */
export function dueText(day: string, today: string): string {
  const diff = daysBetween(today, day);
  if (diff === null) return day;
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === -1) return 'Gestern';
  const weekday = weekdayIndex(today);
  if (diff > 1 && weekday !== null && diff <= 6 - weekday) return formatWeekday(day);
  return formatDay(day, today);
}
