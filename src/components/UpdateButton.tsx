/**
 * UpdateButton – shows the kiosk updater (useUpdater, owned by TopBar so a
 * hidden top bar does not lose a running update) in the top bar.
 */
import React from 'react';
import { AlertCircle, Check, CheckCircle2, Download, RefreshCw } from 'lucide-react';
import type { Updater } from '../hooks/useUpdater';

const changes = (count: number): string => (count === 1 ? '1 Änderung' : `${count} Änderungen`);

export const UpdateButton: React.FC<{ updater: Updater }> = ({ updater }) => {
  const { state, check, confirm, start } = updater;

  switch (state.phase) {
    case 'idle':
      return (
        <button type="button" className="topbar-btn subtle" onClick={check} title="Auf Updates prüfen" aria-label="Auf Updates prüfen">
          <RefreshCw size={16} />
        </button>
      );
    case 'checking':
      return (
        <button type="button" className="topbar-btn subtle" disabled title="Suche nach Updates…" aria-label="Suche nach Updates">
          <RefreshCw size={16} className="spin" />
        </button>
      );
    case 'current':
      return (
        <button
          type="button"
          className="topbar-btn subtle"
          onClick={check}
          title={`Aktuell (${state.info.short_current}) – erneut prüfen`}
          aria-label="SlateDesk ist aktuell – erneut prüfen"
        >
          <Check size={16} />
        </button>
      );
    case 'available': {
      const { info } = state;
      const details = `${info.short_current} → ${info.short_remote}${info.behind > 0 ? ` (${changes(info.behind)})` : ''}`;
      return state.confirming ? (
        <button type="button" className="topbar-btn primary" onClick={start} title={`Update installieren: ${details}`}>
          <Download size={16} />
          Jetzt installieren? Neustart folgt
        </button>
      ) : (
        <button type="button" className="topbar-btn primary" onClick={() => confirm(true)} title={`Update verfügbar: ${details}`}>
          <Download size={16} />
          Update
        </button>
      );
    }
    case 'starting':
    case 'running': {
      const percent = state.phase === 'running' ? state.percent : 0;
      const message = state.phase === 'running' ? state.message : 'Update wird gestartet…';
      return (
        <div className="update-progress" role="status" aria-live="polite">
          <div className="update-progress-row">
            <RefreshCw size={13} className="spin" />
            <span className="update-progress-percent">{percent}%</span>
            <span className="update-progress-message">{message}</span>
          </div>
          <div className="update-progress-track">
            <div className="update-progress-bar" style={{ width: `${percent}%` }} />
          </div>
        </div>
      );
    }
    case 'done':
      return (
        <span className="topbar-btn" role="status" title={state.message}>
          <CheckCircle2 size={16} />
          <span className="topbar-btn-label">{state.message}</span>
        </span>
      );
    case 'error':
      return (
        <button type="button" className="topbar-btn danger" onClick={check} title={`${state.message} – tippen für neue Prüfung`}>
          <AlertCircle size={16} />
          <span className="topbar-btn-label">{state.message}</span>
        </button>
      );
  }
};
