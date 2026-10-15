/**
 * usePolling for planbar requests: runs only while planbar is set up, starts
 * over when the address, the Unternehmen or their keys change, and keeps
 * what kind of error the last run had (usePolling itself only keeps the
 * message).
 */
import { type DependencyList, useMemo, useState } from 'react';
import { usePolling, type PollingResult } from '../../hooks/usePolling';
import { PlanbarError, type PlanbarErrorKind } from '../../planbar/client';
import { configuredOrgs, orgsKey, resolveOrgs } from '../../planbar/orgs';
import type { PlanbarOrgRef } from '../../planbar/types';
import { useAppState } from '../../state/appState';
import { isAbortError } from '../../state/transport';

/** `ready` = switched on with an address and at least one Unternehmen with API key. */
export type PlanbarSetup = 'ready' | 'disabled' | 'notConfigured';

export interface PlanbarFailure {
  kind: PlanbarErrorKind;
  /** HTTP status if known, 0 otherwise. */
  status: number;
  /** German message (planbar's own text where it sent one). */
  message: string;
  /** Unternehmen the error came from, when several were asked. */
  org: PlanbarOrgRef | null;
  /** epoch ms of the first failure after the last success. */
  since: number;
}

export interface PlanbarPollingResult<T> extends PollingResult<T> {
  setup: PlanbarSetup;
  /** Error of the last run, null while it succeeded. */
  failure: PlanbarFailure | null;
}

/** Fingerprint of the Unternehmen and their keys («__gesetzt__» in the web UI) – a change starts the polling over. */
function connectionKey(unternehmen: Readonly<Record<string, { name: string; apiKey: string }>>): string {
  return Object.entries(unternehmen)
    .map(([id, org]) => `${id}\u0000${org.name}\u0000${org.apiKey}`)
    .sort()
    .join('\n');
}

export function usePlanbarSetup(): PlanbarSetup {
  const enabled = useAppState((s) => s.state.planbar.enabled);
  const configured = useAppState((s) => s.state.planbar.url.trim() !== '' && configuredOrgs(s.state.planbar).length > 0);
  if (!configured) return 'notConfigured';
  return enabled ? 'ready' : 'disabled';
}

/**
 * The Unternehmen a widget asks for its selection (empty = all set up), as a
 * stable array (same identity while nothing relevant changes).
 */
export function usePlanbarOrgs(selection: readonly string[]): PlanbarOrgRef[] {
  const key = useAppState((s) => orgsKey(resolveOrgs(selection, configuredOrgs(s.state.planbar))));
  return useMemo(() => JSON.parse(key) as PlanbarOrgRef[], [key]);
}

export function usePlanbarPolling<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: DependencyList,
  enabled = true,
): PlanbarPollingResult<T> {
  const setup = usePlanbarSetup();
  const url = useAppState((s) => s.state.planbar.url);
  const connection = useAppState((s) => connectionKey(s.state.planbar.unternehmen));
  const [failure, setFailure] = useState<PlanbarFailure | null>(null);

  const load = async (signal: AbortSignal): Promise<T> => {
    try {
      const data = await fn(signal);
      if (!signal.aborted) setFailure(null);
      return data;
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) {
        const planbarError = err instanceof PlanbarError ? err : null;
        const kind: PlanbarErrorKind = planbarError?.kind ?? 'http';
        const status = planbarError?.status ?? 0;
        const message = err instanceof Error ? err.message : String(err);
        const org = planbarError?.org ?? null;
        const at = Date.now();
        setFailure((prev) => ({ kind, status, message, org, since: prev?.since ?? at }));
      }
      throw err;
    }
  };

  const poll = usePolling(load, intervalMs, [...deps, url, connection], { enabled: enabled && setup === 'ready' });
  return { ...poll, setup, failure: poll.error !== null ? failure : null };
}
