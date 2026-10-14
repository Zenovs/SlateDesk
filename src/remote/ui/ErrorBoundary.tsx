import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';

interface ErrorBoundaryState {
  error: Error | null;
}

/** Last line of defence: a render error shows a German message with «Neu laden» instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Fernsteuerung: unerwarteter Fehler', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="r-fullscreen">
        <div className="r-status-card" role="alert">
          <span className="r-status-icon r-status-icon-error" aria-hidden="true">
            <TriangleAlert size={28} />
          </span>
          <h1 className="r-status-title">Etwas ist schiefgelaufen</h1>
          <p className="r-status-text">Die Fernsteuerung ist auf einen unerwarteten Fehler gestossen.</p>
          <p className="r-status-detail">{error.message}</p>
          <button type="button" className="r-btn r-btn-primary r-btn-md" onClick={() => window.location.reload()}>
            <RotateCcw size={18} aria-hidden="true" />
            <span className="r-btn-label">Neu laden</span>
          </button>
        </div>
      </div>
    );
  }
}
