/**
 * Hooks shared by several widgets: a render-safe clock and lagra polling.
 */
import { type DependencyList, useEffect, useState } from 'react';
import { usePolling, type PollingResult } from '../../hooks/usePolling';
import { LagraError, type LagraErrorKind } from '../../lagra/client';
import { useAppState } from '../../state/appState';
import { isAbortError } from '../../state/transport';
import { isTauri, qrSvg } from '../../utils/backend';

/**
 * Current time (epoch ms), updated every `intervalMs`. Components use it
 * instead of calling Date.now() during render (relative times, ages).
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export interface QrImage {
  /** `data:image/svg+xml` URL for an <img>, null while rendering or on error. */
  src: string | null;
  error: string | null;
}

/**
 * QR code for `text`, rendered by the backend (kiosk only; outside it both
 * fields stay null). Used as <img> like in the remote info dialog: the SVG
 * cannot run anything and its currentColor resolves to black – put it on a
 * light background so phones can scan it in the dark theme too.
 */
export function useQrImage(text: string | null): QrImage {
  const [result, setResult] = useState<{ text: string; src: string | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!text || !isTauri()) return;
    let active = true;
    qrSvg(text).then(
      (svg) => {
        if (active) setResult({ text, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, error: null });
      },
      (err: unknown) => {
        if (active) setResult({ text, src: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      active = false;
    };
  }, [text]);

  const current = text !== null && result?.text === text ? result : null;
  return { src: current?.src ?? null, error: current?.error ?? null };
}

/** `ready` = switched on with URL and token; the others name what is missing. */
export type LagraSetup = 'ready' | 'disabled' | 'notConfigured';

function useLagraSetup(): LagraSetup {
  const enabled = useAppState((s) => s.state.lagra.enabled);
  const configured = useAppState((s) => s.state.lagra.url.trim() !== '' && s.state.lagra.token.trim() !== '');
  if (!configured) return 'notConfigured';
  return enabled ? 'ready' : 'disabled';
}

interface Failure {
  kind: LagraErrorKind;
  /** HTTP status if known, 0 otherwise. */
  status: number;
  /** epoch ms of the first failure after the last success. */
  since: number;
}

export interface LagraPollingResult<T> extends PollingResult<T> {
  setup: LagraSetup;
  /** Kind of the current error, null while the last run succeeded. */
  errorKind: LagraErrorKind | null;
  errorStatus: number | null;
  /** epoch ms since when lagra fails (for «nicht erreichbar seit 14:05»). */
  failingSince: number | null;
}

/**
 * usePolling for lagra requests: runs only while lagra is set up, starts
 * over when URL or token change, and keeps what kind of error the last run
 * had (usePolling itself only keeps the message).
 */
export function useLagraPolling<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: DependencyList,
  enabled = true,
): LagraPollingResult<T> {
  const setup = useLagraSetup();
  const url = useAppState((s) => s.state.lagra.url);
  const token = useAppState((s) => s.state.lagra.token);
  const [failure, setFailure] = useState<Failure | null>(null);

  const load = async (signal: AbortSignal): Promise<T> => {
    try {
      const data = await fn(signal);
      if (!signal.aborted) setFailure(null);
      return data;
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) {
        const kind: LagraErrorKind = err instanceof LagraError ? err.kind : 'http';
        const status = err instanceof LagraError ? err.status : 0;
        const at = Date.now();
        setFailure((prev) => ({ kind, status, since: prev?.since ?? at }));
      }
      throw err;
    }
  };

  const poll = usePolling(load, intervalMs, [...deps, url, token], { enabled: enabled && setup === 'ready' });
  const failing = poll.error !== null && failure !== null;
  return {
    ...poll,
    setup,
    errorKind: failing ? failure.kind : null,
    errorStatus: failing ? failure.status : null,
    failingSince: failing ? failure.since : null,
  };
}
