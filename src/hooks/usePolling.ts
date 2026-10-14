/**
 * usePolling – runs an async loader now and every `intervalMs`.
 *
 * - keeps the last good data when a run fails (error is reported next to it)
 * - aborts stale runs (deps change, refresh, unmount) via the AbortSignal
 * - exponential backoff after errors (max 5 min), reset by the next success
 * - pauses while the document is hidden and catches up when visible again
 * - never overlaps runs: the next one is scheduled after the previous ended
 *
 * A change of `deps` starts over with empty data (it belongs to another query).
 */
import { type DependencyList, useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from 'react';

export interface PollingOptions {
  /** Default true. */
  pauseWhenHidden?: boolean;
  /** Default true – otherwise the first run happens after `intervalMs`. */
  runImmediately?: boolean;
  /** Default true – false stops polling (data is kept). */
  enabled?: boolean;
}

export interface PollingState<T> {
  data: T | null;
  /** German error of the last run, null after a success. */
  error: string | null;
  loading: boolean;
  /** epoch ms of the last successful run. */
  lastUpdated: number | null;
}

export interface PollingResult<T> extends PollingState<T> {
  /** Runs now (aborting a run in flight). */
  refresh: () => void;
}

const MAX_BACKOFF_MS = 5 * 60_000;
/** First retry after an error comes at the latest after this. */
const MAX_ERROR_BASE_MS = 30_000;

interface PollerConfig<T> {
  fn: (signal: AbortSignal) => Promise<T>;
  /** null/0 = load once (errors are still retried). */
  intervalMs: number | null;
  pauseWhenHidden: boolean;
  runImmediately: boolean;
  enabled: boolean;
}

const isHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

const errorText = (err: unknown): string => {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Unbekannter Fehler';
};

class Poller<T> {
  private snapshot: PollingState<T> = { data: null, error: null, loading: false, lastUpdated: null };
  private readonly listeners = new Set<() => void>();
  private config: PollerConfig<T> | null = null;
  private generation = -1;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the next run is due (epoch ms), null = nothing scheduled. */
  private dueAt: number | null = null;
  private failures = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PollingState<T> => this.snapshot;

  refresh = (): void => {
    if (this.config?.enabled) this.run();
  };

  start(config: PollerConfig<T>, generation: number): void {
    this.stop();
    if (generation !== this.generation) {
      if (this.generation !== -1) this.update({ data: null, error: null, loading: false, lastUpdated: null });
      this.generation = generation;
      this.failures = 0;
    }
    this.config = config;
    if (typeof document !== 'undefined' && config.pauseWhenHidden) {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (!config.enabled) return;
    if (config.runImmediately) this.schedule(0);
    else this.schedule(this.normalDelay());
  }

  stop(): void {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.clearTimer();
    this.dueAt = null;
    this.config = null;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
      this.update({ loading: false });
    }
  }

  private update(patch: Partial<PollingState<T>>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private normalDelay(): number | null {
    const interval = this.config?.intervalMs;
    return interval && interval > 0 ? interval : null;
  }

  private errorDelay(): number {
    const base = Math.min(this.normalDelay() ?? MAX_ERROR_BASE_MS, MAX_ERROR_BASE_MS);
    return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, this.failures - 1));
  }

  private schedule(delay: number | null): void {
    this.clearTimer();
    this.dueAt = delay === null ? null : Date.now() + delay;
    if (delay === null || (this.config?.pauseWhenHidden && isHidden())) return;
    this.timer = setTimeout(this.run, delay);
  }

  private onVisibilityChange = (): void => {
    if (!this.config?.enabled) return;
    if (isHidden()) {
      this.clearTimer();
      return;
    }
    if (this.controller || this.dueAt === null || this.timer !== null) return;
    this.timer = setTimeout(this.run, Math.max(0, this.dueAt - Date.now()));
  };

  private run = (): void => {
    const config = this.config;
    if (!config) return;
    this.clearTimer();
    this.dueAt = null;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.update({ loading: true });

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(config.fn(controller.signal));
    } catch (err) {
      pending = Promise.reject(err);
    }

    pending.then(
      (data) => {
        if (this.controller !== controller) return;
        this.controller = null;
        this.failures = 0;
        this.update({ data, error: null, loading: false, lastUpdated: Date.now() });
        this.schedule(this.normalDelay());
      },
      (err: unknown) => {
        if (this.controller !== controller) return;
        this.controller = null;
        this.failures += 1;
        this.update({ error: errorText(err), loading: false });
        this.schedule(this.errorDelay());
      },
    );
  };
}

function sameDeps(a: DependencyList, b: DependencyList): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/**
 * @param fn       loader; gets an AbortSignal that fires when the run is stale
 * @param intervalMs  null/0 = load once
 * @param deps     values the loader depends on (like useEffect deps)
 */
export function usePolling<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
  deps: DependencyList,
  options: PollingOptions = {},
): PollingResult<T> {
  const { pauseWhenHidden = true, runImmediately = true, enabled = true } = options;
  const [poller] = useState(() => new Poller<T>());
  const snapshot = useSyncExternalStore(poller.subscribe, poller.getSnapshot, poller.getSnapshot);

  // deps arrive as a fresh array every render: turn changes into a counter.
  const [tracked, setTracked] = useState(() => ({ deps, generation: 0 }));
  let generation = tracked.generation;
  if (!sameDeps(tracked.deps, deps)) {
    generation = tracked.generation + 1;
    setTracked({ deps, generation });
  }

  const load = useEffectEvent((signal: AbortSignal) => fn(signal));

  useEffect(() => {
    poller.start(
      { fn: (signal) => load(signal), intervalMs, pauseWhenHidden, runImmediately, enabled },
      generation,
    );
    return () => poller.stop();
  }, [poller, generation, intervalMs, pauseWhenHidden, runImmediately, enabled]);

  return useMemo(() => ({ ...snapshot, refresh: poller.refresh }), [snapshot, poller]);
}
