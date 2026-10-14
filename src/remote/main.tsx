/**
 * Web UI (Fernsteuerung) entry, served by the kiosk's web server in the LAN.
 * Must never import widget components, the widget registry or
 * @tauri-apps/* (CONTRACT §7) – only manifests, the settings form, the state
 * layer and the lagra client.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/lato/400.css';
import '@fontsource/lato/700.css';
// Library and shared CSS first: remote.css overrides parts of them.
import 'react-grid-layout/css/styles.css';
import '../styles/tokens.css';
import '../components/settings/settings.css';
import './remote.css';
import { RemoteApp } from './App';
import { startRemoteTheme } from './theme';
import { ErrorBoundary } from './ui';

// Before the first render, so the page never flashes in the wrong theme.
startRemoteTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <RemoteApp />
    </ErrorBoundary>
  </StrictMode>,
);
