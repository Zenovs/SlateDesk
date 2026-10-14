/**
 * usePolling for planbar requests: runs only while planbar is set up, starts
 * over when address or key change, and keeps what kind of error the last
 * run had (usePolling itself only keeps the message).
 */
import { type DependencyList, useState } from 'react';
import { usePolling, type PollingResult } from '../../hooks/usePolling';
import { PlanbarError, type PlanbarErrorKind } from '../../planbar/client';
import { useAppState } from '../../state/appState';
import { isAbortError } from '../../state/transport';

/** `ready` = switched on with address and API key; the others name what is missing. */
export type PlanbarSetup = 'ready' | 'disabled' | 'notConfigured';

export interface PlanbarFailure {
  kind: PlanbarErrorKind;
  /** HTTP status if known, 0 otherwise. */
  status: number;
  /** German message (planbar's own text where it sent one). */
  message: string;
  /** epoch ms of the first failure after the last success. */
  since: number;
}

export interface PlanbarPollingResult<T> extends PollingResult<T> {
  setup: PlanbarSetup;
  /** Error of the last run, null while it succeeded. */
  failure: PlanbarFailure | null;
}

export function usePlanbarSetup(): PlanbarSetup {
  const enabled = useAppState((s) => s.state.planbar.enabled);
  const configured = useAppState((s) => s.state.planbar.url.trim() !== '' && s.state.planbar.apiKey.trim() !== '');
  if (!configured) return 'notConfigured';
  return enabled ? 'ready' : 'disabled';
}

export function usePlanbarPolling<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: DependencyList,
  enabled = true,
): PlanbarPollingResult<T> {
  const setup = usePlanbarSetup();
  const url = useAppState((s) => s.state.planbar.url);
  const apiKey = useAppState((s) => s.state.planbar.apiKey);
  const [failure, setFailure] = useState<PlanbarFailure | null>(null);

  const load = async (signal: AbortSignal): Promise<T> => {
    try {
      const data = await fn(signal);
      if (!signal.aborted) setFailure(null);
      return data;
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) {
        const kind: PlanbarErrorKind = err instanceof PlanbarError ? err.kind : 'http';
        const status = err instanceof PlanbarError ? err.status : 0;
        const message = err instanceof Error ? err.message : String(err);
        const at = Date.now();
        setFailure((prev) => ({ kind, status, message, since: prev?.since ?? at }));
      }
      throw err;
    }
  };

  const poll = usePolling(load, intervalMs, [...deps, url, apiKey], { enabled: enabled && setup === 'ready' });
  return { ...poll, setup, failure: poll.error !== null ? failure : null };
}
