/**
 * LoadingScreen – shown until the dashboard state has been loaded from the
 * backend (the stores only hold defaults before that).
 */
import React from 'react';

interface Props {
  /** Last load error – loading is retried automatically. */
  error?: string | null;
  /** Kiosk UI opened through the SlateDesk web server without a session. */
  unauthorized?: boolean;
}

export const LoadingScreen: React.FC<Props> = ({ error, unauthorized }) => {
  if (unauthorized) {
    return (
      <div className="fullscreen-state" role="alert">
        <div className="fullscreen-state-logo">SLATEDESK</div>
        <div className="fullscreen-state-text">
          Nicht angemeldet. Bitte zuerst in der <a href="/remote.html">Fernsteuerung</a> mit der PIN anmelden und
          diese Seite danach neu laden.
        </div>
      </div>
    );
  }

  return (
    <div className="fullscreen-state" role="status" aria-live="polite">
      <div className="fullscreen-state-logo">SLATEDESK</div>
      <div className="loading-spinner" />
      <div className="fullscreen-state-text">{error ? 'Verbindung zum Backend wird erneut versucht…' : 'Wird geladen…'}</div>
      {error && <div className="fullscreen-state-detail fullscreen-state-error">{error}</div>}
    </div>
  );
};
