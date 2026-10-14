/**
 * useAppState – the frontend mirror of the backend state.
 *
 * Writes are applied optimistically, queued and sent in order (ops that pile
 * up while a request is in flight go out together in one apply). The view is
 * always `withDefaults(confirmed state + unconfirmed writes)`, so a backend
 * event that arrives before our own write was acknowledged never makes the
 * UI jump back. Events with rev <= the confirmed rev are ignored.
 */
import { create } from 'zustand';
import { DEFAULT_STATE, withDefaults } from './defaults';
import { migrateLegacyState } from './migrate';
import { applyOps, shareStructure } from './ops';
import { createTransport, detectTransportKind, HttpError, httpStatusMessage } from './transport';
import type { AppStateData, RawState, StateOp, StateSnapshot, StateTransport, TransportKind } from './types';

export interface AppStateStore {
  /** The first snapshot has been loaded – writes are possible. */
  ready: boolean;
  /** Backend revision of the last confirmed state. */
  rev: number;
  /** Complete, sanitized state including writes not yet confirmed. */
  state: AppStateData;
  /** Last error (German) – cleared by the next successful load or write. */
  error: string | null;
  /** Live updates are flowing (Tauri event listener / SSE connected). */
  connected: boolean;
  /** HTTP 401 – the web UI session is missing or expired. */
  unauthorized: boolean;
  transportKind: TransportKind | null;
  /**
   * Loads from `transport` (retrying with backoff) and subscribes to its
   * events. `onLoaded` runs synchronously right after `ready` turned true –
   * writes issued there land in the same render as the loaded state.
   */
  init(transport: StateTransport, options?: { onLoaded?: () => void }): Promise<void>;
  /**
   * Resolves false when the write was rejected (error is set, state rolled
   * back) or issued before `ready` (ignored).
   */
  apply(ops: StateOp[]): Promise<boolean>;
  reload(): Promise<void>;
  clearError(): void;
}

interface PendingWrite {
  ops: StateOp[];
  /** Backend rev that contains this write, once acknowledged. */
  rev: number | null;
  sent: boolean;
  resolve: (ok: boolean) => void;
}

type AcceptMode = 'event' | 'load' | 'resync';

const MAX_RETRY_DELAY_MS = 30_000;
/** Ack seen but the matching event did not arrive – fetch the state instead. */
const RESYNC_DELAY_MS = 3_000;

let transport: StateTransport | null = null;
let generation = 0;
let unsubscribe: (() => void) | null = null;
let confirmed: RawState = {};
let confirmedRev = -1;
/** confirmed + pending writes. */
let local: RawState = {};
let pending: PendingWrite[] = [];
let sending = false;
let resyncTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let cancelRetryWait: (() => void) | null = null;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isUnauthorized = (err: unknown): boolean => err instanceof HttpError && err.status === 401;

function reportError(err: unknown): void {
  useAppState.setState({ error: errorMessage(err), unauthorized: isUnauthorized(err) });
}

function publish(): void {
  const current = useAppState.getState();
  const state = shareStructure(current.state, withDefaults(local));
  const rev = Math.max(confirmedRev, 0);
  if (state !== current.state || rev !== current.rev) useAppState.setState({ state, rev });
}

function rebuild(): void {
  let next = confirmed;
  for (const write of pending) {
    try {
      next = applyOps(next, write.ops);
    } catch {
      // No longer applicable on the newer state – the backend rejects it as
      // well and its failure arrives with the acknowledgement.
    }
  }
  local = next;
  publish();
}

function clearResyncTimer(): void {
  if (resyncTimer !== null) clearTimeout(resyncTimer);
  resyncTimer = null;
}

function accept(snapshot: StateSnapshot, mode: AcceptMode): void {
  if (mode === 'event' && snapshot.rev <= confirmedRev) return;
  if (mode === 'load' && snapshot.rev < confirmedRev) return;
  confirmed = snapshot.state;
  confirmedRev = snapshot.rev;
  pending = pending.filter((write) => write.rev === null || write.rev > confirmedRev);
  if (!pending.some((write) => write.rev !== null)) clearResyncTimer();
  rebuild();
}

async function reloadFromTransport(): Promise<void> {
  const target = transport;
  const gen = generation;
  if (!target) return;
  try {
    const snapshot = await target.load();
    if (gen === generation) accept(snapshot, 'load');
  } catch (err) {
    if (gen !== generation) return;
    reportError(err);
    if (isUnauthorized(err)) endSession();
  }
}

function scheduleResync(): void {
  if (resyncTimer !== null) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    if (pending.some((write) => write.rev !== null && write.rev > confirmedRev)) void reloadFromTransport();
  }, RESYNC_DELAY_MS);
}

function dropWrites(batch: readonly PendingWrite[]): void {
  pending = pending.filter((write) => !batch.includes(write));
}

function onAck(batch: PendingWrite[], ops: StateOp[], rev: number): void {
  for (const write of batch) {
    write.rev = rev;
    write.resolve(true);
  }
  if (useAppState.getState().error !== null) useAppState.setState({ error: null, unauthorized: false });

  if (rev <= confirmedRev) {
    // The event for this write was faster than the acknowledgement.
    dropWrites(batch);
    rebuild();
  } else if (rev === confirmedRev + 1 && pending[0] === batch[0] && transport?.kind !== 'http') {
    // Nobody else wrote in between: confirmed state + our ops is exactly
    // what the backend holds now – no need to wait for the event. Not over
    // HTTP: there the backend rewrites ops (restores redacted secrets, clears
    // a secret whose url changed), so only its event tells the real result.
    try {
      confirmed = applyOps(confirmed, ops);
      confirmedRev = rev;
      dropWrites(batch);
      rebuild();
    } catch {
      scheduleResync();
    }
  } else {
    scheduleResync();
  }
}

function onFailure(batch: PendingWrite[], err: unknown): void {
  dropWrites(batch);
  for (const write of batch) write.resolve(false);
  rebuild();
  reportError(err);
  if (isUnauthorized(err)) endSession();
  else void reloadFromTransport();
}

function flush(): void {
  const target = transport;
  if (sending || !target) return;
  const batch = pending.filter((write) => !write.sent);
  if (batch.length === 0) return;

  sending = true;
  for (const write of batch) write.sent = true;
  const ops = batch.flatMap((write) => write.ops);
  const gen = generation;

  target
    .apply(ops)
    .then(
      ({ rev }) => {
        if (gen === generation) onAck(batch, ops, rev);
      },
      (err: unknown) => {
        if (gen === generation) onFailure(batch, err);
      },
    )
    .finally(() => {
      if (gen !== generation) return;
      sending = false;
      flush();
    });
}

function waitBeforeRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    cancelRetryWait = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      cancelRetryWait = null;
      resolve();
    };
    retryTimer = setTimeout(() => cancelRetryWait?.(), ms);
  });
}

function teardown(): void {
  unsubscribe?.();
  unsubscribe = null;
  clearResyncTimer();
  cancelRetryWait?.();
  for (const write of pending) write.resolve(false);
  pending = [];
  sending = false;
  transport = null;
  confirmed = {};
  confirmedRev = -1;
  local = {};
}

/**
 * The web UI session is gone (401, e.g. after the kiosk restarted): stop the
 * event stream – it would retry against the 401 for as long as the login page
 * stays open – and every request still under way. The loaded state stays
 * visible (the web UI keeps open editors below its login); writes resolve
 * false until the next init() after login starts over.
 */
function endSession(): void {
  generation += 1;
  teardown();
  useAppState.setState({ connected: false, unauthorized: true });
}

export const useAppState = create<AppStateStore>()((set, get) => ({
  ready: false,
  rev: 0,
  state: DEFAULT_STATE,
  error: null,
  connected: false,
  unauthorized: false,
  transportKind: null,

  init: async (next, options) => {
    teardown();
    const gen = ++generation;
    transport = next;
    set({ ready: false, error: null, unauthorized: false, connected: false, transportKind: next.kind });

    unsubscribe = next.subscribe(
      (event) => {
        if (gen === generation) accept(event, event.resync ? 'resync' : 'event');
      },
      (connected) => {
        if (gen === generation) set({ connected });
      },
      () => {
        if (gen !== generation) return;
        reportError(new HttpError(401, httpStatusMessage(401)));
        endSession();
      },
    );

    for (let attempt = 0; ; attempt += 1) {
      try {
        const snapshot = await next.load();
        if (gen !== generation) return;
        accept(snapshot, 'load');
        set({ ready: true, error: null, unauthorized: false });
        options?.onLoaded?.();
        return;
      } catch (err) {
        if (gen !== generation) return;
        reportError(err);
        // Without a session retrying is pointless – the web UI shows its login.
        if (isUnauthorized(err)) {
          endSession();
          throw err;
        }
        await waitBeforeRetry(Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt));
        if (gen !== generation) return;
      }
    }
  },

  apply: (ops) => {
    // Before the first load there is nothing to build on (and the UI only
    // shows defaults) – such writes are typically render echoes, not user input.
    if (!transport || !get().ready) return Promise.resolve(false);
    if (ops.length === 0) return Promise.resolve(true);

    let next: RawState;
    try {
      next = applyOps(local, ops);
    } catch (err) {
      reportError(err);
      return Promise.resolve(false);
    }
    // Nothing changes → nothing to send (e.g. a layout echo from the grid).
    if (shareStructure(local, next) === local) return Promise.resolve(true);

    local = next;
    publish();
    return new Promise<boolean>((resolve) => {
      pending.push({ ops, rev: null, sent: false, resolve });
      flush();
    });
  },

  reload: () => reloadFromTransport(),

  clearError: () => set({ error: null }),
}));

/** Latest raw backend state incl. unconfirmed writes (no defaults filled). */
const getRawState = (): RawState => local;

export interface InitOptions {
  /** Widget ids a legacy layout may keep during migration. */
  knownWidgetIds?: readonly string[];
  /** Start over even if an initialization of this kind succeeded (e.g. after login). */
  force?: boolean;
}

let activeInit: { kind: TransportKind | 'auto'; promise: Promise<TransportKind> } | null = null;

async function runInit(kind: TransportKind | 'auto', options: InitOptions): Promise<TransportKind> {
  const resolved = kind === 'auto' ? await detectTransportKind() : kind;
  const created = createTransport(resolved);
  const migration: { done: Promise<boolean> | null } = { done: null };
  await useAppState.getState().init(created, {
    // Only the kiosk (or local dev) owns the defaults – never the web UI.
    // Runs in the same tick as `ready`, so the first start shows the
    // migrated dashboard right away instead of flashing the default one.
    onLoaded:
      resolved === 'http'
        ? undefined
        : () => {
            migration.done = migrateLegacyState(
              getRawState(),
              (ops) => useAppState.getState().apply(ops),
              undefined,
              options.knownWidgetIds,
            );
          },
  });
  if (migration.done) await migration.done;
  return resolved;
}

/**
 * Picks the transport and loads the state. 'auto': Tauri webview → tauri;
 * remote.html or a page served by the SlateDesk web server → http; else local.
 * Repeated calls with the same kind share one initialization (StrictMode);
 * after a failure (e.g. 401 before login) the next call starts over.
 */
export function initAppState(kind: TransportKind | 'auto' = 'auto', options: InitOptions = {}): Promise<TransportKind> {
  if (activeInit && activeInit.kind === kind && !options.force) return activeInit.promise;
  const entry = { kind, promise: runInit(kind, options) };
  activeInit = entry;
  entry.promise.catch(() => {
    if (activeInit === entry) activeInit = null;
  });
  return entry.promise;
}
