import { describe, expect, it } from 'vitest';
import type { PlanbarProjectOverview } from '../../planbar/types';
import { PLANBAR_PROJEKTE_DEFAULTS, type PlanbarProjekteSettings } from '../manifests/planbar-projekte';
import { hoursBudget, projectQuery, safeColor, sortProjects } from './projects';

const project = (id: string, patch: Partial<PlanbarProjectOverview> = {}): PlanbarProjectOverview => ({
  id,
  customerProjectId: null,
  title: `Projekt ${id}`,
  status: 'in_progress',
  statusLabel: 'In Bearbeitung',
  done: false,
  archived: false,
  priority: 'medium',
  priorityLabel: 'Mittel',
  isPinned: false,
  customer: null,
  startDate: null,
  deadline: null,
  deadlineDay: null,
  overdue: false,
  nextMilestone: null,
  progress: { done: 0, total: 0, percent: null },
  milestones: { done: 0, total: 0 },
  leader: null,
  responsible: null,
  teams: [],
  members: [],
  hours: { planned: null, estimated: null, tracked: 0, percent: null },
  url: `https://planbar.dev/tickets/${id}`,
  updatedAt: '2026-10-13T10:00:00.000Z',
  ...patch,
});

const settings = (patch: Partial<PlanbarProjekteSettings> = {}): PlanbarProjekteSettings => ({
  ...PLANBAR_PROJEKTE_DEFAULTS,
  ...patch,
});

describe('projectQuery', () => {
  it('asks for hand-picked projects in their order, whatever their status', () => {
    expect(projectQuery(settings({ auswahl: 'ausgewaehlt', projekte: ['p2', 'p1'] }))).toEqual({
      ids: ['p2', 'p1'],
      status: 'alle',
      pageSize: 2,
    });
    expect(projectQuery(settings({ auswahl: 'ausgewaehlt', projekte: [] }))).toBeNull();
  });

  it('lets planbar sort by deadline and limit, but loads everything for other orders', () => {
    expect(projectQuery(settings())).toEqual({ status: 'aktiv', pageSize: 6 });
    expect(projectQuery(settings({ sortierung: 'name', maxItems: 4 }))).toEqual({ status: 'aktiv', pageSize: 200 });
  });

  it('maps status «laufend» and the people filters', () => {
    expect(projectQuery(settings({ status: 'laufend', beteiligte: ['anna', 'beat'], leiter: 'beat' }))).toEqual({
      status: ['open', 'in_progress'],
      benutzer: ['anna', 'beat'],
      leiter: ['beat'],
      pageSize: 6,
    });
  });
});

describe('sortProjects', () => {
  const list = [
    project('none', { title: 'Zebra', progress: { done: 0, total: 0, percent: null } }),
    project('late', { title: 'Alpha', deadlineDay: '2026-10-20', progress: { done: 9, total: 10, percent: 90 } }),
    project('soon', { title: 'beta', deadlineDay: '2026-10-14', progress: { done: 1, total: 4, percent: 25 } }),
    project('pinned', { title: 'Gamma', isPinned: true, deadlineDay: '2026-12-01', progress: { done: 1, total: 4, percent: 25 } }),
    project('old', { title: 'Delta', updatedAt: '2026-01-01T00:00:00.000Z', progress: { done: 0, total: 2, percent: 0 } }),
  ];
  const order = (sortierung: PlanbarProjekteSettings['sortierung']) => sortProjects(list, sortierung).map((p) => p.id);

  it('sorts like planbar by deadline: pinned first, no deadline last, then recently updated', () => {
    expect(order('deadline')).toEqual(['pinned', 'soon', 'late', 'none', 'old']);
  });

  it('sorts by progress, least done first, projects without tasks last', () => {
    expect(order('fortschritt')).toEqual(['old', 'soon', 'pinned', 'late', 'none']);
  });

  it('sorts by name, ignoring case', () => {
    expect(order('name')).toEqual(['late', 'soon', 'old', 'pinned', 'none']);
  });

  it('leaves the input alone', () => {
    sortProjects(list, 'name');
    expect(list[0].id).toBe('none');
  });
});

describe('hoursBudget', () => {
  it('measures booked hours against planned hours, else the estimate', () => {
    expect(hoursBudget({ planned: 16, estimated: 30, tracked: 2, percent: 13 })).toEqual({
      tracked: 2,
      budget: 16,
      percent: 13,
      over: false,
    });
    expect(hoursBudget({ planned: null, estimated: 10, tracked: 12, percent: null })).toEqual({
      tracked: 12,
      budget: 10,
      percent: 120,
      over: true,
    });
    expect(hoursBudget({ planned: null, estimated: null, tracked: 3, percent: null })).toEqual({
      tracked: 3,
      budget: null,
      percent: null,
      over: false,
    });
    expect(hoursBudget({ planned: 0, estimated: null, tracked: 3, percent: null }).budget).toBeNull();
  });
});

describe('safeColor', () => {
  it('accepts hex colours only', () => {
    expect(safeColor('#123456')).toBe('#123456');
    expect(safeColor(' #f00 ')).toBe('#f00');
    expect(safeColor('red')).toBeNull();
    expect(safeColor('#12345')).toBeNull();
    expect(safeColor('url(x)')).toBeNull();
    expect(safeColor(null)).toBeNull();
  });
});
