/**
 * Booked time and running timers (planbar zeiten/zusammenfassung) for the
 * Zeit widget. planbar's minutes do not contain the running timer yet – it
 * is counted up here from its start.
 */
import type { PlanbarTimeEntry, PlanbarTimer } from '../../planbar/types';
import { parseTime } from '../shared/format';
import { zurichMinuteOfDay } from './days';

const MINUTE_MS = 60_000;
/** Working days per week for the weekly target. */
export const WORKDAYS_PER_WEEK = 5;

/** Running time of a timer in ms at `now`; planbar's value at request time when the start is unreadable. */
export function timerElapsedMs(timer: PlanbarTimer, now: number): number {
  const started = parseTime(timer.startedAt);
  if (started === null) return Math.max(0, timer.elapsedMinutes) * MINUTE_MS;
  return Math.max(0, now - started);
}

/**
 * The part of a running timer that belongs to today: a timer left running
 * since yesterday counts only from Zurich midnight on.
 */
export const timerTodayMinutes = (timer: PlanbarTimer, now: number): number =>
  Math.min(timerElapsedMs(timer, now) / MINUTE_MS, zurichMinuteOfDay(now));

/** Selected people in their order; without selection (everyone) alphabetically. */
export function orderEntries<T extends PlanbarTimeEntry>(entries: readonly T[], benutzer: readonly string[]): T[] {
  if (benutzer.length === 0) {
    return [...entries].sort((a, b) => a.user.name.localeCompare(b.user.name, 'de-CH', { sensitivity: 'base' }));
  }
  const byId = new Map(entries.map((entry) => [entry.user.id, entry]));
  return benutzer.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
}

/** Share of a target in percent (0 without target), not capped – over 100 means overtime. */
export const targetPercent = (minutes: number, targetMinutes: number): number =>
  targetMinutes > 0 && Number.isFinite(minutes) ? Math.max(0, (minutes / targetMinutes) * 100) : 0;
