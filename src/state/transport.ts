/**
 * How the frontend talks to the state owner:
 * - TauriTransport  – kiosk webview → Rust commands + `state://changed` event
 * - HttpTransport   – web UI (Fernsteuerung) → `/api/state…` + SSE `/api/events`
 * - LocalTransport  – plain-browser development, localStorage only
 */
import { isTauri, onBackendEvent, stateApply, stateGet } from '../utils/backend';
import { applyOps, dropInvalidTopLevel, isPlainObject } from './ops';
import type { RawState, StateEvent, StateOp, StateSnapshot, StateTransport, TransportKind } from './types';

/** Origin reported for writes from the kiosk webview. */
export const KIOSK_ORIGIN = 'kiosk';
export const LOCAL_STATE_KEY = 'slatedesk-state';
/** Same limit as the backend (state.json). */
export const MAX_STATE_BYTES = 2 * 1024 * 1024;

const MAX_RECONNECT_DELAY_MS = 30_000;
/** The server pings every 20 s (web.rs SSE_PING) – two missed pings and the stream counts as dead. */
const SSE_SILENCE_MS = 45_000;
/** EventSource.CLOSED – the constant itself is missing where EventSource is stubbed. */
const EVENTSOURCE_CLOSED = 2;
/** Origin of the full-state events the web server sends on (re)connect (web.rs). */
const SSE_SYNC_ORIGIN = 'sync';

function isSnapshot(value: unknown): value is StateSnapshot {
  return (
    isPlainObject(value) &&
    typeof value.rev === 'number' &&
    Number.isFinite(value.rev) &&
    isPlainObject(value.state)
  );
}

function toSnapshot(value: unknown): StateSnapshot {
  if (!isSnapshot(value)) throw new Error('Ungültige Antwort: Zustand fehlt oder ist beschädigt');
  return { rev: value.rev, state: value.state };
}

function toStateEvent(value: unknown, fallbackOrigin: string): StateEvent | null {
  if (!isSnapshot(value)) return null;
  const origin = isPlainObject(value) && typeof value.origin === 'string' ? value.origin : fallbackOrigin;
  return { rev: value.rev, state: value.state, origin };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** Failed request against the SlateDesk web server. `status` 0 = no connection. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function httpStatusMessage(status: number): string {
  if (status === 401) return 'Nicht angemeldet';
  if (status === 403) return 'Zugriff verweigert';
  if (status === 404) return 'Nicht gefunden';
  if (status === 413) return 'Daten sind zu gross';
  if (status === 429) return 'Zu viele Versuche – bitte später erneut versuchen';
  if (status >= 500) return `Fehler auf dem Kiosk (${status})`;
  return `Anfrage fehlgeschlagen (${status})`;
}

export const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

export interface ApiRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Serialized as JSON. */
  body?: unknown;
  signal?: AbortSignal;
  /** Gives up after this long (incl. reading the answer); default DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Safety net only: longer than anything the server legitimately takes (an
 * update check waits up to ~100 s for git, plus a check already running).
 * A request that never settles would otherwise block whoever waits for it.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** State reads and writes are quick on the server; a hanging one must not stall the write queue. */
const STATE_REQUEST_TIMEOUT_MS = 20_000;
export const TIMEOUT_MESSAGE = 'Kiosk antwortet nicht – Zeitüberschreitung';

/**
 * JSON request against the SlateDesk web server (same origin, session cookie).
 * Rejects with HttpError carrying the server's German `{ error }` text; after
 * `timeoutMs` with HttpError(0, TIMEOUT_MESSAGE). An abort through
 * `init.signal` rejects with the AbortError as before.
 */
export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  // Required by the server for mutating requests; harmless on reads.
  const headers: Record<string, string> = { Accept: 'application/json', 'X-SlateDesk': '1' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  // AbortSignal.any/timeout are too new for some phones – combine by hand.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const outer = init.signal;
  const forwardAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) forwardAbort();
  else outer?.addEventListener('abort', forwardAbort, { once: true });
  const failure = (err: unknown): unknown => {
    if (timedOut) return new HttpError(0, TIMEOUT_MESSAGE);
    if (isAbortError(err) || outer?.aborted) return err;
    return new HttpError(0, 'Kiosk nicht erreichbar – Netzwerkverbindung prüfen');
  };

  let res: Response;
  let text: string;
  try {
    try {
      res = await fetch(path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      throw failure(err);
    }
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forwardAbort);
  }

  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const serverMessage = isPlainObject(data) && typeof data.error === 'string' ? data.error : '';
    throw new HttpError(res.status, serverMessage || httpStatusMessage(res.status));
  }
  return data as T;
}

export class HttpTransport implements StateTransport {
  readonly kind = 'http' as const;
  private readonly base: string;

  /** `base` = origin prefix for the API, '' = same origin. */
  constructor(base = '') {
    this.base = base.replace(/\/+$/, '');
  }

  load(): Promise<StateSnapshot> {
    return apiRequest<unknown>(`${this.base}/api/state`, { timeoutMs: STATE_REQUEST_TIMEOUT_MS }).then(toSnapshot);
  }

  async apply(ops: StateOp[]): Promise<{ rev: number }> {
    const result = await apiRequest<unknown>(`${this.base}/api/state/ops`, {
      method: 'POST',
      body: { ops },
      timeoutMs: STATE_REQUEST_TIMEOUT_MS,
    });
    if (!isPlainObject(result) || typeof result.rev !== 'number') {
      throw new Error('Ungültige Antwort beim Speichern');
    }
    return { rev: result.rev };
  }

  /** true/false from /api/auth/status; null when the kiosk did not answer usably. */
  private async sessionValid(): Promise<boolean | null> {
    try {
      const body = await apiRequest<unknown>(`${this.base}/api/auth/status`, { timeoutMs: STATE_REQUEST_TIMEOUT_MS });
      return isPlainObject(body) && typeof body.authenticated === 'boolean' ? body.authenticated : null;
    } catch {
      return null;
    }
  }

  subscribe(
    cb: (event: StateEvent) => void,
    onStatus?: (connected: boolean) => void,
    onSessionLost?: () => void,
  ): () => void {
    if (typeof EventSource === 'undefined') {
      onStatus?.(false);
      return () => {};
    }

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const clearWatchdog = () => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
    };

    const scheduleReconnect = () => {
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    const fail = (es: EventSource) => {
      if (disposed || source !== es) return;
      // A refused stream (any HTTP error) ends with readyState CLOSED; a dropped
      // connection is CONNECTING again. Read before close() overwrites it.
      const refused = es.readyState === EVENTSOURCE_CLOSED;
      // Own backoff instead of EventSource's fixed retry: it also covers
      // the cases where the browser gives up (401, server restart).
      es.close();
      source = null;
      clearWatchdog();
      onStatus?.(false);
      if (!refused) {
        scheduleReconnect();
        return;
      }
      // EventSource hides the status: ask whether the session still exists.
      // After a kiosk restart it does not – retrying would only collect 401s.
      void this.sessionValid().then((valid) => {
        if (disposed) return;
        if (valid === false) {
          disposed = true;
          onSessionLost?.();
        } else {
          scheduleReconnect();
        }
      });
    };

    /** Every event (incl. the server's 20 s ping) proves the stream alive; silence means a dead connection. */
    const feedWatchdog = (es: EventSource) => {
      clearWatchdog();
      watchdog = setTimeout(() => fail(es), SSE_SILENCE_MS);
    };

    const connect = () => {
      retryTimer = null;
      if (disposed) return;
      const es = new EventSource(`${this.base}/api/events`);
      let eventsSinceOpen = 0;
      source = es;
      feedWatchdog(es);

      es.addEventListener('ping', () => feedWatchdog(es));

      es.addEventListener('open', () => {
        attempt = 0;
        eventsSinceOpen = 0;
        feedWatchdog(es);
        onStatus?.(true);
        // Events written while we were not connected are lost: load once.
        // A state event arriving meanwhile is newer than this snapshot.
        this.load()
          .then((snapshot) => {
            if (!disposed && source === es && eventsSinceOpen === 0) {
              cb({ ...snapshot, origin: 'resync', resync: true });
            }
          })
          .catch(() => {
            // The next event or reconnect recovers; errors surface on writes.
          });
      });

      es.addEventListener('state', (e) => {
        eventsSinceOpen += 1;
        feedWatchdog(es);
        let payload: unknown;
        try {
          payload = JSON.parse((e as MessageEvent<string>).data);
        } catch {
          return;
        }
        const event = toStateEvent(payload, 'remote');
        if (!event) return;
        // The server opens every stream (and replaces dropped events) with the current
        // state, origin "sync". Accept it like a reload: after a backend reset (state.json
        // restored from the backup) its rev can be lower than ours.
        cb(event.origin === SSE_SYNC_ORIGIN ? { ...event, resync: true } : event);
      });

      es.addEventListener('error', () => fail(es));
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      clearWatchdog();
      source?.close();
      source = null;
    };
  }
}

// ── Tauri ────────────────────────────────────────────────────────────────────

export class TauriTransport implements StateTransport {
  readonly kind = 'tauri' as const;

  load(): Promise<StateSnapshot> {
    return stateGet().then(toSnapshot);
  }

  apply(ops: StateOp[]): Promise<{ rev: number }> {
    return stateApply(ops, KIOSK_ORIGIN);
  }

  subscribe(cb: (event: StateEvent) => void, onStatus?: (connected: boolean) => void): () => void {
    onStatus?.(true);
    return onBackendEvent<unknown>('state://changed', (payload) => {
      const event = toStateEvent(payload, 'unbekannt');
      if (event) cb(event);
    });
  }
}

// ── localStorage (development in a plain browser) ────────────────────────────

export class LocalTransport implements StateTransport {
  readonly kind = 'local' as const;
  private readonly storage: Storage | null;

  constructor(storage?: Storage) {
    this.storage = storage ?? LocalTransport.defaultStorage();
  }

  private static defaultStorage(): Storage | null {
    try {
      return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      return null;
    }
  }

  private read(): StateSnapshot {
    try {
      const raw = this.storage?.getItem(LOCAL_STATE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isSnapshot(parsed)) return { rev: parsed.rev, state: dropInvalidTopLevel(parsed.state) };
      }
    } catch {
      // Unreadable → start fresh; withDefaults() fills everything.
    }
    return { rev: 0, state: {} };
  }

  load(): Promise<StateSnapshot> {
    return Promise.resolve(this.read());
  }

  apply(ops: StateOp[]): Promise<{ rev: number }> {
    try {
      if (!this.storage) throw new Error('Browser-Speicher ist nicht verfügbar');
      const current = this.read();
      const state: RawState = applyOps(current.state, ops);
      const rev = current.rev + 1;
      const text = JSON.stringify({ rev, state });
      if (text.length > MAX_STATE_BYTES) throw new Error('Zustand ist zu gross (max. 2 MB)');
      try {
        this.storage.setItem(LOCAL_STATE_KEY, text);
      } catch {
        throw new Error('Speichern im Browser fehlgeschlagen (Speicher voll?)');
      }
      return Promise.resolve({ rev });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  subscribe(cb: (event: StateEvent) => void, onStatus?: (connected: boolean) => void): () => void {
    onStatus?.(true);
    if (typeof window === 'undefined') return () => {};
    // Fires for writes from other tabs only – own writes are acknowledged directly.
    const handler = (e: StorageEvent) => {
      if (e.key !== LOCAL_STATE_KEY || !e.newValue || (this.storage && e.storageArea !== this.storage)) return;
      try {
        const event = toStateEvent(JSON.parse(e.newValue), 'local');
        if (event) cb(event);
      } catch {
        // Half-written value from another tab – the next write fixes it.
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }
}

// ── Selection ────────────────────────────────────────────────────────────────

/** True when this page is served by the SlateDesk web server (or proxied to it in dev). */
async function isSlateDeskServer(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return isPlainObject(body) && body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function detectTransportKind(): Promise<TransportKind> {
  if (isTauri()) return 'tauri';
  if (typeof window === 'undefined') return 'local';
  if (window.location.pathname.endsWith('remote.html')) return 'http';
  return (await isSlateDeskServer()) ? 'http' : 'local';
}

export function createTransport(kind: TransportKind): StateTransport {
  switch (kind) {
    case 'tauri':
      return new TauriTransport();
    case 'http':
      return new HttpTransport();
    case 'local':
      return new LocalTransport();
  }
}
