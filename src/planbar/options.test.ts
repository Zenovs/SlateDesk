/** planbar pickers: labels, hints, grouping and the paged project load. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviderSnapshot, hasOptionProvider, loadProviderOptions } from '../components/settings/optionProviders';
import { useAppState } from '../state/appState';
import { withDefaults } from '../state/defaults';
import { widgetCatalog } from '../widgets/catalog';
import {
  INACTIVE_PROJECTS_GROUP,
  INTERNAL_PROJECTS_GROUP,
  memberOptions,
  PLANBAR_MEMBERS_PROVIDER,
  PLANBAR_ORG_SETTING,
  PLANBAR_ORGS_PROVIDER,
  PLANBAR_PROJECT_SETTINGS,
  PLANBAR_PROJECTS_PROVIDER,
  projectOptions,
  storedProjectIds,
} from './options';
import type { PlanbarMember, PlanbarProjectOverview } from './types';

/** One Unternehmen with a key (the web UI sees it as «gesetzt»). */
const ONE_ORG = { a: { name: 'Büro', apiKey: '__gesetzt__' } };
const TWO_ORGS = {
  w1: { name: 'wireon', apiKey: '__gesetzt__' },
  s1: { name: 'Schnyder Werbung', apiKey: '__gesetzt__' },
  n1: { name: 'Neu', apiKey: '' },
};

const member = (id: string, name: string, teams: string[] = []): PlanbarMember => ({
  id,
  name,
  email: `${id}@example.ch`,
  role: 'member',
  teams: teams.map((team, i) => ({ id: `t${i}`, name: team, color: '#ff0000' })),
});

const project = (id: string, title: string, customer: string | null, statusLabel = 'Offen'): PlanbarProjectOverview =>
  ({
    id,
    title,
    statusLabel,
    customer: customer === null ? null : { id: `c-${customer}`, name: customer, color: '#123456' },
  }) as PlanbarProjectOverview;

const finished = (id: string, title: string, customer: string | null, archived = false): PlanbarProjectOverview => ({
  ...project(id, title, customer, 'Erledigt'),
  done: true,
  archived,
});

/** Dashboard with planbar widgets and their stored settings. */
function dashboard(widgets: { widgetId: string; settings: Record<string, unknown> }[]) {
  return withDefaults({
    planbar: { enabled: true, unternehmen: ONE_ORG },
    layout: {
      widgets: widgets.map((widget, i) => ({ instanceId: `w${i}`, widgetId: widget.widgetId, x: 0, y: i * 2, w: 4, h: 2 })),
    },
    widgetSettings: Object.fromEntries(widgets.map((widget, i) => [`w${i}`, widget.settings])),
  });
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'X-SlateDesk-Upstream': 'planbar' },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  useAppState.setState({ ready: true, state: withDefaults({ planbar: { enabled: true, unternehmen: ONE_ORG } }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('planbar option providers', () => {
  it('are registered by importing the module', () => {
    expect(hasOptionProvider(PLANBAR_ORGS_PROVIDER)).toBe(true);
    expect(hasOptionProvider(PLANBAR_MEMBERS_PROVIDER)).toBe(true);
    expect(hasOptionProvider(PLANBAR_PROJECTS_PROVIDER)).toBe(true);
  });

  it('list people by name (e-mail when planbar has none) with their teams', () => {
    expect(memberOptions([member('u2', 'Beat'), member('u3', '  '), member('u1', 'Änni', ['Grafik', 'Text'])])).toEqual([
      { value: 'u1', label: 'Änni', hint: 'Grafik, Text' },
      { value: 'u2', label: 'Beat' },
      { value: 'u3', label: 'u3@example.ch' },
    ]);
  });

  it('group projects by customer, internal ones last', () => {
    const options = projectOptions([
      project('p1', 'Website', 'Muster AG', 'In Bearbeitung'),
      project('p2', 'Umzug', null),
      project('p3', 'Bericht', 'Alpha GmbH'),
      project('p4', 'Logo', 'Muster AG'),
    ]);
    expect(options.map((o) => [o.group, o.label])).toEqual([
      ['Alpha GmbH', 'Bericht'],
      ['Muster AG', 'Logo'],
      ['Muster AG', 'Website'],
      [INTERNAL_PROJECTS_GROUP, 'Umzug'],
    ]);
    expect(options.find((o) => o.value === 'p1')?.hint).toBe('In Bearbeitung');
  });

  it('load active projects page by page', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => project(`a${i}`, `Projekt ${i}`, 'Kunde'));
    fetchMock
      .mockResolvedValueOnce(json({ data: page1, page: 1, pageSize: 200, total: 201 }))
      .mockResolvedValueOnce(json({ data: [project('z', 'Zuletzt', null)], page: 2, pageSize: 200, total: 201 }));

    const options = await loadProviderOptions(PLANBAR_PROJECTS_PROVIDER, true);
    expect(options).toHaveLength(201);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/planbar/projektuebersicht?status=aktiv&page=1&pageSize=200',
      '/api/planbar/projektuebersicht?status=aktiv&page=2&pageSize=200',
    ]);
  });

  it('list picked projects that are no longer active under «Nicht mehr aktiv»', () => {
    const options = projectOptions(
      [project('p1', 'Website', 'Muster AG'), project('p2', 'Umzug', null)],
      [finished('p9', 'Relaunch', 'Muster AG'), finished('p8', 'Archiv-Altlast', null, true)],
    );
    expect(options.map((o) => [o.group, o.label, o.hint])).toEqual([
      ['Muster AG', 'Website', 'Offen'],
      [INTERNAL_PROJECTS_GROUP, 'Umzug', 'Offen'],
      [INACTIVE_PROJECTS_GROUP, 'Archiv-Altlast', 'Archiviert'],
      [INACTIVE_PROJECTS_GROUP, 'Relaunch', 'Muster AG · Erledigt'],
    ]);
  });

  it('read the project ids stored in planbar widgets, each once', () => {
    const state = dashboard([
      { widgetId: 'planbar-projekte', settings: { auswahl: 'ausgewaehlt', projekte: ['p1', 'p9'] } },
      { widgetId: 'planbar-aufgaben', settings: { projekte: ['p9', 'p7', '', 42] } },
      { widgetId: 'todo', settings: { projekte: ['fremd'] } },
    ]);
    expect(storedProjectIds(state)).toEqual(['p1', 'p9', 'p7']);
  });

  it('know every settings field that stores picked projects', () => {
    const fields: [string, string][] = [];
    for (const manifest of widgetCatalog) {
      for (const field of manifest.settingsSchema ?? []) {
        if ((field.type === 'select' || field.type === 'multiselect') && field.optionsProvider === PLANBAR_PROJECTS_PROVIDER) {
          fields.push([manifest.id, field.key]);
        }
      }
    }
    expect(new Map(fields)).toEqual(PLANBAR_PROJECT_SETTINGS);
  });

  it('resolve stored projects that left the active list', async () => {
    useAppState.setState({
      state: dashboard([{ widgetId: 'planbar-projekte', settings: { auswahl: 'ausgewaehlt', projekte: ['p1', 'p9', 'weg'] } }]),
    });
    fetchMock
      .mockResolvedValueOnce(json({ data: [project('p1', 'Website', 'Muster AG')], page: 1, pageSize: 200, total: 1 }))
      .mockResolvedValueOnce(json({ data: [finished('p9', 'Relaunch', 'Muster AG')], page: 1, pageSize: 2, total: 1 }));

    const options = await loadProviderOptions(PLANBAR_PROJECTS_PROVIDER, true);
    expect(options.map((o) => [o.value, o.group])).toEqual([
      ['p1', 'Muster AG'],
      ['p9', INACTIVE_PROJECTS_GROUP],
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/planbar/projektuebersicht?status=aktiv&page=1&pageSize=200',
      '/api/planbar/projektuebersicht?ids=p9%2Cweg&status=alle&pageSize=2',
    ]);
  });

  it('keep the active list when stored projects cannot be looked up', async () => {
    useAppState.setState({ state: dashboard([{ widgetId: 'planbar-aufgaben', settings: { projekte: ['p9'] } }]) });
    fetchMock
      .mockResolvedValueOnce(json({ data: [project('p1', 'Website', 'Muster AG')], page: 1, pageSize: 200, total: 1 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const options = await loadProviderOptions(PLANBAR_PROJECTS_PROVIDER, true);
    expect(options.map((o) => o.value)).toEqual(['p1']);
  });

  it('do not look anything up when every stored project is active', async () => {
    useAppState.setState({ state: dashboard([{ widgetId: 'planbar-aufgaben', settings: { projekte: ['p1'] } }]) });
    fetchMock.mockResolvedValueOnce(json({ data: [project('p1', 'Website', 'Muster AG')], page: 1, pageSize: 200, total: 1 }));

    await loadProviderOptions(PLANBAR_PROJECTS_PROVIDER, true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keep planbar’s error for the form', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Fehlende Berechtigung: kunden:read oder aufgaben:read oder projekte:read' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'X-SlateDesk-Upstream': 'planbar' },
      }),
    );
    await expect(loadProviderOptions(PLANBAR_MEMBERS_PROVIDER, true)).rejects.toThrow('Berechtigung fehlt');
    expect(getProviderSnapshot(PLANBAR_MEMBERS_PROVIDER).error).toBe(
      'planbar: Berechtigung fehlt – Fehlende Berechtigung: kunden:read oder aufgaben:read oder projekte:read',
    );
  });

  it('say where to switch planbar on', async () => {
    useAppState.setState({ state: withDefaults({ planbar: { enabled: false, unternehmen: ONE_ORG } }) });
    await expect(loadProviderOptions(PLANBAR_PROJECTS_PROVIDER, true)).rejects.toThrow('einschalten');
    expect(getProviderSnapshot(PLANBAR_PROJECTS_PROVIDER).error).toBe(
      'planbar ist ausgeschaltet – in der Fernsteuerung unter «planbar» einschalten',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('list the Unternehmen of the settings without asking planbar', async () => {
    useAppState.setState({ state: withDefaults({ planbar: { enabled: true, unternehmen: TWO_ORGS } }) });
    expect(await loadProviderOptions(PLANBAR_ORGS_PROVIDER, true)).toEqual([
      { value: 'n1', label: 'Neu', hint: 'API-Schlüssel fehlt' },
      { value: 's1', label: 'Schnyder Werbung' },
      { value: 'w1', label: 'wireon' },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    useAppState.setState({ state: withDefaults({ planbar: { enabled: true } }) });
    expect(await loadProviderOptions(PLANBAR_ORGS_PROVIDER, true)).toEqual([]);
    expect(getProviderSnapshot(PLANBAR_ORGS_PROVIDER).warning).toContain('Noch kein Unternehmen');
  });

  it('list the people of the selected Unternehmen – their Unternehmen in the hint when several are asked', async () => {
    useAppState.setState({ state: withDefaults({ planbar: { enabled: true, unternehmen: TWO_ORGS } }) });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const org = (init?.headers as Record<string, string>)['X-SlateDesk-Planbar-Org'];
      if (org === 'w1') return json({ data: [{ id: 'u1', name: 'Anna', email: 'a@x.ch', role: 'member', teams: [{ id: 't', name: 'Grafik', color: '#f00' }] }] });
      return json({ data: [{ id: 'u1', name: 'Anna', email: 'a@x.ch', role: 'member' }, { id: 'u2', name: 'Beat', email: 'b@x.ch', role: 'member' }] });
    });

    const all = await loadProviderOptions(PLANBAR_MEMBERS_PROVIDER, true, { [PLANBAR_ORG_SETTING]: [] });
    expect(all).toEqual([
      { value: 'u1', label: 'Anna', hint: 'Schnyder Werbung, wireon · Grafik' },
      { value: 'u2', label: 'Beat', hint: 'Schnyder Werbung' },
    ]);
    // Keyless Unternehmen are never asked.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const wireon = await loadProviderOptions(PLANBAR_MEMBERS_PROVIDER, false, { [PLANBAR_ORG_SETTING]: ['w1'] });
    expect(wireon).toEqual([{ value: 'u1', label: 'Anna', hint: 'Grafik' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Each selection is cached on its own.
    await loadProviderOptions(PLANBAR_MEMBERS_PROVIDER, false, { [PLANBAR_ORG_SETTING]: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await expect(loadProviderOptions(PLANBAR_MEMBERS_PROVIDER, true, { [PLANBAR_ORG_SETTING]: ['n1'] })).rejects.toThrow(
      'nicht eingerichtet',
    );
  });

  it('note an Unternehmen that did not answer and name it when all fail', async () => {
    useAppState.setState({ state: withDefaults({ planbar: { enabled: true, unternehmen: TWO_ORGS } }) });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const org = (init?.headers as Record<string, string>)['X-SlateDesk-Planbar-Org'];
      if (org === 'w1') return new Response('', { status: 404, headers: { 'X-SlateDesk-Upstream': 'planbar' } });
      return json({ data: [{ id: 'u2', name: 'Beat', email: 'b@x.ch', role: 'member' }] });
    });
    await loadProviderOptions(PLANBAR_MEMBERS_PROVIDER, true, { [PLANBAR_ORG_SETTING]: [] });
    expect(getProviderSnapshot(PLANBAR_MEMBERS_PROVIDER, { [PLANBAR_ORG_SETTING]: [] }).warning).toBe(
      'Unvollständig – wireon: planbar-Update nötig',
    );

    fetchMock.mockImplementation(async () => new Response('', { status: 404, headers: { 'X-SlateDesk-Upstream': 'planbar' } }));
    await expect(loadProviderOptions(PLANBAR_MEMBERS_PROVIDER, true, { [PLANBAR_ORG_SETTING]: ['w1'] })).rejects.toThrow(
      'wireon: planbar: Endpunkt fehlt',
    );
  });

  it('group the projects of several Unternehmen by «Unternehmen · Kunde»', async () => {
    useAppState.setState({ state: withDefaults({ planbar: { enabled: true, unternehmen: TWO_ORGS } }) });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const org = (init?.headers as Record<string, string>)['X-SlateDesk-Planbar-Org'];
      const data = org === 'w1' ? [project('p1', 'Shop', 'Muster AG'), project('p2', 'Server', null)] : [project('p3', 'Flyer', 'Muster AG')];
      return json({ data, page: 1, pageSize: 200, total: data.length });
    });
    const options = await loadProviderOptions(PLANBAR_PROJECTS_PROVIDER, true, { [PLANBAR_ORG_SETTING]: [] });
    expect(options.map((o) => [o.group, o.label])).toEqual([
      ['Schnyder Werbung · Muster AG', 'Flyer'],
      ['wireon · Muster AG', 'Shop'],
      [`wireon · ${INTERNAL_PROJECTS_GROUP}`, 'Server'],
    ]);
    // One Unternehmen chosen: groups as before.
    const one = await loadProviderOptions(PLANBAR_PROJECTS_PROVIDER, true, { [PLANBAR_ORG_SETTING]: ['s1'] });
    expect(one.map((o) => o.group)).toEqual(['Muster AG']);
  });

  it('load again after the Unternehmen changed', async () => {
    useAppState.setState({ state: withDefaults({ planbar: { enabled: true, unternehmen: ONE_ORG } }) });
    await loadProviderOptions(PLANBAR_ORGS_PROVIDER);
    expect(getProviderSnapshot(PLANBAR_ORGS_PROVIDER).loadedAt).toBeGreaterThan(0);
    useAppState.setState({ state: withDefaults({ planbar: { enabled: true, unternehmen: TWO_ORGS } }) });
    expect(getProviderSnapshot(PLANBAR_ORGS_PROVIDER).loadedAt).toBe(0);
    expect((await loadProviderOptions(PLANBAR_ORGS_PROVIDER)).map((o) => o.value)).toEqual(['n1', 's1', 'w1']);
  });
});
