/**
 * Several Unternehmen: which ones are asked, one request per Unternehmen with
 * its own header, merged answers tagged with their Unternehmen, and one
 * failing Unternehmen never hiding the others.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppState } from '../state/appState';
import { withDefaults } from '../state/defaults';
import { PlanbarError } from './client';
import {
  configuredOrgs,
  fetchArbeitslisteAll,
  fetchMitgliederAll,
  fetchNewsAll,
  fetchProjektuebersichtAll,
  fetchZeitZusammenfassungAll,
  planbarOrgEntries,
  resolveOrgs,
  UNNAMED_ORG,
} from './orgs';
import type { PlanbarOrgRef, PlanbarWorkItem } from './types';

const WIREON: PlanbarOrgRef = { id: 'w1', name: 'wireon' };
const SW: PlanbarOrgRef = { id: 's1', name: 'Schnyder Werbung' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-SlateDesk-Upstream': 'planbar' },
  });

/** What web.rs makes of Next's HTML 404 page of an old planbar. */
const missing = (): Response =>
  new Response('', { status: 404, headers: { 'Content-Type': 'text/plain', 'X-SlateDesk-Upstream': 'planbar' } });

type Route = (url: URL) => Response;
let answers: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

const item = (id: string, dueDay: string | null, extra: Partial<PlanbarWorkItem> = {}): PlanbarWorkItem =>
  ({
    type: 'aufgabe',
    id,
    title: id,
    status: 'open',
    statusLabel: 'Offen',
    done: false,
    priority: 'medium',
    priorityLabel: 'Mittel',
    dueDate: null,
    dueDay,
    overdue: false,
    estimatedHours: null,
    assignee: null,
    assignees: [],
    project: { id: 'p', customerProjectId: null, name: 'P', customer: null },
    parentTitle: null,
    url: 'https://planbar.dev',
    updatedAt: '2026-10-13T08:00:00Z',
    ...extra,
  }) as PlanbarWorkItem;

beforeEach(() => {
  answers = {};
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const org = (init?.headers as Record<string, string> | undefined)?.['X-SlateDesk-Planbar-Org'] ?? '';
    const route = answers[org];
    return route ? route(new URL(input, 'http://kiosk')) : json({ error: 'unbekannt' }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  useAppState.setState({ ready: true, state: withDefaults({ planbar: { enabled: true } }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Unternehmen of the settings', () => {
  const planbar = withDefaults({
    planbar: {
      unternehmen: {
        b: { name: 'Schnyder Werbung', apiKey: '__gesetzt__' },
        a: { name: 'wireon', apiKey: 'pk_live_x' },
        c: { name: '  ', apiKey: '' },
        d: { name: 'Altlast', apiKey: '' },
      },
    },
  }).planbar;

  it('lists every Unternehmen by name and the set-up ones for requests', () => {
    expect(planbarOrgEntries(planbar)).toEqual([
      { id: 'd', name: 'Altlast', hasKey: false },
      { id: 'b', name: 'Schnyder Werbung', hasKey: true },
      { id: 'c', name: UNNAMED_ORG, hasKey: false },
      { id: 'a', name: 'wireon', hasKey: true },
    ]);
    expect(configuredOrgs(planbar)).toEqual([
      { id: 'b', name: 'Schnyder Werbung' },
      { id: 'a', name: 'wireon' },
    ]);
  });

  it('resolves a selection: empty = all set up, gone or keyless ones are left out', () => {
    const configured = configuredOrgs(planbar);
    expect(resolveOrgs([], configured)).toEqual(configured);
    expect(resolveOrgs(['a'], configured)).toEqual([{ id: 'a', name: 'wireon' }]);
    expect(resolveOrgs(['a', 'c', 'weg'], configured)).toEqual([{ id: 'a', name: 'wireon' }]);
    expect(resolveOrgs(['weg'], configured)).toEqual([]);
  });
});

describe('fan-out over several Unternehmen', () => {
  it('asks each Unternehmen with its own header and merges the people', async () => {
    answers[WIREON.id] = () =>
      json({
        data: [
          { id: 'u1', name: 'Anna', email: 'a@x.ch', role: 'member', teams: [{ id: 't1', name: 'Grafik', color: '#f00' }] },
          { id: 'u2', name: 'Beat', email: 'b@x.ch', role: 'member' },
        ],
      });
    answers[SW.id] = () =>
      json({
        data: [
          { id: 'u1', name: '', email: 'a@x.ch', role: 'org_admin', teams: [{ id: 't9', name: 'Text', color: '#0f0' }] },
          { id: 'u3', name: 'Cara', email: 'c@x.ch', role: 'member', teams: [] },
        ],
      });

    const result = await fetchMitgliederAll([WIREON, SW]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([]);
    expect(result.data.map((m) => [m.id, m.name, m.orgs.map((o) => o.name), m.teams.map((t) => t.name)])).toEqual([
      ['u1', 'Anna', ['wireon', 'Schnyder Werbung'], ['Grafik', 'Text']],
      ['u2', 'Beat', ['wireon'], []],
      ['u3', 'Cara', ['Schnyder Werbung'], []],
    ]);
  });

  it('shows the others when one Unternehmen fails, and names the failing one', async () => {
    answers[WIREON.id] = () => missing();
    answers[SW.id] = () => json({ data: [{ id: 'u3', name: 'Cara', email: 'c@x.ch', role: 'member' }] });

    const result = await fetchMitgliederAll([WIREON, SW]);
    expect(result.data.map((m) => m.id)).toEqual(['u3']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].org).toEqual(WIREON);
    expect(result.failures[0].error.kind).toBe('endpointMissing');
    expect(result.failures[0].error.org).toEqual(WIREON);
  });

  it('rejects with the first error (marked with its Unternehmen) when all fail', async () => {
    answers[WIREON.id] = () => json({ error: 'API-Schlüssel wurde widerrufen' }, 401);
    answers[SW.id] = () => missing();
    const err = await fetchMitgliederAll([WIREON, SW]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanbarError);
    expect((err as PlanbarError).kind).toBe('unauthorized');
    expect((err as PlanbarError).org).toEqual(WIREON);

    const none = await fetchMitgliederAll([]).catch((e: unknown) => e);
    expect((none as PlanbarError).kind).toBe('notConfigured');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('merges the Arbeitsliste in planbar’s order within the limit', async () => {
    answers[WIREON.id] = (url) => {
      expect(url.searchParams.get('benutzer')).toBe('u1');
      return json({ data: [item('w-late', '2026-10-20'), item('shared', '2026-10-14')], total: 7, limit: 3, today: '2026-10-13' });
    };
    answers[SW.id] = () =>
      json({ data: [item('s-soon', '2026-10-12'), item('shared', '2026-10-14')], total: 2, limit: 3, today: '2026-10-14' });

    const result = await fetchArbeitslisteAll([WIREON, SW], { benutzer: ['u1'], limit: 3 });
    const list = result.data;
    expect(list.data.map((i) => [i.id, i.org.id])).toEqual([
      ['s-soon', 's1'],
      ['shared', 'w1'],
      ['w-late', 'w1'],
    ]);
    expect(list.total).toBe(9);
    expect(list.limit).toBe(3);
    expect(list.today).toBe('2026-10-14');
    expect(result.orgs).toEqual([WIREON, SW]);
  });

  it('keeps hand-picked projects of several Unternehmen in the picked order', async () => {
    const project = (id: string) => ({ id, customerProjectId: `c-${id}`, title: id, isPinned: false, deadlineDay: null });
    answers[WIREON.id] = () => json({ data: [project('p3'), project('p1')], page: 1, pageSize: 3, total: 2 });
    answers[SW.id] = () => json({ data: [project('p2')], page: 1, pageSize: 3, total: 1 });
    const result = await fetchProjektuebersichtAll([WIREON, SW], { ids: ['p2', 'c-p1', 'p3'], status: 'alle' });
    expect(result.data.data.map((p) => [p.id, p.org.name])).toEqual([
      ['p2', 'Schnyder Werbung'],
      ['p1', 'wireon'],
      ['p3', 'wireon'],
    ]);
    expect(result.data.total).toBe(3);
  });

  it('lists the newest news of all Unternehmen first', async () => {
    const post = (id: string, createdAt: string) => ({ id, title: id, createdAt });
    answers[WIREON.id] = () => json({ data: [post('w2', '2026-10-13T10:00:00Z'), post('w1', '2026-10-10T10:00:00Z')], total: 2, limit: 2 });
    answers[SW.id] = () => json({ data: [post('s1', '2026-10-12T10:00:00Z')], total: 5, limit: 2 });
    const result = await fetchNewsAll([WIREON, SW], { limit: 2 });
    expect(result.data.data.map((p) => [p.id, p.org.id])).toEqual([
      ['w2', 'w1'],
      ['s1', 's1'],
    ]);
    expect(result.data.total).toBe(7);
  });

  it('sums the booked time of a person working for several Unternehmen', async () => {
    const timer = { startedAt: '2026-10-13T07:00:00Z', elapsedMinutes: 60, label: 'X' };
    answers[WIREON.id] = () =>
      json({
        data: [{ user: { id: 'u1', name: 'Anna' }, todayMinutes: 60, weekMinutes: 300, weekDays: [240, 60, 0, 0, 0, 0, 0], timer: null }],
        today: '2026-10-14',
        weekStart: '2026-10-13',
      });
    answers[SW.id] = () =>
      json({
        data: [
          { user: { id: 'u1', name: 'Anna' }, todayMinutes: 30, weekMinutes: 90, weekDays: [60, 30, 0, 0, 0, 0, 0], timer },
          { user: { id: 'u2', name: 'Beat' }, todayMinutes: 10, weekMinutes: 10, weekDays: [0, 10, 0, 0, 0, 0, 0], timer: null },
        ],
        today: '2026-10-14',
        weekStart: '2026-10-13',
      });
    const result = await fetchZeitZusammenfassungAll([WIREON, SW], { benutzer: ['u1', 'u2'] });
    const anna = result.data.data.find((entry) => entry.user.id === 'u1');
    expect(anna).toMatchObject({ todayMinutes: 90, weekMinutes: 390, weekDays: [300, 90, 0, 0, 0, 0, 0], timer });
    expect(anna?.orgs).toEqual([WIREON, SW]);
    expect(result.data.data.find((entry) => entry.user.id === 'u2')?.orgs).toEqual([SW]);
    expect(result.data.today).toBe('2026-10-14');
  });

  it('passes a cancellation on instead of reporting it as failure', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_input: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Abgebrochen', 'AbortError')));
        }),
    );
    const pending = fetchNewsAll([WIREON, SW], {}, { signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
  });
});
