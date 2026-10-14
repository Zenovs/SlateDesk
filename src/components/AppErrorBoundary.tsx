/**
 * AppErrorBoundary – last line of defence: instead of a white screen the
 * kiosk shows a recovery screen and reloads itself. Repeated crashes back
 * off (30 s, 1, 2, 4 … max 10 min) so a persistent error can't loop hot.
 */
import React from 'react';

const CRASH_KEY = 'slatedesk-crash';
const FIRST_RELOAD_MS = 30_000;
const MAX_RELOAD_MS = 10 * 60_000;
/** A crash this long after the previous one starts the backoff over. */
const CRASH_STREAK_RESET_MS = 15 * 60_000;

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  reloadInSeconds: number | null;
}

/** Counts consecutive crashes across reloads; returns the reload delay. */
function registerCrash(): number {
  let count = 0;
  try {
    const raw = sessionStorage.getItem(CRASH_KEY);
    const previous = raw ? (JSON.parse(raw) as { count?: unknown; at?: unknown }) : null;
    if (previous && typeof previous.count === 'number' && typeof previous.at === 'number' && Date.now() - previous.at < CRASH_STREAK_RESET_MS) {
      count = previous.count;
    }
    sessionStorage.setItem(CRASH_KEY, JSON.stringify({ count: count + 1, at: Date.now() }));
  } catch {
    // Storage unavailable – plain fixed delay.
  }
  return Math.min(MAX_RELOAD_MS, FIRST_RELOAD_MS * 2 ** count);
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, reloadInSeconds: null };
  private reloadAt = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('SlateDesk ist abgestürzt:', error, info.componentStack);
    if (this.ticker !== null) return;
    this.reloadAt = Date.now() + registerCrash();
    this.tick();
    this.ticker = setInterval(this.tick, 1000);
  }

  componentWillUnmount(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  private tick = (): void => {
    const remaining = Math.max(0, Math.ceil((this.reloadAt - Date.now()) / 1000));
    if (remaining === 0) {
      window.location.reload();
      return;
    }
    this.setState({ reloadInSeconds: remaining });
  };

  render(): React.ReactNode {
    const { error, reloadInSeconds } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fullscreen-state" role="alert">
        <div className="fullscreen-state-logo">SLATEDESK</div>
        <div className="fullscreen-state-text">Etwas ist schiefgelaufen.</div>
        {error.message && <div className="fullscreen-state-detail fullscreen-state-error">{error.message}</div>}
        <button type="button" className="topbar-btn primary" onClick={() => window.location.reload()}>
          Neu laden
        </button>
        {reloadInSeconds !== null && (
          <div className="fullscreen-state-detail">Automatischer Neustart in {reloadInSeconds} s</div>
        )}
      </div>
    );
  }
}
