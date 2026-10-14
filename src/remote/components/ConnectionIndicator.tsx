import { useAppState } from '../../state/appState';
import { useSession } from '../session';
import { StatusDot, type StatusTone } from '../ui';

type ConnectionState = 'live' | 'reconnecting' | 'offline';

const TEXT: Record<ConnectionState, { short: string; long: string; tone: StatusTone }> = {
  live: { short: 'Live', long: 'Live verbunden – Änderungen erscheinen sofort', tone: 'ok' },
  reconnecting: { short: 'Verbinde…', long: 'Verbindung zum Kiosk wird wiederhergestellt', tone: 'warn' },
  offline: { short: 'Offline', long: 'Kiosk nicht erreichbar', tone: 'error' },
};

/** Live state of the event stream to the kiosk (top bar). */
export function ConnectionIndicator() {
  const connected = useAppState((s) => s.connected);
  const reachable = useSession((s) => s.reachable);
  const state: ConnectionState = connected ? 'live' : reachable ? 'reconnecting' : 'offline';
  const { short, long, tone } = TEXT[state];
  return (
    <span className={`r-conn r-conn-${state}`} role="status" title={long}>
      <StatusDot tone={tone} pulse={state !== 'live'} />
      <span className="r-conn-text" aria-hidden="true">
        {short}
      </span>
      <span className="r-sr-only">{long}</span>
    </span>
  );
}
