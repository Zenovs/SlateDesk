/**
 * Web UI root: session gate (connecting → login → app) and the watchers
 * that send the browser back to the login page when the session ends.
 */
import { useEffect } from 'react';
import { useAppState } from '../state/appState';
import { SessionOverlay } from './components/SessionOverlay';
import { Shell } from './components/Shell';
import { LoadingScreen, SplashScreen, UnreachableScreen } from './components/StatusScreens';
import { useKioskName } from './hooks/useKioskName';
import { LoginPage } from './pages/LoginPage';
import { appShown, checkSession, sessionExpired, setReachable, useSession, type SessionStatus } from './session';
import { Toaster } from './ui';

/** Status checks while the event stream is down (detects expired sessions and kiosk restarts). */
const STATUS_POLL_MS = 10_000;
/** First check after the stream dropped – it usually reconnects within a second. */
const FIRST_STATUS_CHECK_MS = 3_000;

function useSessionWatch(status: SessionStatus): void {
  const unauthorized = useAppState((s) => s.unauthorized);
  const connected = useAppState((s) => s.connected);

  useEffect(() => {
    if (status === 'authenticated' && unauthorized) sessionExpired();
  }, [status, unauthorized]);

  useEffect(() => {
    if (connected) setReachable(true);
  }, [connected]);

  // The SSE stream ends with the session; while it is down, ask the kiosk
  // whether we are still logged in.
  useEffect(() => {
    if (status !== 'authenticated' || connected) return;
    const first = setTimeout(() => void checkSession(), FIRST_STATUS_CHECK_MS);
    const interval = setInterval(() => void checkSession(), STATUS_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [status, connected]);

  useEffect(() => {
    if (status !== 'unreachable') return;
    const interval = setInterval(() => void checkSession(), STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [status]);
}

/**
 * Once shown, the app stays mounted when the session ends: login and the
 * reload after it cover it (SessionOverlay), so an editor sheet that was
 * open keeps its text and can be saved after logging in again.
 */
function AuthenticatedApp({ status }: { status: SessionStatus }) {
  const ready = useAppState((s) => s.ready);
  const error = useAppState((s) => s.error);
  const unauthorized = useAppState((s) => s.unauthorized);
  const keepApp = useSession((s) => s.keepApp);

  useEffect(() => {
    if (status === 'authenticated' && ready) appShown();
  }, [status, ready]);

  if (!keepApp) return ready ? <Shell /> : <LoadingScreen error={error} />;
  return (
    <>
      <Shell />
      {(status !== 'authenticated' || !ready) && (
        <SessionOverlay>
          {/* A 401 shows the login at once (the session watch switches the status right after). */}
          {status === 'authenticated' && !unauthorized ? <LoadingScreen error={error} /> : <LoginPage />}
        </SessionOverlay>
      )}
    </>
  );
}

export function RemoteApp() {
  const status = useSession((s) => s.status);
  const keepApp = useSession((s) => s.keepApp);
  const name = useKioskName();

  useEffect(() => {
    void checkSession();
  }, []);

  useEffect(() => {
    document.title = `${name} – Fernsteuerung`;
  }, [name]);

  useSessionWatch(status);

  return (
    <>
      {status === 'checking' && <SplashScreen />}
      {status === 'unreachable' && <UnreachableScreen />}
      {status === 'login' && !keepApp && <LoginPage />}
      {(status === 'authenticated' || (status === 'login' && keepApp)) && <AuthenticatedApp status={status} />}
      <Toaster />
    </>
  );
}
