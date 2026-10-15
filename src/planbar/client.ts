/**
 * planbar client – same API in kiosk and web UI.
 *
 * Kiosk: Rust commands `planbar_get` / `planbar_patch` (the API key stays in
 * Rust, no CORS issues). Web UI: the SlateDesk server's proxy `/api/planbar/…`
 * (session cookie; the key never reaches the browser). planbar's own answers
 * come back marked with `X-SlateDesk-Upstream: planbar` – their `{ error }`
 * and 401 are planbar's, not the web UI session's.
 * All failures reject with a PlanbarError carrying a German message.
 */
import { useAppState } from '../state/appState';
import { httpStatusMessage, isAbortError } from '../state/transport';
import { isTauri, planbarGet as backendPlanbarGet, planbarPatch as backendPlanbarPatch } from '../utils/backend';
import type {
  PlanbarMember,
  PlanbarMemberList,
  PlanbarNewsList,
  PlanbarNewsQuery,
  PlanbarProjectPage,
  PlanbarProjectQuery,
  PlanbarTeam,
  PlanbarTimeQuery,
  PlanbarTimeSummary,
  PlanbarWorkItemPatchResult,
  PlanbarWorkList,
  PlanbarWorkListQuery,
} from './types';

const API_PREFIX = '/api/v1/';
const PROXY_PREFIX = '/api/planbar/';
export const UPSTREAM_HEADER = 'X-SlateDesk-Upstream';
const WORK_ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PlanbarErrorKind =
  /** No API key configured on the kiosk. */
  | 'notConfigured'
  /** Switched off in the settings. */
  | 'disabled'
  /** planbar rejected the key (missing, revoked, expired). */
  | 'unauthorized'
  /** The key lacks a right – the message names it. */
  | 'forbidden'
  /** planbar lacks the endpoint – planbar needs its SlateDesk update. */
  | 'endpointMissing'
  /** The route exists, the item does not (e.g. a deleted task). */
  | 'notFound'
  /** planbar (or the kiosk, from the web UI) did not answer. */
  | 'unreachable'
  /** Web UI session expired – log in again. */
  | 'sessionExpired'
  | 'invalidRequest'
  | 'invalidResponse'
  | 'http';

/** Same texts as the Rust side (src-tauri/src/planbar.rs), so kiosk and web UI read alike. */
const PLANBAR_MESSAGES = {
  notConfigured: 'planbar ist nicht eingerichtet',
  disabled: 'planbar ist ausgeschaltet',
  unauthorized: 'planbar: API-Schlüssel ungültig (401)',
  forbidden: 'planbar: Berechtigung fehlt',
  endpointMissing: 'planbar: Endpunkt fehlt (404) – planbar-Update nötig',
  notFound: 'planbar: nicht gefunden',
  unreachable: 'planbar nicht erreichbar',
} as const;

export class PlanbarError extends Error {
  /** HTTP status if known, 0 otherwise. */
  readonly status: number;
  readonly kind: PlanbarErrorKind;

  constructor(status: number, message: string, kind: PlanbarErrorKind = 'http') {
    super(message);
    this.name = 'PlanbarError';
    this.status = status;
    this.kind = kind;
  }

  /** planbar is too old for SlateDesk (show «planbar-Update nötig»). */
  get endpointMissing(): boolean {
    return this.kind === 'endpointMissing';
  }
}

export const isPlanbarEndpointMissing = (err: unknown): boolean =>
  err instanceof PlanbarError && err.kind === 'endpointMissing';

/**
 * Short German text for a widget: what to do instead of a technical error.
 * Not set up / switched off and «Update nötig» get fixed hints, everything
 * else keeps its message (a missing right names the right).
 */
export function planbarErrorText(err: unknown): string {
  if (err instanceof PlanbarError) {
    if (err.kind === 'notConfigured' || err.kind === 'disabled') {
      return 'planbar in der Fernsteuerung unter «planbar» einrichten';
    }
    if (err.kind === 'endpointMissing') return 'planbar-Update nötig';
    return err.message;
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  return 'Unbekannter Fehler';
}

/** Maps the backend's German error texts (kiosk command or proxy `{ error }`) to a PlanbarError. */
function classify(message: string, status: number | null): PlanbarError {
  const text = message.trim() || PLANBAR_MESSAGES.unreachable;
  const lower = text.toLowerCase();
  // Rust writes «… (401)» for known cases and «planbar: Fehler 500 – …» for any other status.
  const match = /\((\d{3})\)|Fehler (\d{3})\b/.exec(text);
  const code = status ?? Number(match?.[1] ?? match?.[2] ?? 0);
  if (lower.includes('nicht eingerichtet')) return new PlanbarError(code, text, 'notConfigured');
  if (lower.includes('endpunkt fehlt')) return new PlanbarError(404, text, 'endpointMissing');
  if (lower.includes('api-schlüssel ungültig')) return new PlanbarError(401, text, 'unauthorized');
  if (lower.includes('berechtigung fehlt')) return new PlanbarError(403, text, 'forbidden');
  if (lower.startsWith(PLANBAR_MESSAGES.notFound)) return new PlanbarError(404, text, 'notFound');
  // 5xx counts as «nicht erreichbar» – same as planbar's own 5xx in the web UI path.
  if (lower.includes('nicht erreichbar') || lower.includes('zeitüberschreitung') || code >= 500) {
    return new PlanbarError(code, text, 'unreachable');
  }
  if (lower.includes('ungültiger planbar-pfad') || lower.includes('ungültige änderung') || lower.includes('nur für aufgaben')) {
    return new PlanbarError(code || 400, text, 'invalidRequest');
  }
  if (lower.includes('ungültige antwort')) return new PlanbarError(code, text, 'invalidResponse');
  return new PlanbarError(code, text, 'http');
}

/** planbar's own answer passed through the proxy – same texts as planbar.rs builds them. */
function upstreamError(status: number, isJson: boolean, message: string | null): PlanbarError {
  const detail = message ? ` – ${message}` : '';
  if (status === 401) return new PlanbarError(401, `${PLANBAR_MESSAGES.unauthorized}${detail}`, 'unauthorized');
  if (status === 403) {
    const text = message ? `${PLANBAR_MESSAGES.forbidden} – ${message}` : `${PLANBAR_MESSAGES.forbidden} (403)`;
    return new PlanbarError(403, text, 'forbidden');
  }
  // A missing route answers with Next's HTML page (the proxy drops it); planbar's own 404 is JSON.
  if (status === 404 && !isJson) return new PlanbarError(404, PLANBAR_MESSAGES.endpointMissing, 'endpointMissing');
  if (status === 404) return new PlanbarError(404, `${PLANBAR_MESSAGES.notFound}${detail}`, 'notFound');
  const kind: PlanbarErrorKind = status >= 500 ? 'unreachable' : 'http';
  return new PlanbarError(status, `planbar: Fehler ${status}${detail}`, kind);
}

function checkPath(path: string): string {
  if (!path.startsWith(API_PREFIX) || path.includes('..') || /[?#\s]/.test(path)) {
    throw new PlanbarError(0, `Ungültiger planbar-Pfad «${path}»`, 'invalidRequest');
  }
  return path;
}

export type PlanbarQuery = Record<string, string | number | readonly string[] | null | undefined>;

/** Drops empty values; lists become planbar's comma-separated form. */
function normalizeQuery(query: PlanbarQuery | undefined): Record<string, string> | undefined {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    const text =
      typeof value === 'object'
        ? value
            .map((item) => item.trim())
            .filter(Boolean)
            .join(',')
        : String(value).trim();
    if (text !== '') out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function abortError(): DOMException {
  return new DOMException('Abgebrochen', 'AbortError');
}

/** IPC calls can't be cancelled – at least stop waiting for them. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function proxyUrl(path: string, query?: Record<string, string>): string {
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${PROXY_PREFIX}${path.slice(API_PREFIX.length)}${search}`;
}

async function kioskCall<T>(call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  try {
    return await abortable(call(), signal);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw classify(err instanceof Error ? err.message : String(err), null);
  }
}

interface WebRequest {
  method: 'GET' | 'PATCH';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

async function webRequest<T>({ method, path, query, body, signal }: WebRequest): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    // Required by the server for every mutating request (CSRF).
    headers['X-SlateDesk'] = '1';
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(proxyUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new PlanbarError(0, 'Kiosk nicht erreichbar – Netzwerkverbindung prüfen', 'unreachable');
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (res.ok) {
    if (data === undefined) throw new PlanbarError(res.status, 'planbar: ungültige Antwort', 'invalidResponse');
    return data as T;
  }

  const message = isRecord(data) && typeof data.error === 'string' && data.error.trim() ? data.error.trim() : null;
  if (res.headers.get(UPSTREAM_HEADER)?.toLowerCase() === 'planbar') {
    throw upstreamError(res.status, data !== undefined, message);
  }
  // The SlateDesk server's own answer: a 401 is the web UI session.
  if (res.status === 401) throw new PlanbarError(401, message ?? httpStatusMessage(401), 'sessionExpired');
  throw classify(message ?? httpStatusMessage(res.status), res.status);
}

export interface PlanbarRequestOptions {
  signal?: AbortSignal;
  /** Also call when planbar is switched off (previews in the settings). */
  ignoreDisabled?: boolean;
}

function checkEnabled(options: PlanbarRequestOptions): void {
  const app = useAppState.getState();
  if (!options.ignoreDisabled && app.ready && !app.state.planbar.enabled) {
    throw new PlanbarError(0, PLANBAR_MESSAGES.disabled, 'disabled');
  }
}

/**
 * GET a planbar API path (must start with `/api/v1/`).
 * Kiosk: Rust command (15 s cache). Web UI: SlateDesk proxy.
 */
export async function planbarGet<T>(path: string, query?: PlanbarQuery, options: PlanbarRequestOptions = {}): Promise<T> {
  checkPath(path);
  checkEnabled(options);
  const params = normalizeQuery(query);
  return isTauri()
    ? kioskCall(() => backendPlanbarGet<T>(path, params), options.signal)
    : webRequest<T>({ method: 'GET', path, query: params, signal: options.signal });
}

/**
 * Ticks off (`completed: true`) or reopens a task of the Arbeitsliste – the
 * only change SlateDesk makes in planbar. Needs the key right «Aufgaben &
 * Zeiten – Schreiben» (else a `forbidden` PlanbarError). Re-fetch the list
 * afterwards: a recurring task gets a new open instance.
 */
export async function completeItem(
  id: string,
  completed = true,
  options: PlanbarRequestOptions = {},
): Promise<PlanbarWorkItemPatchResult> {
  if (!WORK_ITEM_ID.test(id)) throw new PlanbarError(0, `Ungültige planbar-Aufgabe «${id}»`, 'invalidRequest');
  checkEnabled(options);
  const path = `${API_PREFIX}arbeitsliste/${id}`;
  const body = { completed };
  return isTauri()
    ? kioskCall(() => backendPlanbarPatch<PlanbarWorkItemPatchResult>(path, body), options.signal)
    : webRequest<PlanbarWorkItemPatchResult>({ method: 'PATCH', path, body, signal: options.signal });
}

// ── Typed endpoints ──────────────────────────────────────────────────────────

/** Display name of a person – planbar allows an empty name, then the e-mail stands in. */
export const planbarMemberName = (member: Pick<PlanbarMember, 'name' | 'email'>): string =>
  member.name.trim() || member.email;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * planbar without the SlateDesk extension (branch slatedesk-dashboard) answers /mitglieder too, but
 * without `teams` – so every member is brought into the full shape here, before anything renders it.
 */
function normalizeMember(raw: unknown): PlanbarMember | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const id = text(m.id);
  if (!id) return null;
  const teams: PlanbarTeam[] = Array.isArray(m.teams)
    ? m.teams.flatMap((team: unknown) => {
        if (typeof team !== 'object' || team === null) return [];
        const t = team as Record<string, unknown>;
        return text(t.id) ? [{ id: text(t.id), name: text(t.name), color: text(t.color) }] : [];
      })
    : [];
  return { id, name: text(m.name), email: text(m.email), role: text(m.role), teams };
}

/** GET /api/v1/mitglieder – the people of the organisation (picker). */
export async function fetchMitglieder(options?: PlanbarRequestOptions): Promise<PlanbarMemberList> {
  const list = await planbarGet<{ data?: unknown }>('/api/v1/mitglieder', undefined, options);
  const rows = Array.isArray(list?.data) ? list.data : [];
  return { data: rows.map(normalizeMember).filter((m): m is PlanbarMember => m !== null) };
}

/** GET /api/v1/arbeitsliste – tasks and projects of the given people, sorted by due day and priority. */
export async function fetchArbeitsliste(
  query: PlanbarWorkListQuery,
  options?: PlanbarRequestOptions,
): Promise<PlanbarWorkList> {
  if (!query.benutzer.some((id) => id.trim() !== '')) {
    throw new PlanbarError(0, 'planbar: keine Personen ausgewählt', 'invalidRequest');
  }
  return planbarGet<PlanbarWorkList>(
    '/api/v1/arbeitsliste',
    {
      benutzer: query.benutzer,
      projekte: query.projekte,
      status: query.status,
      typ: query.typ,
      bis: query.bis,
      limit: query.limit,
    },
    options,
  );
}

/** GET /api/v1/projektuebersicht – with `ids` the answer keeps their order. */
export const fetchProjektuebersicht = (
  query: PlanbarProjectQuery = {},
  options?: PlanbarRequestOptions,
): Promise<PlanbarProjectPage> =>
  planbarGet<PlanbarProjectPage>(
    '/api/v1/projektuebersicht',
    {
      ids: query.ids,
      status: query.status,
      benutzer: query.benutzer,
      leiter: query.leiter,
      customerId: query.customerId,
      teamId: query.teamId,
      q: query.q,
      page: query.page,
      pageSize: query.pageSize,
    },
    options,
  );

/** GET /api/v1/news – Infowand posts, newest first (default: only posts visible to everyone). */
export const fetchNews = (query: PlanbarNewsQuery = {}, options?: PlanbarRequestOptions): Promise<PlanbarNewsList> =>
  planbarGet<PlanbarNewsList>(
    '/api/v1/news',
    { limit: query.limit, seit: query.seit, sichtbarkeit: query.sichtbarkeit },
    options,
  );

/** GET /api/v1/zeiten/zusammenfassung – booked minutes today/this week and running timers. */
export const fetchZeitZusammenfassung = (
  query: PlanbarTimeQuery = {},
  options?: PlanbarRequestOptions,
): Promise<PlanbarTimeSummary> =>
  planbarGet<PlanbarTimeSummary>('/api/v1/zeiten/zusammenfassung', { benutzer: query.benutzer }, options);
