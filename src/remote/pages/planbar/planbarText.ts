/** Labels and day texts for planbar data in the web UI. */
import type { PlanbarScopes, PlanbarTestResult, PlanbarWorkItem } from '../../../planbar/types';
import { formatDay } from '../../format';
import type { StatusTone } from '../../ui';

/** Where the key is made – the path is the same on every planbar server. */
export const PLANBAR_KEY_PAGE = '/api-keys';

/** planbar's day `YYYY-MM-DD` (Europe/Zurich) as local midnight, null when malformed. */
export function dayMs(day: string | null | undefined): number | null {
  const match = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!match) return null;
  const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export interface DueInfo {
  text: string;
  tone: 'overdue' | 'today' | 'later';
}

/** «überfällig seit Fr 10.10.», «fällig heute», «fällig morgen» – relative to planbar's `today`; null without date. */
export function dueInfo(item: Pick<PlanbarWorkItem, 'dueDay' | 'overdue' | 'done'>, today: string): DueInfo | null {
  const due = dayMs(item.dueDay);
  const now = dayMs(today);
  if (due === null || now === null) return null;
  const day = formatDay(due, now);
  if (item.overdue) return { text: `überfällig seit ${day}`, tone: 'overdue' };
  if (!item.done && due === now) return { text: 'fällig heute', tone: 'today' };
  return { text: `fällig ${day}`, tone: 'later' };
}

/** Priorities worth a tag in a short list (planbar's own German label). */
export function priorityTag(item: Pick<PlanbarWorkItem, 'priority' | 'priorityLabel'>): string | null {
  if (item.priority !== 'critical' && item.priority !== 'high') return null;
  return item.priorityLabel ?? (item.priority === 'critical' ? 'Kritisch' : 'Hoch');
}

/** «Website Relaunch · Muster AG» – project (for tasks) and customer. */
export function contextText(item: Pick<PlanbarWorkItem, 'type' | 'project' | 'parentTitle'>): string {
  const parts = [item.type === 'aufgabe' ? (item.parentTitle ?? item.project.name) : null, item.project.customer?.name];
  return parts.filter((part): part is string => Boolean(part?.trim())).join(' · ');
}

/** A link from planbar's data – only http(s), never anything a browser would run. */
export function safeLink(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export interface ScopeRow {
  key: keyof PlanbarScopes;
  /** As the right is called in planbar's key dialog. */
  label: string;
  /** What SlateDesk needs it for. */
  usage: string;
  /** Not needed for reading – only to tick off tasks on the kiosk. */
  optional?: boolean;
}

export const SCOPE_ROWS: readonly ScopeRow[] = [
  { key: 'aufgaben', label: 'Aufgaben & Zeiten – Lesen', usage: 'Aufgaben, Zeit und Personenauswahl' },
  {
    key: 'aufgabenSchreiben',
    label: 'Aufgaben & Zeiten – Schreiben',
    usage: 'Nur zum Abhaken von Aufgaben am Kiosk',
    optional: true,
  },
  { key: 'projekte', label: 'Projekte – Lesen', usage: 'Projekte und Projektauswahl' },
  { key: 'news', label: 'News – Lesen', usage: 'News der Infowand' },
];

export function scopeState(row: ScopeRow, granted: boolean): { tone: StatusTone; text: string } {
  if (granted) return { tone: 'ok', text: 'erteilt' };
  return row.optional ? { tone: 'idle', text: 'nicht erteilt (optional)' } : { tone: 'error', text: 'fehlt' };
}

/** Connection test of one Unternehmen as a card shows it. */
export interface TestState {
  busy: boolean;
  result: PlanbarTestResult | null;
  error: string | null;
  at: number | null;
}

export const NO_TEST: TestState = { busy: false, result: null, error: null, at: null };
