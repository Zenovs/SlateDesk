/**
 * Which update run a finished progress answer belongs to.
 *
 * After a trigger the kiosk answers «wird gestartet» (phase 'start') for up
 * to START_GRACE_MS while update-status.json still holds the previous run.
 * If the triggered run never starts (e.g. the systemd unit fails before the
 * script writes its status), the previous run's outcome comes back once that
 * time is over – it must not be shown as the result of this run
 * («Update installiert» for last night's update). The progress answers carry
 * no start time, so this is told apart by timing.
 */
import type { UpdateProgress } from '../../api';

/** As in src-tauri/src/update.rs. */
export const START_GRACE_MS = 120_000;
/** Clock and request delays between the kiosk's trigger time and ours. */
const SLACK_MS = 10_000;
/** Longest gap between two answers while the page polls (every 3 s plus the request). */
const CONTINUOUS_GAP_MS = 15_000;

export interface RunWatch {
  /** When this page triggered the run (or first saw it starting). */
  since: number;
  /** An answer beyond «wird gestartet» arrived – the run really started. */
  started: boolean;
  /** Time of the last «wird gestartet» answer. */
  lastStartingAt: number | null;
}

/**
 * 'this-run': the result belongs to the followed run. 'not-started': the run
 * never reported anything, the answer is the previous run's. 'unknown': not
 * polled continuously, can't tell (shown like an older result).
 */
export type RunOutcome = 'this-run' | 'not-started' | 'unknown';

/** The kiosk's stand-in answer between trigger and the script's first status. */
const isStarting = (progress: UpdateProgress): boolean => !progress.done && progress.phase === 'start';

/** Starts watching a run triggered at `at`. */
export const watchTriggeredRun = (at: number): RunWatch => ({ since: at, started: false, lastStartingAt: null });

/** Records a running (not done) answer received at `at`. */
export function observeRun(watch: RunWatch | null, progress: UpdateProgress, at: number): RunWatch {
  const current = watch ?? { since: at, started: false, lastStartingAt: null };
  return isStarting(progress)
    ? { ...current, lastStartingAt: at }
    : { ...current, started: true };
}

/** Classifies the first finished answer, received at `at`. */
export function runOutcome(watch: RunWatch, at: number): RunOutcome {
  if (watch.started) return 'this-run';
  // Within the grace period a finished answer is newer than the trigger (the kiosk answers «wird gestartet» until then).
  if (at - watch.since < START_GRACE_MS - SLACK_MS) return 'this-run';
  // Polled right up to it: «wird gestartet» turned straight into the old result when the grace period ended.
  if (watch.lastStartingAt !== null && at - watch.lastStartingAt <= CONTINUOUS_GAP_MS) return 'not-started';
  return 'unknown';
}
