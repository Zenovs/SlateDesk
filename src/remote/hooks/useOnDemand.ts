/**
 * useOnDemand – runs an async task only when asked (button), e.g. a slow
 * query. Keeps the last good result on errors, aborts a running task when a
 * new one starts and on unmount.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isAbortError } from '../../state/transport';
import { errorText } from '../errors';

export interface OnDemandState<T> {
  /** Last successful result. */
  data: T | null;
  /** German error of the last run, null after a success. */
  error: string | null;
  loading: boolean;
  /** Epoch ms of the last success. */
  lastUpdated: number | null;
  run: () => void;
}

interface Result<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  lastUpdated: number | null;
}

export function useOnDemand<T>(task: (signal: AbortSignal) => Promise<T>): OnDemandState<T> {
  const taskRef = useRef(task);
  useLayoutEffect(() => {
    taskRef.current = task;
  });
  const running = useRef<AbortController | null>(null);
  const [result, setResult] = useState<Result<T>>({ data: null, error: null, loading: false, lastUpdated: null });

  useEffect(() => () => running.current?.abort(), []);

  const run = useCallback(() => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setResult((prev) => ({ ...prev, loading: true, error: null }));
    taskRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ data, error: null, loading: false, lastUpdated: Date.now() });
      },
      (err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setResult((prev) => ({ ...prev, error: errorText(err), loading: false }));
      },
    );
  }, []);

  return { ...result, run };
}
