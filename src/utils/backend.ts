/**
 * Typed wrappers for every Tauri command of the Rust backend.
 *
 * Widgets use these, never raw `invoke`. `@tauri-apps/api` is loaded lazily,
 * so modules shared with the web UI (state, lagra client) can import this
 * file without pulling Tauri into the browser bundle. Outside the kiosk all
 * calls reject with a German error.
 */
import type { StateOp, StateSnapshot } from '../state/types';

// ── Result / argument types ──────────────────────────────────────────────────

export interface RemoteInfo {
  enabled: boolean;
  port: number;
  urls: string[];
  /** Kiosk only – never exposed over HTTP. */
  pin: string;
  /** Why the web server is not reachable (e.g. port in use); null when it runs. */
  error: string | null;
}

export interface SystemInfo {
  hostname: string;
  ips: string[];
  version: string;
  /** Build-time git hash. */
  commit: string | null;
  uptimeSeconds: number;
  appUptimeSeconds: number;
  load: [number, number, number];
  cpuCount: number;
  /** Bytes */
  memTotal: number;
  memAvailable: number;
  diskTotal: number;
  diskAvailable: number;
  cpuTempC: number | null;
  sessionType: string;
  desktop: string;
  viewport: { width: number; height: number } | null;
  remote: { enabled: boolean; port: number; urls: string[] };
}

export interface HttpFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 'base64' for binary bodies (images). */
  responseType?: 'text' | 'base64';
}

export interface HttpFetchResponse {
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
}

export interface FeedSource {
  url: string;
  name?: string;
}

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  summary: string | null;
  /** epoch ms */
  published: number | null;
  source: string;
  imageUrl: string | null;
}

export interface SourceError {
  url: string;
  error: string;
}

export interface FeedsResult {
  items: FeedItem[];
  errors: SourceError[];
}

export interface CalendarSource {
  url: string;
  name?: string;
  color?: string;
}

export interface CalendarEventItem {
  id: string;
  title: string;
  /** epoch ms */
  start: number;
  end: number;
  allDay: boolean;
  location: string | null;
  description: string | null;
  source: string;
  color: string | null;
  private: boolean;
}

export interface CalendarEventsResult {
  events: CalendarEventItem[];
  errors: SourceError[];
}

export interface NetCheckTarget {
  host: string;
  port?: number;
  kind: 'ping' | 'tcp' | 'http';
  path?: string;
  /**
   * http only: the scheme of a pasted URL. Without it the backend uses https on
   * port 443 and otherwise http (retrying with https when a TLS port drops it).
   */
  scheme?: 'http' | 'https';
}

export interface NetCheckResult {
  host: string;
  port: number | null;
  kind: NetCheckTarget['kind'];
  reachable: boolean;
  latencyMs: number | null;
  packetLossPct: number | null;
  status: number | null;
  error: string | null;
  /** unix seconds */
  timestamp: number;
}

export interface SpeedTestResult {
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number | null;
  jitter_ms: number | null;
  interface: string;
  interface_type: string;
  /** unix seconds */
  timestamp: number;
}

export interface NasConnectionResult {
  reachable: boolean;
  latency_ms: number;
  packet_loss_pct: number;
  /** unix seconds */
  timestamp: number;
}

export interface UpdateCheck {
  available: boolean;
  current_commit: string;
  remote_commit: string;
  short_current: string;
  short_remote: string;
  behind: number;
}

export interface UpdateProgress {
  percent: number;
  message: string;
  /** True for every final outcome – also failures, «aktuell» and «übersprungen». */
  done: boolean;
  /** Truthy = update failed; the German reason is in `message` (older builds sent a string). */
  error: boolean | string | null;
  /**
   * Step from update-status.json: start, network, fetch, checkout, deps, build, install,
   * restart, health, rollback, done, uptodate, skipped, error. null for the old log fallback.
   */
  phase?: string | null;
}

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  models: string[];
}

export interface DisplayCapabilities {
  backend: string | null;
  sessionType: string;
  desktop: string;
}

/**
 * `display-wake` / `display-sleep`: the web UI switched the display (the
 * backend already did it) – the display schedule takes note.
 */
export type KioskActionName = 'reload' | 'identify' | 'edit-mode' | 'display-wake' | 'display-sleep';

export interface KioskAction {
  action: KioskActionName;
  value?: unknown;
}

// ── Core ─────────────────────────────────────────────────────────────────────

export const KIOSK_ONLY_MESSAGE = 'Nur im Kiosk verfügbar';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Rust commands reject with plain strings – normalize to Error. */
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return new Error(err.message);
  }
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(KIOSK_ONLY_MESSAGE);
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toError(err);
  }
}

/**
 * Listens to a backend event. Returns a synchronous unsubscribe function, so
 * it can be returned directly from a useEffect cleanup – also when the
 * listener is not registered yet.
 */
export function onBackendEvent<T>(event: string, handler: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  import('@tauri-apps/api/event')
    .then(({ listen }) => listen<T>(event, (e) => handler(e.payload)))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((err: unknown) => {
      console.error(`Ereignis «${event}» konnte nicht abonniert werden:`, err);
    });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

/** `kiosk://action` – commands sent from the web UI. */
export const onKioskAction = (handler: (action: KioskAction) => void): (() => void) =>
  onBackendEvent<KioskAction>('kiosk://action', handler);

/** Shows or hides the native mouse cursor over the kiosk window (Tauri window API, no command). */
export async function setCursorVisible(visible: boolean): Promise<void> {
  if (!isTauri()) throw new Error(KIOSK_ONLY_MESSAGE);
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  try {
    await getCurrentWindow().setCursorVisible(visible);
  } catch (err) {
    throw toError(err);
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

export const stateGet = (): Promise<StateSnapshot> => call('state_get');

export const stateApply = (ops: StateOp[], origin: string): Promise<{ rev: number }> =>
  call('state_apply', { ops, origin });

export const remoteInfo = (): Promise<RemoteInfo> => call('remote_info');

export const systemInfo = (): Promise<SystemInfo> => call('system_info');

export const reportViewport = (width: number, height: number): Promise<void> =>
  call('report_viewport', { width, height });

export const httpFetch = (req: HttpFetchRequest): Promise<HttpFetchResponse> => call('http_fetch', { req });

export const feedsFetch = (feeds: FeedSource[], maxItems?: number): Promise<FeedsResult> =>
  call('feeds_fetch', { feeds, maxItems });

export const calendarEvents = (
  sources: CalendarSource[],
  fromMs: number,
  toMs: number,
): Promise<CalendarEventsResult> =>
  // Rust takes whole milliseconds (i64); a fractional value would fail deserialization.
  call('calendar_events', { sources, fromMs: Math.round(fromMs), toMs: Math.round(toMs) });

/** `path` must start with `/api/v1/`. Resolves with the parsed JSON body. */
export const lagraGet = <T = unknown>(path: string, query?: Record<string, string>): Promise<T> =>
  call('lagra_get', { path, query });

/** Resolves with a `data:<mime>;base64,…` URL. */
export const lagraImage = (url: string): Promise<string> => call('lagra_image', { url });

/**
 * `path` must start with `/api/v1/`. Resolves with the parsed JSON body (cached 15 s in Rust).
 * `org` = id in `planbar.unternehmen` whose key is used; may be left out while only one
 * Unternehmen has a key.
 */
export const planbarGet = <T = unknown>(path: string, query?: Record<string, string>, org?: string): Promise<T> =>
  call('planbar_get', { path, query, org });

/**
 * Only `/api/v1/arbeitsliste/<id>` with `{ completed: boolean }` (tick off / reopen a
 * task) in Unternehmen `org`; Rust rejects every other path or body. Drops that
 * Unternehmen's read cache.
 */
export const planbarPatch = <T = unknown>(path: string, body: { completed: boolean }, org?: string): Promise<T> =>
  call('planbar_patch', { path, body, org });

export const netCheck = (targets: NetCheckTarget[]): Promise<NetCheckResult[]> => call('net_check', { targets });

/**
 * Queues a mail to the recipients of `state.mail`; the backend sends it in the
 * background and retries while the network is down. Dropped when mail is off.
 */
export const mailAlert = (subject: string, body: string): Promise<void> => call('mail_alert', { subject, body });

export const runSpeedTest = (): Promise<SpeedTestResult> => call('run_speed_test');

export const testNasConnection = (ip: string): Promise<NasConnectionResult> => call('test_nas_connection', { ip });

export const checkForUpdates = (): Promise<UpdateCheck> => call('check_for_updates');

export const triggerUpdate = (): Promise<void> => call('trigger_update');

export const getUpdateProgress = (): Promise<UpdateProgress> => call('get_update_progress');

export const checkOllama = (baseUrl?: string): Promise<OllamaStatus> => call('check_ollama', { baseUrl });

/** Resolves with the name of the display backend that worked. */
export const sleepDisplay = (): Promise<string> => call('sleep_display');

export const wakeDisplay = (): Promise<string> => call('wake_display');

export const displayCapabilities = (): Promise<DisplayCapabilities> => call('display_capabilities');

/** SVG markup using `currentColor`, so CSS can theme it. */
export const qrSvg = (text: string): Promise<string> => call('qr_svg', { text });

export const appRestart = (): Promise<void> => call('app_restart');
