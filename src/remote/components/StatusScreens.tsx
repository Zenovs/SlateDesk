/**
 * Full-screen states before the app shell: connecting, kiosk unreachable,
 * state loading.
 */
import { useState, type ReactNode } from 'react';
import { LayoutDashboard, RotateCcw, WifiOff } from 'lucide-react';
import { checkSession } from '../session';
import { Button, Spinner } from '../ui';
import { ThemeToggle } from './ThemeControls';

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="r-fullscreen">
      <div className="r-fullscreen-corner">
        <ThemeToggle />
      </div>
      {children}
    </div>
  );
}

export function SplashScreen() {
  return (
    <Screen>
      <div className="r-status-card" aria-live="polite">
        <span className="r-status-icon" aria-hidden="true">
          <LayoutDashboard size={28} />
        </span>
        <h1 className="r-status-title">SlateDesk Fernsteuerung</h1>
        <Spinner label="Verbinde mit dem Kiosk…" />
        <p className="r-status-text">Verbinde mit dem Kiosk…</p>
      </div>
    </Screen>
  );
}

/** The first request got no answer; App retries every 10 s. */
export function UnreachableScreen() {
  const [busy, setBusy] = useState(false);
  return (
    <Screen>
      <div className="r-status-card" role="alert">
        <span className="r-status-icon r-status-icon-error" aria-hidden="true">
          <WifiOff size={28} />
        </span>
        <h1 className="r-status-title">Kiosk nicht erreichbar</h1>
        <p className="r-status-text">
          Die Fernsteuerung bekommt keine Antwort. Ist der Kiosk eingeschaltet und dieses Gerät im selben Netzwerk?
        </p>
        <p className="r-status-detail">Es wird alle 10 Sekunden erneut versucht.</p>
        <Button
          variant="primary"
          icon={RotateCcw}
          busy={busy}
          onClick={() => {
            setBusy(true);
            void checkSession().finally(() => setBusy(false));
          }}
        >
          Jetzt erneut versuchen
        </Button>
      </div>
    </Screen>
  );
}

/** Logged in, waiting for the first state snapshot (appState retries on its own). */
export function LoadingScreen({ error }: { error: string | null }) {
  return (
    <Screen>
      <div className="r-status-card" aria-live="polite">
        <span className="r-status-icon" aria-hidden="true">
          <LayoutDashboard size={28} />
        </span>
        <h1 className="r-status-title">Daten werden geladen</h1>
        <Spinner label="Daten werden geladen…" />
        {error && (
          <>
            <p className="r-status-text">Verbindung wird erneut versucht…</p>
            <p className="r-status-detail">{error}</p>
          </>
        )}
      </div>
    </Screen>
  );
}
