/**
 * Order of planbar answers – used to merge the answers of several
 * Unternehmen (./orgs.ts) and by the widgets. Days are planbar's Zurich
 * calendar days `YYYY-MM-DD`, compared as UTC day numbers.
 */
import type { PlanbarWorkItem } from './types';

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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

const PRIORITY_RANK: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3 };

/** critical 0 … low 3, none or unknown 4. */
export const priorityRank = (priority: string | null): number =>
  priority !== null && Object.hasOwn(PRIORITY_RANK, priority) ? PRIORITY_RANK[priority] : 4;

type SortKey = Pick<PlanbarWorkItem, 'done' | 'dueDay' | 'priority' | 'type' | 'updatedAt'>;

/**
 * planbar's own order (planbar-api §3): open before done → due day, items
 * without one last → priority → tasks before projects → most recently updated.
 */
export function compareWorkItems(a: SortKey, b: SortKey): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const dueA = dayNumber(a.dueDay);
  const dueB = dayNumber(b.dueDay);
  if (dueA !== dueB) {
    if (dueA === null) return 1;
    if (dueB === null) return -1;
    return dueA - dueB;
  }
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  if (a.type !== b.type) return a.type === 'aufgabe' ? -1 : 1;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

/** The later of two days; an invalid day loses. */
export function laterDay(a: string, b: string): string {
  const x = dayNumber(a);
  const y = dayNumber(b);
  if (x === null) return b;
  if (y === null) return a;
  return y > x ? b : a;
}
