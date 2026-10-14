/**
 * usePoll – runs `fetcher` now and then every `intervalMs` after the
 * previous run finished. Keeps the last good data on errors, pauses while
 * the tab is hidden (and catches up when it becomes visible) and while
 * logged out (the app stays mounted below the login, see App.tsx), aborts
 * the running request on unmount.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isAbortError } from '../../state/transport';
import { errorText } from '../errors';
import { useSession } from '../session';

export interface PollState<T> {
  /** Last successful result (kept when a later run fails). */
  data: T | null;
  /** German error of the last run, null after a success. */
  error: string | null;
  /** First load or a manual refresh is running. */
  loading: boolean;
  /** Epoch ms of the last success. */
  lastUpdated: number | null;
  /** Runs immediately (and restarts the interval). */
  refresh: () => void;
}

export interface PollOptions {
  /** false stops polling (data is kept). Default true. */
  enabled?: boolean;
  /** A change drops the data and loads again right away (e.g. another person chosen). */
  resetKey?: string | number;
}

interface PollResult<T> {
  /** resetKey the result belongs to – results of an older key are not shown. */
  key: string | number | undefined;
  data: T | null;
  error: string | null;
  lastUpdated: number | null;
}

export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  { enabled: wanted = true, resetKey }: PollOptions = {},
): PollState<T> {
  // Without a session every request would only collect a 401.
  const loggedIn = useSession((s) => s.status === 'authenticated');
  const enabled = wanted && loggedIn;
  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  const [result, setResult] = useState<PollResult<T>>({ key: resetKey, data: null, error: null, lastUpdated: null });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running: AbortController | null = null;

    const run = () => {
      timer = null;
      // Hidden tab: stop here, the visibility listener restarts.
      if (document.visibilityState === 'hidden') return;
      const controller = new AbortController();
      running = controller;
      fetcherRef.current(controller.signal)
        .then(
          (data) => {
            if (!disposed && !controller.signal.aborted) {
              setResult({ key: resetKey, data, error: null, lastUpdated: Date.now() });
            }
          },
          (err: unknown) => {
            if (disposed || controller.signal.aborted || isAbortError(err)) return;
            const error = errorText(err);
            setResult((prev) =>
              prev.key === resetKey ? { ...prev, error } : { key: resetKey, data: null, error, lastUpdated: null },
            );
          },
        )
        .finally(() => {
          if (disposed || running !== controller) return;
          running = null;
          setRefreshing(false);
          if (intervalMs > 0) timer = setTimeout(run, intervalMs);
        });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && timer === null && running === null) run();
    };

    run();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      running?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, nonce, resetKey]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setRefreshing(true);
    setNonce((n) => n + 1);
  }, [enabled]);

  const current = result.key === resetKey ? result : { data: null, error: null, lastUpdated: null };
  const initial = enabled && current.lastUpdated === null && current.error === null;
  return {
    data: current.data,
    error: current.error,
    lastUpdated: current.lastUpdated,
    loading: initial || refreshing,
    refresh,
  };
}
