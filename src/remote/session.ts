/**
 * Web UI session: which screen to show (login, unreachable, app), the kiosk
 * name before the state is loaded, and the way back to the login page when
 * the session ends (401, logout, kiosk restart – sessions only live in the
 * kiosk's memory).
 *
 * A session that ends while the app is open stops the state's event stream
 * and shows the login above the still mounted app (`keepApp`), so open
 * editors keep their input and can be saved after logging in again.
 */
import { create } from 'zustand';
import { initAppState, useAppState } from '../state/appState';
import { DEFAULT_STATE } from '../state/defaults';
import { isPlainObject } from '../state/ops';
import { apiRequest, HttpError, httpStatusMessage } from '../state/transport';
import type { StateTransport } from '../state/types';

export type SessionStatus =
  /** First /api/auth/status request is running. */
  | 'checking'
  /** The kiosk did not answer the first request. */
  | 'unreachable'
  | 'login'
  | 'authenticated';

export interface SessionState {
  status: SessionStatus;
  /** Kiosk name from /api/auth/status – state.kiosk.name takes over once loaded. */
  name: string;
  /** Shown on the login page, e.g. after the session expired. */
  notice: string | null;
  /** The last request to the kiosk got an answer. */
  reachable: boolean;
  /**
   * The app has been shown: when the session ends it stays mounted below the
   * login (and the reload after it) instead of starting over, so open
   * editors keep their input.
   */
  keepApp: boolean;
}

const DEFAULT_KIOSK_NAME = 'SlateDesk';
const SESSION_EXPIRED_NOTICE = 'Sitzung abgelaufen – bitte erneut anmelden';
const NETWORK_ERROR = 'Kiosk nicht erreichbar – Netzwerkverbindung prüfen';
/** Used when a 429 carries no usable Retry-After header. */
const DEFAULT_RETRY_AFTER_S = 60;

export const useSession = create<SessionState>(() => ({
  status: 'checking',
  name: DEFAULT_KIOSK_NAME,
  notice: null,
  reachable: true,
  keepApp: false,
}));

/** Loads the state over HTTP; a 401 on the way means the session is already gone. */
function startState(): void {
  initAppState('http', { force: true }).catch((err: unknown) => {
    if (err instanceof HttpError && err.status === 401) sessionExpired();
  });
}

/**
 * Stand-in for the state transport once the session is gone: no event
 * stream, every request answered like the kiosk would (401).
 */
const ENDED_TRANSPORT: StateTransport = {
  kind: 'http',
  load: () => Promise.reject(new HttpError(401, SESSION_EXPIRED_NOTICE)),
  apply: () => Promise.reject(new HttpError(401, SESSION_EXPIRED_NOTICE)),
  subscribe: () => () => {},
};

/**
 * Switches to the login page. Replacing the transport closes the old
 * session's event stream – it would otherwise reconnect with 401 every 30 s
 * for as long as the page stays open – and the loaded state is dropped
 * (like logout() does); the next login loads it afresh.
 */
function endSession(notice: string): void {
  useSession.setState({ status: 'login', notice });
  useAppState
    .getState()
    .init(ENDED_TRANSPORT)
    .catch(() => {
      // Expected: ENDED_TRANSPORT rejects the load.
    });
  useAppState.setState({ state: DEFAULT_STATE, rev: 0 });
}

/** The app has been shown – from now on it stays mounted when the session ends (`keepApp`). */
export function appShown(): void {
  if (!useSession.getState().keepApp) useSession.setState({ keepApp: true });
}

/** Ends the session view (back to the login page). No-op unless logged in. */
export function sessionExpired(notice: string = SESSION_EXPIRED_NOTICE): void {
  if (useSession.getState().status !== 'authenticated') return;
  endSession(notice);
}

/** Records whether the kiosk answered (connection indicator). */
export function setReachable(reachable: boolean): void {
  if (useSession.getState().reachable !== reachable) useSession.setState({ reachable });
}

interface AuthStatus {
  authenticated: boolean;
  name: string;
}

async function fetchAuthStatus(): Promise<AuthStatus> {
  const body = await apiRequest<unknown>('/api/auth/status');
  if (!isPlainObject(body) || typeof body.authenticated !== 'boolean') {
    throw new HttpError(0, 'Ungültige Antwort vom Kiosk');
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : DEFAULT_KIOSK_NAME;
  return { authenticated: body.authenticated, name };
}

async function runCheck(): Promise<void> {
  let auth: AuthStatus;
  try {
    auth = await fetchAuthStatus();
  } catch {
    useSession.setState((s) => ({ reachable: false, status: s.status === 'checking' ? 'unreachable' : s.status }));
    return;
  }

  const current = useSession.getState();
  if (auth.authenticated) {
    // Initialize before switching screens: init() clears `unauthorized`
    // synchronously, so the session watch never sees a stale 401.
    if (current.status !== 'authenticated') startState();
    useSession.setState({ status: 'authenticated', name: auth.name, notice: null, reachable: true });
  } else if (current.status === 'authenticated') {
    useSession.setState({ name: auth.name, reachable: true });
    endSession(SESSION_EXPIRED_NOTICE);
  } else {
    useSession.setState({ status: 'login', name: auth.name, reachable: true });
  }
}

let pendingCheck: Promise<void> | null = null;

/** Asks the kiosk whether this browser is logged in and switches screens accordingly. */
export function checkSession(): Promise<void> {
  pendingCheck ??= runCheck().finally(() => {
    pendingCheck = null;
  });
  return pendingCheck;
}

export type LoginResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /** Set when the kiosk blocks further attempts (HTTP 429). */
      retryAfterSeconds: number | null;
    };

function parseRetryAfter(value: string | null): number {
  if (!value) return DEFAULT_RETRY_AFTER_S;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  return DEFAULT_RETRY_AFTER_S;
}

async function serverError(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    return isPlainObject(body) && typeof body.error === 'string' && body.error.trim() ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/login. Uses fetch directly (not apiRequest) because the
 * lockout duration is only available in the Retry-After header.
 */
export async function login(pin: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-SlateDesk': '1' },
      body: JSON.stringify({ pin }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    setReachable(false);
    return { ok: false, message: NETWORK_ERROR, retryAfterSeconds: null };
  }
  setReachable(true);

  if (res.ok) {
    startState();
    useSession.setState({ status: 'authenticated', notice: null });
    return { ok: true };
  }
  if (res.status === 429) {
    return {
      ok: false,
      message: (await serverError(res)) ?? httpStatusMessage(429),
      retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')),
    };
  }
  if (res.status === 401) return { ok: false, message: 'Falscher PIN', retryAfterSeconds: null };
  return { ok: false, message: (await serverError(res)) ?? httpStatusMessage(res.status), retryAfterSeconds: null };
}

/** Ends the session on the kiosk, then reloads the page so no loaded state stays in memory. */
export async function logout(): Promise<void> {
  await apiRequest('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}
