/**
 * lagra client – same API in kiosk and web UI.
 *
 * Kiosk: Rust commands `lagra_get` / `lagra_image` (token stays in Rust, no
 * CORS/CSP issues). Web UI: the SlateDesk server's proxy `/api/lagra/…`
 * (session cookie; the token never reaches the browser).
 * All failures reject with a LagraError carrying a German message.
 */
import { useAppState } from '../state/appState';
import { isAbortError } from '../state/transport';
import { isTauri, lagraGet as backendLagraGet, lagraImage as backendLagraImage } from '../utils/backend';
import type {
  LagraJobs,
  LagraJobsQuery,
  LagraPruefen,
  LagraSection,
  LagraUebersicht,
  LagraUebersichtQuery,
} from './types';
import { isLagraFehler } from './types';

const API_PREFIX = '/api/v1/';
const PROXY_PREFIX = '/api/lagra/';
const IMAGE_CACHE_SIZE = 24;

export type LagraErrorKind =
  /** No URL/token configured on the kiosk. */
  | 'notConfigured'
  /** Switched off in the kiosk settings. */
  | 'disabled'
  /** lagra rejected the token. */
  | 'unauthorized'
  /** lagra lacks the endpoint – lagra needs its SlateDesk update. */
  | 'endpointMissing'
  /** lagra (or the kiosk, from the web UI) did not answer. */
  | 'unreachable'
  /** Web UI session expired – log in again. */
  | 'sessionExpired'
  | 'invalidRequest'
  | 'invalidResponse'
  | 'http';

const LAGRA_MESSAGES = {
  notConfigured: 'lagra ist nicht eingerichtet',
  disabled: 'lagra ist ausgeschaltet',
  unauthorized: 'lagra: Token ungültig (401)',
  endpointMissing: 'lagra: Endpunkt fehlt (404) – lagra-Update nötig',
  unreachable: 'lagra nicht erreichbar',
} as const;

export class LagraError extends Error {
  /** HTTP status if known, 0 otherwise. */
  readonly status: number;
  readonly kind: LagraErrorKind;

  constructor(status: number, message: string, kind: LagraErrorKind = 'http') {
    super(message);
    this.name = 'LagraError';
    this.status = status;
    this.kind = kind;
  }

  /** 404 on a known endpoint: lagra is too old (show «lagra-Update nötig», use a fallback). */
  get endpointMissing(): boolean {
    return this.kind === 'endpointMissing';
  }
}

export const isLagraEndpointMissing = (err: unknown): boolean =>
  err instanceof LagraError && err.kind === 'endpointMissing';

/** Maps the backend's German error texts (kiosk command or proxy `{ error }`) to a LagraError. */
function classify(message: string, status: number | null): LagraError {
  const text = message.trim() || LAGRA_MESSAGES.unreachable;
  const lower = text.toLowerCase();
  // Rust writes «… (401)» for known cases and «lagra: Fehler 500 – …» for any other status.
  const match = /\((\d{3})\)|Fehler (\d{3})\b/.exec(text);
  const code = status ?? Number(match?.[1] ?? match?.[2] ?? 0);
  if (lower.includes('nicht eingerichtet')) return new LagraError(code, text, 'notConfigured');
  if (lower.includes('endpunkt fehlt')) return new LagraError(404, text, 'endpointMissing');
  if (lower.includes('token ungültig')) return new LagraError(401, text, 'unauthorized');
  // 5xx counts as «nicht erreichbar» – same as the web UI path (webGet).
  if (lower.includes('nicht erreichbar') || lower.includes('zeitüberschreitung') || code >= 500) {
    return new LagraError(code, text, 'unreachable');
  }
  return new LagraError(code, text, 'http');
}

function checkPath(path: string): string {
  if (!path.startsWith(API_PREFIX) || path.includes('..') || /[?#\s]/.test(path)) {
    throw new LagraError(0, `Ungültiger lagra-Pfad «${path}»`, 'invalidRequest');
  }
  return path;
}

export type LagraQuery = Record<string, string | number | boolean | null | undefined>;

/** Drops empty values; booleans become '1' / '0' (lagra checks `=== '1'`). */
function normalizeQuery(query: LagraQuery | undefined): Record<string, string> | undefined {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
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

function proxyUrl(path: string, query?: Record<string, string>): string {
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${PROXY_PREFIX}${path.slice(API_PREFIX.length)}${search}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function kioskGet<T>(path: string, query: Record<string, string> | undefined, signal?: AbortSignal): Promise<T> {
  try {
    return await abortable(backendLagraGet<T>(path, query), signal);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw classify(err instanceof Error ? err.message : String(err), null);
  }
}

async function webGet<T>(path: string, query: Record<string, string> | undefined, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(proxyUrl(path, query), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new LagraError(0, 'Kiosk nicht erreichbar – Netzwerkverbindung prüfen', 'unreachable');
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (res.ok) {
    if (body === undefined) throw new LagraError(res.status, 'lagra: ungültige Antwort', 'invalidResponse');
    return body as T;
  }

  // `{ error }` comes from the SlateDesk server itself, `{ fehler }` is lagra's answer passed through.
  const own = isRecord(body) && typeof body.error === 'string' ? body.error : null;
  const fromLagra = isRecord(body) && typeof body.fehler === 'string' ? body.fehler : null;
  if (own !== null) {
    if (res.status === 401) throw new LagraError(401, own, 'sessionExpired');
    throw classify(own, res.status);
  }
  if (res.status === 401) throw new LagraError(401, LAGRA_MESSAGES.unauthorized, 'unauthorized');
  // A missing route answers with Next's HTML 404; a JSON `fehler` is a real «not found».
  if (res.status === 404 && fromLagra === null) {
    throw new LagraError(404, LAGRA_MESSAGES.endpointMissing, 'endpointMissing');
  }
  if (res.status >= 500) {
    throw new LagraError(res.status, `${LAGRA_MESSAGES.unreachable}: ${fromLagra ?? `HTTP ${res.status}`}`, 'unreachable');
  }
  throw new LagraError(res.status, `lagra: ${fromLagra ?? `Anfrage fehlgeschlagen (${res.status})`}`, 'http');
}

export interface LagraRequestOptions {
  signal?: AbortSignal;
  /** Also call when lagra is switched off (connection test in the settings). */
  ignoreDisabled?: boolean;
}

/**
 * GET a lagra API path (must start with `/api/v1/`).
 * Kiosk: Rust command (15 s cache). Web UI: SlateDesk proxy.
 */
export async function lagraGet<T>(path: string, query?: LagraQuery, options: LagraRequestOptions = {}): Promise<T> {
  checkPath(path);
  const app = useAppState.getState();
  if (!options.ignoreDisabled && app.ready && !app.state.lagra.enabled) {
    throw new LagraError(0, LAGRA_MESSAGES.disabled, 'disabled');
  }
  const params = normalizeQuery(query);
  return isTauri() ? kioskGet<T>(path, params, options.signal) : webGet<T>(path, params, options.signal);
}

// ── Images ───────────────────────────────────────────────────────────────────

const imageCache = new Map<string, Promise<string>>();

function proxyImageUrl(urlOrPath: string): string {
  let path = urlOrPath;
  if (!urlOrPath.startsWith('/')) {
    try {
      const url = new URL(urlOrPath);
      path = `${url.pathname}${url.search}`;
    } catch {
      throw new LagraError(0, 'Ungültige lagra-Bildadresse', 'invalidRequest');
    }
  }
  const [pathname, search = ''] = path.split('?', 2);
  checkPath(pathname);
  return `${PROXY_PREFIX}${pathname.slice(API_PREFIX.length)}${search ? `?${search}` : ''}`;
}

/**
 * Image URL usable in `<img src>` for a lagra preview. Pass `vorschauPfad`
 * (or `vorschauUrl`). Kiosk: `data:` URL fetched with the token (small LRU
 * cache). Web UI: the SlateDesk proxy URL (session cookie).
 */
export function lagraImageUrl(urlOrPath: string): Promise<string> {
  if (!isTauri()) {
    try {
      return Promise.resolve(proxyImageUrl(urlOrPath));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  const cached = imageCache.get(urlOrPath);
  if (cached) {
    imageCache.delete(urlOrPath);
    imageCache.set(urlOrPath, cached);
    return cached;
  }
  const loading = backendLagraImage(urlOrPath).catch((err: unknown) => {
    imageCache.delete(urlOrPath);
    throw classify(err instanceof Error ? err.message : String(err), null);
  });
  imageCache.set(urlOrPath, loading);
  while (imageCache.size > IMAGE_CACHE_SIZE) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    imageCache.delete(oldest);
  }
  return loading;
}

/** Contract name of lagraImageUrl. */
export const lagraImage = lagraImageUrl;

// ── Typed endpoints ──────────────────────────────────────────────────────────

function uebersichtQuery(query: LagraUebersichtQuery = {}): LagraQuery {
  return {
    teile: query.teile && query.teile.length > 0 ? query.teile.join(',') : undefined,
    neuAnzahl: query.neuAnzahl,
    neuArt: query.neuArt,
    ordner: query.ordner?.trim(),
    namen: query.namen ? true : undefined,
  };
}

/** GET /api/v1/uebersicht – a 404 (LagraError.endpointMissing) means lagra is too old. */
export const fetchUebersicht = (
  query: LagraUebersichtQuery = {},
  options?: LagraRequestOptions,
): Promise<LagraUebersicht> => lagraGet<LagraUebersicht>('/api/v1/uebersicht', uebersichtQuery(query), options);

export const fetchJobs = (query: LagraJobsQuery = {}, options?: LagraRequestOptions): Promise<LagraJobs> =>
  lagraGet<LagraJobs>(
    '/api/v1/jobs',
    { id: query.id, verlauf: query.verlauf, details: query.details ? true : undefined },
    options,
  );

/** GET /api/v1/pruefen – virus scanner status; exists in older lagra versions too. */
export const fetchPruefen = (options?: LagraRequestOptions): Promise<LagraPruefen> =>
  lagraGet<LagraPruefen>('/api/v1/pruefen', undefined, options);

/**
 * How long a polled fallback reuses lagra's /pruefen answer. lagra writes an
 * API log row for every GET /pruefen, unthrottled: asked every 30 s, SlateDesk
 * alone would fill «Letzte Aufrufe» on lagra's /schnittstellen page.
 */
export const PRUEFEN_FALLBACK_MAX_AGE_MS = 10 * 60_000;

interface PruefenAnswer {
  /** lagra URL the answer belongs to. */
  url: string;
  /** epoch ms the answer arrived. */
  at: number;
  data: LagraPruefen | null;
}

let pruefenAnswer: PruefenAnswer | null = null;
let pruefenLoad: { url: string; promise: Promise<LagraPruefen | null> } | null = null;

/**
 * Virus scanner for a lagra without /uebersicht: GET /api/v1/pruefen at most
 * every PRUEFEN_FALLBACK_MAX_AGE_MS – widgets that poll the fallback share
 * the answer and a request in flight. null = lagra lacks /pruefen as well.
 * Failures are not kept, the next call asks again.
 */
export function fetchPruefenFallback(options: LagraRequestOptions = {}): Promise<LagraPruefen | null> {
  const url = useAppState.getState().state.lagra.url.trim();
  if (pruefenAnswer?.url === url && Date.now() - pruefenAnswer.at < PRUEFEN_FALLBACK_MAX_AGE_MS) {
    return abortable(Promise.resolve(pruefenAnswer.data), options.signal);
  }
  if (pruefenLoad?.url !== url) {
    // Not bound to one caller's signal: another widget may wait for the same answer.
    const promise: Promise<LagraPruefen | null> = fetchPruefen({ ignoreDisabled: options.ignoreDisabled })
      .catch((err: unknown) => {
        if (isLagraEndpointMissing(err)) return null;
        throw err;
      })
      .then((data) => {
        if (pruefenLoad?.promise === promise) pruefenAnswer = { url, at: Date.now(), data };
        return data;
      })
      .finally(() => {
        if (pruefenLoad?.promise === promise) pruefenLoad = null;
      });
    pruefenLoad = { url, promise };
  }
  return abortable(pruefenLoad.promise, options.signal);
}

/** Splits an Übersicht section into data or its own error. */
export function readSection<T>(section: LagraSection<T> | undefined): { data: T | null; error: string | null } {
  if (section === undefined) return { data: null, error: null };
  if (isLagraFehler(section)) return { data: null, error: section.fehler };
  return { data: section, error: null };
}
