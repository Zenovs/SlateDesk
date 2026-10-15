import { describe, expect, it } from 'vitest';
import type { PlanbarPerson, PlanbarProjectRef, PlanbarWorkItem } from '../../planbar/types';
import type { ChangeMap, LocalChange } from './completion';
import { zurichDay } from './days';
import { buildRows, compareWorkItems, dueGroupOf, groupRows, OTHER_ORGS_LABEL, OTHER_PEOPLE_LABEL, zeitraumBis } from './workItems';

const ANNA: PlanbarPerson = { id: 'anna', name: 'Anna Muster' };
const BEAT: PlanbarPerson = { id: 'beat', name: 'Beat Leiter' };
const CARLA: PlanbarPerson = { id: 'carla', name: 'carla@schnyder-werbung.ch' };

const WEBSITE: PlanbarProjectRef = {
  id: 'p-web',
  customerProjectId: 'cp-web',
  name: 'Website Relaunch',
  customer: { id: 'c-muster', name: 'Muster AG' },
};
const UMZUG: PlanbarProjectRef = { id: 'p-umzug', customerProjectId: null, name: 'Intern: Büroumzug', customer: null };

const item = (id: string, patch: Partial<PlanbarWorkItem> = {}): PlanbarWorkItem => ({
  type: 'aufgabe',
  id,
  title: `Aufgabe ${id}`,
  status: 'open',
  statusLabel: 'Offen',
  done: false,
  priority: 'medium',
  priorityLabel: 'Mittel',
  dueDate: null,
  dueDay: null,
  overdue: false,
  estimatedHours: null,
  assignee: ANNA,
  assignees: [ANNA],
  project: WEBSITE,
  parentTitle: WEBSITE.name,
  url: `https://planbar.dev/tickets/${WEBSITE.id}#subtask-${id}`,
  updatedAt: '2026-10-13T10:00:00.000Z',
  ...patch,
});

const change = (id: string, completed: boolean, phase: LocalChange['phase']): LocalChange => ({
  id,
  title: `Aufgabe ${id}`,
  completed,
  phase,
  startedAt: 0,
  sentAt: phase === 'sent' ? 1 : null,
  replaces: null,
});

const changes = (...list: LocalChange[]): ChangeMap => new Map(list.map((c) => [c.id, c]));
const ids = (rows: readonly { item: PlanbarWorkItem }[]): string[] => rows.map((row) => row.item.id);

// Tuesday
const TODAY = '2026-10-13';

describe('zeitraumBis', () => {
  it('maps the setting to planbar’s «bis» (week = Monday to Sunday)', () => {
    expect(zeitraumBis('heute', TODAY)).toBe('2026-10-13');
    expect(zeitraumBis('woche', TODAY)).toBe('2026-10-18');
    expect(zeitraumBis('zwei-wochen', TODAY)).toBe('2026-10-25');
    expect(zeitraumBis('alle', TODAY)).toBeUndefined();
  });

  it('keeps Sunday in its own week and crosses the year', () => {
    expect(zeitraumBis('woche', '2026-10-18')).toBe('2026-10-18');
    expect(zeitraumBis('zwei-wochen', '2026-10-18')).toBe('2026-10-25');
    expect(zeitraumBis('woche', '2026-12-29')).toBe('2027-01-03');
  });

  it('starts from the Zurich day, not the UTC day', () => {
    // Sunday 29 March 2026, 22:30 UTC = Monday 00:30 in Zurich (summer time began that night).
    const today = zurichDay(Date.parse('2026-03-29T22:30:00Z'));
    expect(today).toBe('2026-03-30');
    expect(zeitraumBis('woche', today)).toBe('2026-04-05');
    expect(zeitraumBis('heute', today)).toBe('2026-03-30');
  });
});

describe('dueGroupOf', () => {
  it('groups by Zurich calendar day relative to today', () => {
    expect(dueGroupOf('2026-10-12', false, TODAY)).toBe('ueberfaellig');
    expect(dueGroupOf('2026-10-13', false, TODAY)).toBe('heute');
    expect(dueGroupOf('2026-10-14', false, TODAY)).toBe('morgen');
    expect(dueGroupOf('2026-10-15', false, TODAY)).toBe('woche');
    expect(dueGroupOf('2026-10-18', false, TODAY)).toBe('woche');
    expect(dueGroupOf('2026-10-19', false, TODAY)).toBe('spaeter');
    expect(dueGroupOf(null, false, TODAY)).toBe('ohne');
    expect(dueGroupOf('kein Datum', false, TODAY)).toBe('ohne');
    expect(dueGroupOf('2026-10-12', true, TODAY)).toBe('erledigt');
  });

  it('has no «Diese Woche» left at the weekend', () => {
    expect(dueGroupOf('2026-10-18', false, '2026-10-17')).toBe('morgen');
    expect(dueGroupOf('2026-10-19', false, '2026-10-17')).toBe('spaeter');
    expect(dueGroupOf('2026-10-19', false, '2026-10-18')).toBe('morgen');
    expect(dueGroupOf('2026-10-20', false, '2026-10-18')).toBe('spaeter');
  });

  it('rolls over at Zurich midnight on the night summer time ends', () => {
    // 25 October 2026 has 25 hours: 22:30 UTC is still Sunday in Zurich, 23:00 UTC is Monday.
    const sunday = zurichDay(Date.parse('2026-10-25T22:30:00Z'));
    const monday = zurichDay(Date.parse('2026-10-25T23:00:00Z'));
    expect(dueGroupOf('2026-10-26', false, sunday)).toBe('morgen');
    expect(dueGroupOf('2026-10-26', false, monday)).toBe('heute');
    expect(dueGroupOf('2026-10-25', false, monday)).toBe('ueberfaellig');
    expect(dueGroupOf('2026-11-01', false, monday)).toBe('woche');
    expect(dueGroupOf('2026-11-02', false, monday)).toBe('spaeter');
  });
});

describe('compareWorkItems', () => {
  it('sorts like planbar: open, due day, priority, tasks first, recently updated', () => {
    const list = [
      item('done', { done: true, dueDay: '2026-10-01' }),
      item('no-date'),
      item('later', { dueDay: '2026-10-20' }),
      item('low', { dueDay: '2026-10-14', priority: 'low' }),
      item('unknown-priority', { dueDay: '2026-10-14', priority: null }),
      item('critical', { dueDay: '2026-10-14', priority: 'critical' }),
      item('project', { dueDay: '2026-10-14', priority: 'high', type: 'projekt' }),
      item('old-task', { dueDay: '2026-10-14', priority: 'high', updatedAt: '2026-10-01T08:00:00.000Z' }),
      item('new-task', { dueDay: '2026-10-14', priority: 'high', updatedAt: '2026-10-12T08:00:00.000Z' }),
      item('overdue', { dueDay: '2026-10-10' }),
    ];
    expect([...list].sort(compareWorkItems).map((i) => i.id)).toEqual([
      'overdue',
      'critical',
      'new-task',
      'old-task',
      'project',
      'low',
      'unknown-priority',
      'later',
      'no-date',
      'done',
    ]);
  });
});

describe('buildRows', () => {
  const list = [
    item('a', { dueDay: '2026-10-13' }),
    item('b', { dueDay: '2026-10-14' }),
    item('c', { dueDay: '2026-10-10', overdue: false }),
  ];

  it('marks overdue against today, not the (possibly stale) server flag', () => {
    const rows = buildRows(list, changes(), TODAY, true);
    expect(ids(rows)).toEqual(['c', 'a', 'b']);
    expect(rows[0].overdue).toBe(true);
    expect(rows[1].overdue).toBe(false);
  });

  it('shows a tap at once but keeps the row in place until planbar confirmed it', () => {
    const rows = buildRows(list, changes(change('c', true, 'waiting')), TODAY, true);
    expect(ids(rows)).toEqual(['c', 'a', 'b']);
    expect(rows[0]).toMatchObject({ done: true, placedDone: false, overdue: false, pending: true, leaving: false });

    const sending = buildRows(list, changes(change('c', true, 'sending')), TODAY, true);
    expect(sending[0]).toMatchObject({ done: true, pending: true, leaving: false });
  });

  it('lets a confirmed row fade out in place when only open entries are shown', () => {
    const rows = buildRows(list, changes(change('a', true, 'sent')), TODAY, true);
    expect(ids(rows)).toEqual(['c', 'a', 'b']);
    expect(rows[1]).toMatchObject({ done: true, placedDone: false, pending: false, leaving: true });
  });

  it('moves a confirmed row to the done entries when they are shown', () => {
    const rows = buildRows(list, changes(change('a', true, 'sent')), TODAY, false);
    expect(ids(rows)).toEqual(['c', 'b', 'a']);
    expect(rows[2]).toMatchObject({ done: true, placedDone: true, leaving: false });

    const reopened = buildRows([item('d', { done: true }), ...list], changes(change('d', false, 'sent')), TODAY, false);
    expect(reopened.find((row) => row.item.id === 'd')).toMatchObject({ done: false, placedDone: false });
  });
});

describe('groupRows', () => {
  it('groups by due day in a fixed order, skipping empty groups', () => {
    const rows = buildRows(
      [
        item('spaeter', { dueDay: '2026-10-30' }),
        item('heute', { dueDay: '2026-10-13' }),
        item('ohne'),
        item('ueber', { dueDay: '2026-10-01' }),
        item('erledigt', { done: true, dueDay: '2026-10-13' }),
      ],
      changes(),
      TODAY,
      false,
    );
    const groups = groupRows(rows, 'faelligkeit', TODAY, ['anna']);
    expect(groups.map((g) => [g.label, ids(g.rows)])).toEqual([
      ['Überfällig', ['ueber']],
      ['Heute', ['heute']],
      ['Später', ['spaeter']],
      ['Ohne Datum', ['ohne']],
      ['Erledigt', ['erledigt']],
    ]);
    expect(groups[0].due).toBe('ueberfaellig');
  });

  it('groups by the selected people in their order; shared entries appear under each', () => {
    const rows = buildRows(
      [
        item('anna-only', { dueDay: '2026-10-13' }),
        item('shared', { dueDay: '2026-10-14', assignee: BEAT, assignees: [BEAT, ANNA] }),
        item('carla', { dueDay: '2026-10-15', assignee: CARLA, assignees: [CARLA] }),
        item('nobody', { assignee: null, assignees: [] }),
      ],
      changes(),
      TODAY,
      true,
    );
    const groups = groupRows(rows, 'person', TODAY, ['beat', 'anna']);
    expect(groups.map((g) => [g.label, ids(g.rows)])).toEqual([
      ['Beat Leiter', ['shared']],
      ['Anna Muster', ['anna-only', 'shared']],
      [OTHER_PEOPLE_LABEL, ['carla', 'nobody']],
    ]);
    expect(groups[0].person).toEqual(BEAT);
  });

  it('groups by project, the most urgent project first', () => {
    const rows = buildRows(
      [
        item('web-later', { dueDay: '2026-10-20' }),
        item('umzug', { dueDay: '2026-10-14', project: UMZUG, parentTitle: UMZUG.name }),
        item('web-now', { dueDay: '2026-10-13' }),
      ],
      changes(),
      TODAY,
      true,
    );
    const groups = groupRows(rows, 'projekt', TODAY, ['anna']);
    expect(groups.map((g) => [g.label, g.detail, ids(g.rows)])).toEqual([
      ['Website Relaunch', 'Muster AG', ['web-now', 'web-later']],
      ['Intern: Büroumzug', 'Intern', ['umzug']],
    ]);
  });

  it('groups by Unternehmen in the order they were asked, planbar’s order within', () => {
    const wireon = { id: 'w1', name: 'wireon' };
    const sw = { id: 's1', name: 'Schnyder Werbung' };
    const rows = buildRows(
      [
        { ...item('w-later', { dueDay: '2026-10-20' }), org: wireon },
        { ...item('s-now', { dueDay: '2026-10-13' }), org: sw },
        { ...item('w-now', { dueDay: '2026-10-13' }), org: wireon },
        item('ohne-org'),
      ],
      changes(),
      TODAY,
      true,
    );
    const groups = groupRows(rows, 'unternehmen', TODAY, ['anna'], [wireon, sw]);
    expect(groups.map((g) => [g.label, ids(g.rows)])).toEqual([
      ['wireon', ['w-now', 'w-later']],
      ['Schnyder Werbung', ['s-now']],
      [OTHER_ORGS_LABEL, ['ohne-org']],
    ]);
    expect(groups[0].org).toEqual(wireon);
    expect(groups[0].key).not.toBe(groups[1].key);
  });
});
