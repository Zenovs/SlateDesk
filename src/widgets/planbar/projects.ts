/**
 * planbar Projektübersicht for the Projekte widget: which request the
 * settings make, client-side order and the hours budget.
 */
import type { PlanbarProjectOverview, PlanbarProjectQuery } from '../../planbar/types';
import type { PlanbarProjekteSettings, PlanbarProjekteSortierung, PlanbarProjekteStatus } from '../manifests/planbar-projekte';
import { dayNumber } from './days';

/** planbar's maximum page size – enough to sort locally. */
const MAX_PAGE_SIZE = 200;
/** planbar accepts at most this many ids / people per request. */
const MAX_IDS = 100;
const MAX_PEOPLE = 50;

function statusParam(status: PlanbarProjekteStatus): PlanbarProjectQuery['status'] {
  return status === 'laufend' ? ['open', 'in_progress'] : status;
}

type QuerySettings = Pick<
  PlanbarProjekteSettings,
  'auswahl' | 'projekte' | 'status' | 'beteiligte' | 'leiter' | 'sortierung' | 'maxItems'
>;

/**
 * The request for the settings; null when hand-picked projects are wanted
 * but none is chosen yet. Hand-picked projects are always shown (also when
 * done, status 'alle'), in their order. planbar sorts by deadline itself –
 * any other order needs the whole list.
 */
export function projectQuery(settings: QuerySettings): PlanbarProjectQuery | null {
  if (settings.auswahl === 'ausgewaehlt') {
    const ids = settings.projekte.slice(0, MAX_IDS);
    return ids.length > 0 ? { ids, status: 'alle', pageSize: ids.length } : null;
  }
  const query: PlanbarProjectQuery = {
    status: statusParam(settings.status),
    pageSize: settings.sortierung === 'deadline' ? settings.maxItems : MAX_PAGE_SIZE,
  };
  if (settings.beteiligte.length > 0) query.benutzer = settings.beteiligte.slice(0, MAX_PEOPLE);
  if (settings.leiter) query.leiter = [settings.leiter];
  return query;
}

const byTitle = (a: PlanbarProjectOverview, b: PlanbarProjectOverview): number =>
  a.title.localeCompare(b.title, 'de-CH', { sensitivity: 'base' });

/** Earlier deadline first, none last. */
function compareDeadline(a: PlanbarProjectOverview, b: PlanbarProjectOverview): number {
  const x = dayNumber(a.deadlineDay);
  const y = dayNumber(b.deadlineDay);
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
}

/** planbar's order: pinned first → deadline (none last) → most recently updated. */
function compareAsPlanbar(a: PlanbarProjectOverview, b: PlanbarProjectOverview): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  return compareDeadline(a, b) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

/** Least done first (needs the most attention); projects without tasks last. */
function compareProgress(a: PlanbarProjectOverview, b: PlanbarProjectOverview): number {
  const x = a.progress.percent;
  const y = b.progress.percent;
  if (x !== y) {
    if (x === null) return 1;
    if (y === null) return -1;
    return x - y;
  }
  return compareDeadline(a, b) || byTitle(a, b);
}

/** Projects of several Unternehmen together: one order over all of them. */
export function sortProjects<T extends PlanbarProjectOverview>(
  projects: readonly T[],
  sortierung: PlanbarProjekteSortierung,
): T[] {
  const compare = sortierung === 'fortschritt' ? compareProgress : sortierung === 'name' ? byTitle : compareAsPlanbar;
  return [...projects].sort(compare);
}

export interface HoursBudget {
  tracked: number;
  /** Planned hours, else the estimate; null without budget. */
  budget: number | null;
  /** tracked / budget in percent (planbar's value), null without budget. */
  percent: number | null;
  over: boolean;
}

export function hoursBudget(hours: PlanbarProjectOverview['hours']): HoursBudget {
  const budget = hours.planned ?? hours.estimated;
  const usable = budget !== null && budget > 0 ? budget : null;
  const percent =
    usable === null ? null : typeof hours.percent === 'number' ? hours.percent : Math.round((hours.tracked / usable) * 100);
  return { tracked: hours.tracked, budget: usable, percent, over: percent !== null && percent > 100 };
}

/** A CSS colour from planbar (customer / team), only as `#rgb` / `#rrggbb`; null otherwise. */
export function safeColor(color: string | null | undefined): string | null {
  return color && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color.trim()) ? color.trim() : null;
}
