/**
 * planbar's Arbeitsliste as the Aufgaben widget shows it: local tick-offs
 * applied, sorted like planbar, grouped by due day, person, project or
 * Unternehmen. Days are Europe/Zurich calendar days (see ./days).
 */
import type { PlanbarOrgRef, PlanbarPerson, PlanbarWorkItem } from '../../planbar/types';
import type { PlanbarGruppierung, PlanbarZeitraum } from '../manifests/planbar-aufgaben';
import type { ChangeMap } from './completion';
import { compareWorkItems, priorityRank } from '../../planbar/order';
import { addDays, daysBetween, endOfWeek } from './days';

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

export { compareWorkItems, priorityRank };

/** An item of the Arbeitsliste; `org` = the Unternehmen it came from (several asked). */
export type WorkItem = PlanbarWorkItem & { org?: PlanbarOrgRef };

export interface WorkRow {
  item: WorkItem;
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
  items: readonly WorkItem[],
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
  /** Set when grouped by Unternehmen. */
  org?: PlanbarOrgRef | null;
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

/** Heading of entries without Unternehmen (not expected – every answer is tagged). */
export const OTHER_ORGS_LABEL = 'Ohne Unternehmen';

/** One group per Unternehmen, in the order they were asked; within, planbar's order. */
function orgGroups(rows: readonly WorkRow[], orgs: readonly PlanbarOrgRef[]): WorkGroup[] {
  const byOrg = new Map<string, WorkRow[]>();
  const others: WorkRow[] = [];
  for (const row of rows) {
    const id = row.item.org?.id;
    if (id === undefined) {
      others.push(row);
      continue;
    }
    const list = byOrg.get(id);
    if (list) list.push(row);
    else byOrg.set(id, [row]);
  }
  const known = new Map(orgs.map((org) => [org.id, org]));
  for (const row of rows) if (row.item.org && !known.has(row.item.org.id)) known.set(row.item.org.id, row.item.org);
  const groups = [...known.values()].flatMap((org): WorkGroup[] => {
    const list = byOrg.get(org.id);
    return list
      ? [{ key: `unternehmen:${org.id}`, label: org.name, detail: null, due: null, person: null, org, rows: list }]
      : [];
  });
  if (others.length > 0) {
    const label = OTHER_ORGS_LABEL;
    groups.push({ key: 'unternehmen:ohne', label, detail: null, due: null, person: null, org: null, rows: others });
  }
  return groups;
}

export function groupRows(
  rows: readonly WorkRow[],
  gruppierung: PlanbarGruppierung,
  today: string,
  benutzer: readonly string[],
  orgs: readonly PlanbarOrgRef[] = [],
): WorkGroup[] {
  switch (gruppierung) {
    case 'faelligkeit':
      return dueGroups(rows, today);
    case 'person':
      return personGroups(rows, benutzer);
    case 'projekt':
      return projectGroups(rows);
    case 'unternehmen':
      return orgGroups(rows, orgs);
  }
}
