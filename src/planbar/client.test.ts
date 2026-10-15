/**
 * planbar client against both transports: the web UI proxy (web.rs – planbar's
 * own answers marked with X-SlateDesk-Upstream) and the kiosk commands
 * (planbar.rs – German error strings). Both must end in the same PlanbarError.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppState } from '../state/appState';
import { withDefaults } from '../state/defaults';
import { completeItem, fetchArbeitsliste, fetchMitglieder, fetchProjektuebersicht, planbarErrorText, planbarGet, PlanbarError } from './client';
import { memberOptions } from './options';

const backend = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  planbarGet: vi.fn(),
  planbarPatch: vi.fn(),
}));

vi.mock('../utils/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/backend')>()),
  ...backend,
}));

const json = (body: unknown, status = 200, upstream = true): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(upstream ? { 'X-SlateDesk-Upstream': 'planbar' } : {}),
    },
  });

/** What web.rs makes of Next's HTML 404 page: status kept, body dropped. */
const droppedHtml = (status: number): Response =>
  new Response('', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-SlateDesk-Upstream': 'planbar' },
  });

let fetchMock: ReturnType<typeof vi.fn>;

const rejection = async (promise: Promise<unknown>): Promise<PlanbarError> => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PlanbarError);
  return err as PlanbarError;
};

const setPlanbar = (planbar: Record<string, unknown>): void => {
  useAppState.setState({ ready: true, state: withDefaults({ planbar }) });
};

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ data: [] }));
  vi.stubGlobal('fetch', fetchMock);
  backend.isTauri.mockReturnValue(false);
  setPlanbar({ enabled: true, apiKey: '__gesetzt__' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  backend.planbarGet.mockReset();
  backend.planbarPatch.mockReset();
});

describe('web UI (proxy)', () => {
  it('brings the members of a planbar without the SlateDesk extension into full shape (no teams)', async () => {
    // Exactly what production planbar answers before branch slatedesk-dashboard: no «teams», name may be null.
    fetchMock.mockResolvedValueOnce(
      json({
        data: [
          { id: 'u1', name: 'Anna Muster', email: 'anna@example.com', role: 'org_admin' },
          { id: 'u2', name: null, email: 'ben@example.com', role: 'member' },
          { name: 'ohne id' },
          { id: 'u3', name: 'Cara', email: 'c@example.com', role: 'member', teams: [{ id: 't1', name: 'Design', color: '#123456' }, null] },
        ],
      }),
    );
    const list = await fetchMitglieder();
    expect(list.data).toEqual([
      { id: 'u1', name: 'Anna Muster', email: 'anna@example.com', role: 'org_admin', teams: [] },
      { id: 'u2', name: '', email: 'ben@example.com', role: 'member', teams: [] },
      { id: 'u3', name: 'Cara', email: 'c@example.com', role: 'member', teams: [{ id: 't1', name: 'Design', color: '#123456' }] },
    ]);
    expect(memberOptions(list.data).map((o) => [o.label, o.hint])).toEqual([
      ['Anna Muster', undefined],
      ['ben@example.com', undefined],
      ['Cara', 'Design'],
    ]);
  });

  it('reads through /api/planbar with the session cookie and planbar list parameters', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [], total: 0, limit: 5, today: '2026-10-13' }));
    const list = await fetchArbeitsliste({ benutzer: ['u1', ' ', 'u2'], typ: 'aufgabe', limit: 5, bis: '' });

    expect(list.today).toBe('2026-10-13');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/planbar/arbeitsliste?benutzer=u1%2Cu2&typ=aufgabe&limit=5');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBeUndefined();
  });

  it('sends a project status list comma-separated', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [], page: 1, pageSize: 50, total: 0 }));
    await fetchProjektuebersicht({ status: ['open', 'in_progress'], ids: [], q: '  ' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/planbar/projektuebersicht?status=open%2Cin_progress');
  });

  it('ticks off a task with PATCH, JSON body and the CSRF header', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { id: 'a1', done: true }, nextInstanceId: 'a2' }));
    const result = await completeItem('a1');

    expect(result.nextInstanceId).toBe('a2');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/planbar/arbeitsliste/a1');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({ 'X-SlateDesk': '1', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ completed: true });
  });

  it('rejects bad ids, paths and empty people lists without a request', async () => {
    expect((await rejection(completeItem('../tickets'))).kind).toBe('invalidRequest');
    expect((await rejection(planbarGet('/api/v1/news?limit=1'))).kind).toBe('invalidRequest');
    expect((await rejection(planbarGet('/api/v2/news'))).kind).toBe('invalidRequest');
    expect((await rejection(fetchArbeitsliste({ benutzer: ['', ' '] }))).kind).toBe('invalidRequest');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads an HTML 404 from planbar as «planbar-Update nötig»', async () => {
    fetchMock.mockResolvedValueOnce(droppedHtml(404));
    const err = await rejection(planbarGet('/api/v1/arbeitsliste', { benutzer: 'u1' }));
    expect(err.kind).toBe('endpointMissing');
    expect(err.endpointMissing).toBe(true);
    expect(err.status).toBe(404);
    expect(err.message).toBe('planbar: Endpunkt fehlt (404) – planbar-Update nötig');
    expect(planbarErrorText(err)).toBe('planbar-Update nötig');
  });

  it('reads a JSON 404 as «nicht gefunden»', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Aufgabe nicht gefunden' }, 404));
    const err = await rejection(completeItem('weg'));
    expect(err.kind).toBe('notFound');
    expect(err.endpointMissing).toBe(false);
    expect(err.message).toBe('planbar: nicht gefunden – Aufgabe nicht gefunden');
  });

  it('keeps planbar 401 and 403 apart from the web UI session', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'API-Schlüssel wurde widerrufen' }, 401));
    const revoked = await rejection(planbarGet('/api/v1/mitglieder'));
    expect(revoked.kind).toBe('unauthorized');
    expect(revoked.status).toBe(401);
    expect(revoked.message).toBe('planbar: API-Schlüssel ungültig (401) – API-Schlüssel wurde widerrufen');

    fetchMock.mockResolvedValueOnce(json({ error: 'Fehlende Berechtigung: aufgaben:write' }, 403));
    const denied = await rejection(completeItem('a1'));
    expect(denied.kind).toBe('forbidden');
    expect(denied.message).toBe('planbar: Berechtigung fehlt – Fehlende Berechtigung: aufgaben:write');
    expect(planbarErrorText(denied)).toBe(denied.message);

    fetchMock.mockResolvedValueOnce(droppedHtml(403));
    expect((await rejection(planbarGet('/api/v1/news'))).message).toBe('planbar: Berechtigung fehlt (403)');

    // Without the upstream marker the 401 is SlateDesk's own: the session is gone.
    fetchMock.mockResolvedValueOnce(json({ error: 'Nicht angemeldet' }, 401, false));
    const session = await rejection(planbarGet('/api/v1/mitglieder'));
    expect(session.kind).toBe('sessionExpired');
    expect(session.message).toBe('Nicht angemeldet');
  });

  it('maps the server’s own errors by their text', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'planbar ist nicht eingerichtet' }, 503, false));
    const missing = await rejection(planbarGet('/api/v1/mitglieder'));
    expect(missing.kind).toBe('notConfigured');
    expect(planbarErrorText(missing)).toBe('planbar in der Fernsteuerung unter «planbar» einrichten');

    fetchMock.mockResolvedValueOnce(
      json({ error: 'planbar: Ändern ist nur für Aufgaben der Arbeitsliste erlaubt' }, 400, false),
    );
    expect((await rejection(completeItem('a1'))).kind).toBe('invalidRequest');

    fetchMock.mockResolvedValueOnce(json({ error: 'planbar nicht erreichbar: Zeitüberschreitung' }, 502, false));
    expect((await rejection(planbarGet('/api/v1/news'))).kind).toBe('unreachable');

    fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    const proxy = await rejection(planbarGet('/api/v1/news'));
    expect(proxy.kind).toBe('unreachable');
    expect(proxy.status).toBe(502);
  });

  it('treats planbar’s 5xx as unreachable and other statuses as plain errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Interner Serverfehler' }, 500));
    const down = await rejection(planbarGet('/api/v1/news'));
    expect(down.kind).toBe('unreachable');
    expect(down.message).toBe('planbar: Fehler 500 – Interner Serverfehler');

    fetchMock.mockResolvedValueOnce(json({ error: 'Höchstens 50 Werte in "benutzer"' }, 400));
    const bad = await rejection(planbarGet('/api/v1/arbeitsliste', { benutzer: 'u1' }));
    expect(bad.kind).toBe('http');
    expect(bad.message).toBe('planbar: Fehler 400 – Höchstens 50 Werte in "benutzer"');
  });

  it('reports a lost connection and an answer that is no JSON', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const offline = await rejection(planbarGet('/api/v1/news'));
    expect(offline.kind).toBe('unreachable');
    expect(offline.message).toBe('Kiosk nicht erreichbar – Netzwerkverbindung prüfen');

    fetchMock.mockResolvedValueOnce(droppedHtml(200));
    expect((await rejection(planbarGet('/api/v1/news'))).kind).toBe('invalidResponse');
  });

  it('passes an abort through unchanged', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Abgebrochen', 'AbortError');
    });
    const err = await planbarGet('/api/v1/news', undefined, { signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('does not call planbar while it is switched off', async () => {
    setPlanbar({ enabled: false, apiKey: '__gesetzt__' });
    const err = await rejection(planbarGet('/api/v1/mitglieder'));
    expect(err.kind).toBe('disabled');
    expect(planbarErrorText(err)).toBe('planbar in der Fernsteuerung unter «planbar» einrichten');
    expect(fetchMock).not.toHaveBeenCalled();

    await planbarGet('/api/v1/mitglieder', undefined, { ignoreDisabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('kiosk (Rust commands)', () => {
  beforeEach(() => {
    backend.isTauri.mockReturnValue(true);
  });

  it('calls the commands with cleaned parameters', async () => {
    backend.planbarGet.mockResolvedValueOnce({ data: [] });
    backend.planbarPatch.mockResolvedValueOnce({ data: { id: 'a1' }, nextInstanceId: null });

    await fetchArbeitsliste({ benutzer: ['u1', 'u2'], projekte: [], status: 'alle' });
    expect(backend.planbarGet).toHaveBeenCalledWith('/api/v1/arbeitsliste', { benutzer: 'u1,u2', status: 'alle' });
    await completeItem('a1', false);
    expect(backend.planbarPatch).toHaveBeenCalledWith('/api/v1/arbeitsliste/a1', { completed: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['planbar ist nicht eingerichtet', 'notConfigured', 0],
    ['planbar: Endpunkt fehlt (404) – planbar-Update nötig', 'endpointMissing', 404],
    ['planbar: API-Schlüssel ungültig (401) – API-Schlüssel ist abgelaufen', 'unauthorized', 401],
    ['planbar: Berechtigung fehlt – Fehlende Berechtigung: news:read', 'forbidden', 403],
    ['planbar: Berechtigung fehlt (403)', 'forbidden', 403],
    ['planbar: nicht gefunden – Aufgabe nicht gefunden', 'notFound', 404],
    ['planbar nicht erreichbar: Zeitüberschreitung', 'unreachable', 0],
    ['planbar: Fehler 500 – Interner Serverfehler', 'unreachable', 500],
    ['planbar: Fehler 400 – Ungültiger Wert für "typ"', 'http', 400],
    ['planbar: ungültige Änderung (erwartet { "completed": true oder false })', 'invalidRequest', 400],
    ['planbar: ungültige Antwort (kein JSON)', 'invalidResponse', 0],
  ] as const)('maps «%s» to %s', async (message, kind, status) => {
    backend.planbarGet.mockRejectedValueOnce(new Error(message));
    const err = await rejection(planbarGet('/api/v1/news'));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
  });

  it('stops waiting for an aborted command', async () => {
    backend.planbarGet.mockReturnValueOnce(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = planbarGet('/api/v1/news', undefined, { signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
  });
});
