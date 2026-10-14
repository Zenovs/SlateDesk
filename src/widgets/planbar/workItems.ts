/**
 * planbar's Arbeitsliste as the Aufgaben widget shows it: local tick-offs
 * applied, sorted like planbar, grouped by due day, person or project.
 * Days are Europe/Zurich calendar days (see ./days).
 */
import type { PlanbarPerson, PlanbarWorkItem } from '../../planbar/types';
import type { PlanbarGruppierung, PlanbarZeitraum } from '../manifests/planbar-aufgaben';
import type { ChangeMap } from './completion';
import { addDays, dayNumber, daysBetween, endOfWeek } from './days';

export type DueGroup = 'ueberfaellig' | 'heute' | 'morgen' | 'woche' | 'spaeter' | 'ohne' | 'erledigt';

export const DUE_GROUP_ORDER: readonly DueGroup[] = ['ueberfaellig', 'heute', 'morgen', 'woche', 'spaeter', 'ohne', 'erledigt'];

export const DUE_GROUP_LABELS: Readonly<Record<DueGroup, string>> = {
  ueberfaellig: 'Überfällig',
  heute: 'Heute',
  morgen: 'Morgen',
  woche: 'Diese Woche',
  spaeter: 'Später',
  ohne: 'Ohne Datum',
  erledigt: 'Erledigt',
};

/** Heading of entries whose people are not among the selected ones. */
export const OTHER_PEOPLE_LABEL = 'Weitere';

/** planbar's `bis` for the «Fällig» setting (week = Monday to Sunday); undefined = no limit. */
export function zeitraumBis(zeitraum: PlanbarZeitraum, today: string): string | undefined {
  switch (zeitraum) {
    case 'heute':
      return today;
    case 'woche':
      return endOfWeek(today);
    case 'zwei-wochen':
      return addDays(endOfWeek(today), 7);
    case 'alle':
      return undefined;
  }
}

export function dueGroupOf(dueDay: string | null, done: boolean, today: string): DueGroup {
  if (done) return 'erledigt';
  const diff = daysBetween(today, dueDay);
  if (diff === null) return 'ohne';
  if (diff < 0) return 'ueberfaellig';
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  const toSunday = daysBetween(today, endOfWeek(today)) ?? 0;
  return diff <= toSunday ? 'woche' : 'spaeter';
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

export interface WorkRow {
  item: PlanbarWorkItem;
  /** Shown as done – a tap counts at once. */
  done: boolean;
  /** Done state that decides the place: planbar's, until planbar confirmed a change. */
  placedDone: boolean;
  overdue: boolean;
  /** A change in its undo window or on the way to planbar. */
  pending: boolean;
  /** Ticked off while only open entries are shown: fades out until the next list drops it. */
  leaving: boolean;
}

/** Rows with the local changes applied, in planbar's order. */
export function buildRows(
  items: readonly PlanbarWorkItem[],
  changes: ChangeMap,
  today: string,
  onlyOpen: boolean,
): WorkRow[] {
  const rows = items.map((item): WorkRow => {
    const change = changes.get(item.id);
    const done = change ? change.completed : item.done;
    const confirmed = change?.phase === 'sent';
    const due = daysBetween(today, item.dueDay);
    return {
      item,
      done,
      // A row that fades out keeps its place; with done entries shown it moves to «Erledigt».
      placedDone: confirmed && !onlyOpen ? change.completed : item.done,
      overdue: !done && due !== null && due < 0,
      pending: change !== undefined && !confirmed,
      leaving: confirmed && onlyOpen && change.completed,
    };
  });
  return rows.sort((a, b) =>
    compareWorkItems({ ...a.item, done: a.placedDone }, { ...b.item, done: b.placedDone }),
  );
}

export interface WorkGroup {
  key: string;
  label: string;
  /** Second part of the heading, e.g. the customer of a project. */
  detail: string | null;
  /** Set when grouped by due day. */
  due: DueGroup | null;
  /** Set when grouped by person. */
  person: PlanbarPerson | null;
  rows: WorkRow[];
}

function dueGroups(rows: readonly WorkRow[], today: string): WorkGroup[] {
  const byGroup = new Map<DueGroup, WorkRow[]>();
  for (const row of rows) {
    const group = dueGroupOf(row.item.dueDay, row.placedDone, today);
    const list = byGroup.get(group);
    if (list) list.push(row);
    else byGroup.set(group, [row]);
  }
  return DUE_GROUP_ORDER.flatMap((due) => {
    const list = byGroup.get(due);
    return list ? [{ key: due, label: DUE_GROUP_LABELS[due], detail: null, due, person: null, rows: list }] : [];
  });
}

/**
 * One group per selected person, in the selected order. An entry shared by
 * several of them is listed under each – it is on each of their lists.
 */
function personGroups(rows: readonly WorkRow[], benutzer: readonly string[]): WorkGroup[] {
  const selected = new Set(benutzer);
  const groups = new Map<string, WorkGroup>();
  const others: WorkRow[] = [];
  for (const row of rows) {
    const people = row.item.assignees.length > 0 ? row.item.assignees : row.item.assignee ? [row.item.assignee] : [];
    const mine = people.filter((person) => selected.has(person.id));
    if (mine.length === 0) others.push(row);
    for (const person of mine) {
      const group = groups.get(person.id);
      if (group) group.rows.push(row);
      else {
        const label = person.name.trim() || 'Ohne Namen';
        groups.set(person.id, { key: `person:${person.id}`, label, detail: null, due: null, person, rows: [row] });
      }
    }
  }
  const ordered = benutzer.flatMap((id) => {
    const group = groups.get(id);
    return group ? [group] : [];
  });
  if (others.length > 0) {
    ordered.push({ key: 'person:weitere', label: OTHER_PEOPLE_LABEL, detail: null, due: null, person: null, rows: others });
  }
  return ordered;
}

/** One group per project; the project with the most urgent entry comes first. */
function projectGroups(rows: readonly WorkRow[]): WorkGroup[] {
  const groups = new Map<string, WorkGroup>();
  for (const row of rows) {
    const { project } = row.item;
    const group = groups.get(project.id);
    if (group) group.rows.push(row);
    else {
      groups.set(project.id, {
        key: `projekt:${project.id}`,
        label: project.name,
        detail: project.customer?.name ?? 'Intern',
        due: null,
        person: null,
        rows: [row],
      });
    }
  }
  return [...groups.values()];
}

export function groupRows(
  rows: readonly WorkRow[],
  gruppierung: PlanbarGruppierung,
  today: string,
  benutzer: readonly string[],
): WorkGroup[] {
  switch (gruppierung) {
    case 'faelligkeit':
      return dueGroups(rows, today);
    case 'person':
      return personGroups(rows, benutzer);
    case 'projekt':
      return projectGroups(rows);
  }
}
