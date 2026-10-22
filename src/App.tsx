/**
 * SlateDesk – kiosk application shell.
 *
 * Loads the dashboard state from the backend (Tauri; in a plain browser the
 * localStorage dev transport), migrates the pre-backend localStorage data
 * once, and wires kiosk behaviour: theme, cursor auto-hide, display
 * schedule and the actions sent from the web UI (Fernsteuerung).
 */
import React, { useEffect, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { HostAlertOverlay } from './components/HostAlertOverlay';
import { IdentifyOverlay } from './components/IdentifyOverlay';
import { LoadingScreen } from './components/LoadingScreen';
import { TopBar } from './components/TopBar';
import { useCursorAutoHide } from './hooks/useCursorAutoHide';
import { DISPLAY_SWITCHED_EVENT, useDisplaySchedule, type DisplaySwitchedEvent } from './hooks/useDisplaySchedule';
import { initAppState, useAppState } from './state/appState';
import { useLayoutStore } from './store/layoutStore';
import { applyTheme, writeThemeCache } from './styles/theme';
import { onKioskAction } from './utils/backend';
import { eventBus } from './utils/eventBus';
import { initializeWidgets } from './widgets';
import { knownWidgetIds } from './widgets/catalog';

// Register all widgets on app start
initializeWidgets();

const IDENTIFY_MS = 10_000;

const KioskShell: React.FC = () => {
  const theme = useAppState((s) => s.state.theme);
  const kioskName = useAppState((s) => s.state.kiosk.name);
  const schedule = useAppState((s) => s.state.kiosk.displaySchedule);
  const display = useDisplaySchedule(schedule);
  /** > 0 while the identify overlay is shown; a new request restarts the 10 s. */
  const [identifyTick, setIdentifyTick] = useState(0);

  useEffect(() => {
    applyTheme(theme);
    writeThemeCache(theme);
  }, [theme]);

  useEffect(
    () =>
      onKioskAction(({ action, value }) => {
        switch (action) {
          case 'reload':
            window.location.reload();
            break;
          case 'identify':
            setIdentifyTick((tick) => tick + 1);
            break;
          case 'edit-mode': {
            const layout = useLayoutStore.getState();
            layout.setEditMode(typeof value === 'boolean' ? value : !layout.editMode);
            break;
          }
          case 'display-wake':
          case 'display-sleep':
            eventBus.emit(DISPLAY_SWITCHED_EVENT, { on: action === 'display-wake' } satisfies DisplaySwitchedEvent);
            break;
        }
      }),
    [],
  );

  useEffect(() => {
    if (identifyTick === 0) return;
    const timer = setTimeout(() => setIdentifyTick(0), IDENTIFY_MS);
    return () => clearTimeout(timer);
  }, [identifyTick]);

  return (
    <div className="app-shell">
      <TopBar />
      <Dashboard />
      <HostAlertOverlay />
      {identifyTick > 0 && <IdentifyOverlay name={kioskName} onClose={() => setIdentifyTick(0)} />}
      {!display.active && <div className={`display-blackout${display.blackout ? ' dark' : ''}`} aria-hidden="true" />}
    </div>
  );
};

const App: React.FC = () => {
  const ready = useAppState((s) => s.ready);
  const error = useAppState((s) => s.error);
  const unauthorized = useAppState((s) => s.unauthorized);
  const cursorHideSeconds = useAppState((s) => s.state.kiosk.cursorHideSeconds);

  useEffect(() => {
    initAppState('auto', { knownWidgetIds: knownWidgetIds() }).catch((err: unknown) => {
      // Only a missing web session ends the retries (shown by LoadingScreen).
      console.error('Dashboard-Zustand konnte nicht geladen werden:', err);
    });
  }, []);

  useCursorAutoHide(cursorHideSeconds);

  return ready ? <KioskShell /> : <LoadingScreen error={error} unauthorized={unauthorized} />;
};

export default App;
