/**
 * Web UI calls to the kiosk's HTTP API (src-tauri/src/web.rs). Everything
 * goes through apiRequest (same origin, session cookie, X-SlateDesk header)
 * and rejects with HttpError carrying a German message. A 401 ends the web
 * UI session (back to the login page).
 *
 * State reads/writes do not belong here – use useAppState and the actions
 * in src/state/dataActions.ts.
 */
import { LagraError } from '../lagra/client';
import { PlanbarError } from '../planbar/client';
import type { PlanbarTestResult } from '../planbar/types';
import { MAX_STATE_BYTES, apiRequest, HttpError, httpStatusMessage, type ApiRequestInit } from '../state/transport';
import { ALLOWED_TOP_LEVEL_KEYS, isPlainObject } from '../state/ops';
import type { RawState } from '../state/types';
import type { SystemInfo, UpdateCheck, UpdateProgress } from '../utils/backend';
import { sessionExpired } from './session';

export type { PlanbarTestResult, SystemInfo, UpdateCheck, UpdateProgress };
export { errorText } from './errors';

/**
 * Set by the server on responses passed through from lagra or planbar (their
 * 401 is about the token/key, not our session).
 */
const UPSTREAM_HEADER = 'X-SlateDesk-Upstream';

/**
 * Pass any rejection here (also from the lagra and planbar clients): a lost
 * web UI session switches to the login page. Their own 401 (token/key) does not.
 */
export function handleSessionError(err: unknown): void {
  const expired =
    (err instanceof HttpError && err.status === 401) ||
    ((err instanceof LagraError || err instanceof PlanbarError) && err.kind === 'sessionExpired');
  if (expired) sessionExpired();
}

/**
 * apiRequest with session handling: a 401 switches to the login page.
 * Not for /api/lagra/* (its 401 may be lagra's) – use src/lagra/client.
 */
export async function request<T>(path: string, init?: ApiRequestInit): Promise<T> {
  try {
    return await apiRequest<T>(path, init);
  } catch (err) {
    handleSessionError(err);
    throw err;
  }
}

/** For raw fetch() calls (downloads, service proxies): the response means the session is gone. */
function isSessionExpiredResponse(res: Response): boolean {
  return res.status === 401 && !res.headers.has(UPSTREAM_HEADER);
}

function expectObject<T>(value: unknown, what: string): T {
  if (!isPlainObject(value)) throw new Error(`Ungültige Antwort vom Kiosk (${what})`);
  return value as T;
}

// ── Kiosk actions ────────────────────────────────────────────────────────────

export type KioskActionName =
  | 'reload'
  | 'identify'
  | 'edit-mode'
  | 'restart'
  | 'display-sleep'
  | 'display-wake'
  | 'update-check'
  | 'update-run';

/** POST /api/actions/<name>; resolves with the action's `result` (if it has one). */
async function runAction(name: KioskActionName, value?: unknown): Promise<unknown> {
  const body = await request<unknown>(`/api/actions/${name}`, {
    method: 'POST',
    body: value === undefined ? undefined : { value },
  });
  return isPlainObject(body) ? body.result : undefined;
}

const nothing = (): void => undefined;
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

function isUpdateCheck(value: unknown): value is UpdateCheck {
  return isPlainObject(value) && typeof value.available === 'boolean' && typeof value.behind === 'number';
}

/** Typed shortcuts for every kiosk action. */
export const actions = {
  /** Reloads the kiosk page. */
  reload: (): Promise<void> => runAction('reload').then(nothing),
  /** Shows name and addresses on the kiosk for 10 s. */
  identify: (): Promise<void> => runAction('identify').then(nothing),
  /** true/false switches the kiosk's edit mode on/off, undefined toggles it. */
  editMode: (on?: boolean): Promise<void> => runAction('edit-mode', on).then(nothing),
  /** Restarts the kiosk app (the connection drops for a few seconds). */
  restart: (): Promise<void> => runAction('restart').then(nothing),
  /** Resolves with the display backend that worked (e.g. «gnome-mutter»). */
  displaySleep: (): Promise<string> => runAction('display-sleep').then(asText),
  displayWake: (): Promise<string> => runAction('display-wake').then(asText),
  updateCheck: async (): Promise<UpdateCheck> => {
    const result = await runAction('update-check');
    if (!isUpdateCheck(result)) throw new Error('Ungültige Antwort der Update-Prüfung');
    return result;
  },
  /** Starts the update in the background – follow it with updateProgress(). */
  updateRun: (): Promise<void> => runAction('update-run').then(nothing),
};

// ── System ───────────────────────────────────────────────────────────────────

export async function system(signal?: AbortSignal): Promise<SystemInfo> {
  return expectObject<SystemInfo>(await request<unknown>('/api/system', { signal }), 'Systeminfo');
}

export async function updateProgress(signal?: AbortSignal): Promise<UpdateProgress> {
  return expectObject<UpdateProgress>(await request<unknown>('/api/update/progress', { signal }), 'Update-Status');
}

/** GET /api/lagra-test – connection test with the stored lagra settings. */
export interface LagraTestResult {
  ok: boolean;
  /** HTTP status of lagra, 0 when it was not reached. */
  status: number;
  message: string;
  /** lagra has the SlateDesk overview endpoint (false → «lagra-Update nötig»). */
  uebersicht: boolean;
}

export async function lagraTest(signal?: AbortSignal): Promise<LagraTestResult> {
  return expectObject<LagraTestResult>(await request<unknown>('/api/lagra-test', { signal }), 'lagra-Test');
}

/** GET /api/planbar-test – connection test with the stored planbar settings (also when switched off). */
export async function planbarTest(signal?: AbortSignal): Promise<PlanbarTestResult> {
  return expectObject<PlanbarTestResult>(await request<unknown>('/api/planbar-test', { signal }), 'planbar-Test');
}

/** POST /api/auth/pin – other sessions end, this one stays logged in. */
export async function changePin(current: string, next: string): Promise<void> {
  await request<unknown>('/api/auth/pin', { method: 'POST', body: { current, next } });
}

// ── Export / import ──────────────────────────────────────────────────────────

/** Download link for the state backup (secrets redacted); use as `<a href download>`. */
const exportUrl = '/api/export';
const EXPORT_FILE_NAME = 'slatedesk-state.json';

/**
 * Downloads the backup as `slatedesk-state-<YYYY-MM-DD>.json`. Unlike a
 * plain link it notices an expired session instead of saving the error.
 */
export async function downloadExport(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(exportUrl, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new HttpError(0, 'Kiosk nicht erreichbar – Netzwerkverbindung prüfen');
  }
  if (isSessionExpiredResponse(res)) {
    sessionExpired();
    throw new HttpError(401, httpStatusMessage(401));
  }
  if (!res.ok) throw new HttpError(res.status, httpStatusMessage(res.status));
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  // Local date – toISOString() would name a backup made before 02:00 after the previous day.
  const today = new Date();
  const stamp = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
  link.download = EXPORT_FILE_NAME.replace('.json', `-${stamp}.json`);
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}


export interface BackupFile {
  state: RawState;
  /** When the backup was made (epoch ms); null for a bare state or an unknown time. */
  exportedAt: number | null;
}

/**
 * Reads a backup file: the export document `{ rev, exportedAt, state }` or a
 * bare state object. Rejects with a German error for anything else.
 */
export async function readBackupFile(file: Blob): Promise<BackupFile> {
  if (file.size > MAX_STATE_BYTES) throw new Error('Datei ist zu gross (max. 2 MB)');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('Datei ist kein gültiges JSON');
  }
  const exported = isPlainObject(parsed) && isPlainObject(parsed.state) ? parsed : null;
  const state = exported ? exported.state : parsed;
  if (!isPlainObject(state) || !Object.keys(state).some((key) => ALLOWED_TOP_LEVEL_KEYS.includes(key))) {
    throw new Error('Datei enthält keine SlateDesk-Sicherung');
  }
  const exportedAt =
    exported && typeof exported.exportedAt === 'number' && Number.isFinite(exported.exportedAt) ? exported.exportedAt : null;
  return { state, exportedAt };
}

/** Replaces the whole kiosk state; secrets marked «gesetzt» keep their stored values. */
export async function importState(state: RawState): Promise<{ rev: number }> {
  const body = expectObject<{ rev: number }>(
    await request<unknown>('/api/import', { method: 'POST', body: { state } }),
    'Import',
  );
  return { rev: body.rev };
}
