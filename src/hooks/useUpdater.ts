/**
 * useUpdater – update check and installation for the kiosk top bar.
 *
 * Lives in TopBar (always mounted), not in UpdateButton: with a hidden top bar
 * the button unmounts after 30 s, and a running update must keep its
 * progress (and its polling) meanwhile.
 *
 * State machine: idle → checking → current | available → confirm → starting
 * → running (polls get_update_progress every 3 s) → done | error.
 * Polling always ends: on done/error, on unmount, or after 45 minutes.
 * Checks run 15 s after start and every 6 h. A failed scheduled check is
 * retried after 2, 5 and 15 minutes and stays silent (at boot the network is
 * often not up yet) – only a check the user started shows its error.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { checkForUpdates, getUpdateProgress, triggerUpdate, type UpdateCheck, type UpdateProgress } from '../utils/backend';

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const BACKGROUND_RETRY_MS: readonly number[] = [2 * 60_000, 5 * 60_000, 15 * 60_000];
const POLL_INTERVAL_MS = 3_000;
const UPDATE_TIMEOUT_MS = 45 * 60_000;
const CONFIRM_TIMEOUT_MS = 6_000;
/** A finished status of the previous run may still be on disk right after the start. */
const STALE_STATUS_GRACE_MS = 60_000;
/** Without a restart (e.g. nothing to install) the bar returns to normal. */
const DONE_RESET_MS = 60_000;

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking'; info: UpdateCheck | null }
  | { phase: 'current'; info: UpdateCheck }
  | { phase: 'available'; info: UpdateCheck; confirming: boolean }
  | { phase: 'starting' }
  | { phase: 'running'; startedAt: number; percent: number; message: string; sawProgress: boolean }
  | { phase: 'done'; message: string }
  | { phase: 'error'; message: string };

type Action =
  | { type: 'check' }
  | { type: 'checked'; info: UpdateCheck }
  | { type: 'confirm'; value: boolean }
  | { type: 'start' }
  | { type: 'started'; at: number }
  | { type: 'progress'; progress: UpdateProgress; at: number }
  | { type: 'timeout' }
  /** `background`: a scheduled check – falls back to what was known instead of an error. */
  | { type: 'failed'; message: string; background?: boolean }
  | { type: 'reset' };

const isBusy = (state: UpdateState): boolean =>
  state.phase === 'starting' || state.phase === 'running' || state.phase === 'done';

const fromInfo = (info: UpdateCheck): UpdateState =>
  info.available ? { phase: 'available', info, confirming: false } : { phase: 'current', info };

export function updateReducer(state: UpdateState, action: Action): UpdateState {
  switch (action.type) {
    case 'check':
      if (isBusy(state) || state.phase === 'checking') return state;
      return { phase: 'checking', info: 'info' in state ? state.info : null };
    case 'checked':
      if (state.phase !== 'checking') return state;
      return fromInfo(action.info);
    case 'confirm':
      return state.phase === 'available' ? { ...state, confirming: action.value } : state;
    case 'start':
      return state.phase === 'available' ? { phase: 'starting' } : state;
    case 'started':
      return state.phase === 'starting'
        ? { phase: 'running', startedAt: action.at, percent: 0, message: 'Update gestartet…', sawProgress: false }
        : state;
    case 'progress': {
      if (state.phase !== 'running') return state;
      const { progress } = action;
      const finished = progress.done || Boolean(progress.error);
      if (finished && !state.sawProgress && action.at - state.startedAt < STALE_STATUS_GRACE_MS) return state;
      if (progress.error) {
        const reason = typeof progress.error === 'string' ? progress.error : progress.message;
        return { phase: 'error', message: reason || 'Update fehlgeschlagen' };
      }
      if (progress.done) {
        return { phase: 'done', message: progress.message || 'Update abgeschlossen – SlateDesk startet neu' };
      }
      return {
        ...state,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
        message: progress.message || state.message,
        sawProgress: true,
      };
    }
    case 'timeout':
      return state.phase === 'running'
        ? { phase: 'error', message: 'Das Update läuft seit über 45 Minuten ohne Abschluss – bitte Protokoll prüfen' }
        : state;
    case 'failed':
      if (state.phase === 'done') return state;
      if (action.background) {
        if (state.phase !== 'checking') return state;
        return state.info ? fromInfo(state.info) : { phase: 'idle' };
      }
      return { phase: 'error', message: action.message };
    case 'reset':
      return { phase: 'idle' };
  }
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unbekannter Fehler';

export interface Updater {
  state: UpdateState;
  /** Check started by the user – a failure is shown. */
  check: () => void;
  confirm: (value: boolean) => void;
  start: () => void;
  /** Install requested or running: the top bar must stay visible meanwhile. */
  holdsBar: boolean;
}

/** `enabled` = kiosk (Tauri); elsewhere nothing is checked. */
export function useUpdater(enabled: boolean): Updater {
  const [state, dispatch] = useReducer(updateReducer, { phase: 'idle' });
  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = isBusy(state) || state.phase === 'checking';
  }, [state]);

  /** Resolves whether the check succeeded. */
  const runCheck = useCallback(async (background: boolean): Promise<boolean> => {
    dispatch({ type: 'check' });
    try {
      dispatch({ type: 'checked', info: await checkForUpdates() });
      return true;
    } catch (err) {
      const message = `Update-Prüfung fehlgeschlagen: ${errorText(err)}`;
      if (background) console.warn(message);
      dispatch({ type: 'failed', message, background });
      return false;
    }
  }, []);

  const check = useCallback(() => void runCheck(false), [runCheck]);

  // Scheduled checks – skipped while an update runs.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;

    const run = async () => {
      if (busyRef.current) return;
      const ok = await runCheck(true);
      if (cancelled) return;
      if (ok) {
        retries = 0;
      } else if (retry === null && retries < BACKGROUND_RETRY_MS.length) {
        retry = setTimeout(() => {
          retry = null;
          void run();
        }, BACKGROUND_RETRY_MS[retries]);
        retries += 1;
      }
    };

    const first = setTimeout(() => void run(), FIRST_CHECK_DELAY_MS);
    const interval = setInterval(() => {
      if (retry !== null) clearTimeout(retry);
      retry = null;
      retries = 0;
      void run();
    }, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(interval);
      if (retry !== null) clearTimeout(retry);
    };
  }, [enabled, runCheck]);

  const confirming = state.phase === 'available' && state.confirming;
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => dispatch({ type: 'confirm', value: false }), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  const runningSince = state.phase === 'running' ? state.startedAt : null;
  useEffect(() => {
    if (runningSince === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      timer = null;
      if (Date.now() - runningSince > UPDATE_TIMEOUT_MS) {
        dispatch({ type: 'timeout' });
        return;
      }
      try {
        const progress = await getUpdateProgress();
        if (!cancelled) dispatch({ type: 'progress', progress, at: Date.now() });
      } catch (err) {
        // Transient (e.g. status file being rewritten) – the timeout ends it otherwise.
        console.warn('Update-Fortschritt nicht lesbar:', err);
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [runningSince]);

  const done = state.phase === 'done';
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => {
      dispatch({ type: 'reset' });
      void runCheck(true);
    }, DONE_RESET_MS);
    return () => clearTimeout(timer);
  }, [done, runCheck]);

  const confirm = useCallback((value: boolean) => dispatch({ type: 'confirm', value }), []);

  const start = useCallback(() => {
    dispatch({ type: 'start' });
    triggerUpdate().then(
      () => dispatch({ type: 'started', at: Date.now() }),
      (err: unknown) => dispatch({ type: 'failed', message: `Update konnte nicht gestartet werden: ${errorText(err)}` }),
    );
  }, []);

  return { state, check, confirm, start, holdsBar: isBusy(state) || confirming };
}
