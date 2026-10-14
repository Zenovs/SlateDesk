import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/lato/300.css';
import '@fontsource/lato/400.css';
import '@fontsource/lato/700.css';
// Library CSS first: global.css overrides parts of it with equal specificity.
import 'react-grid-layout/css/styles.css';
import './styles/global.css';
import './styles/shell.css';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { applyTheme, readThemeCache } from './styles/theme';
import App from './App.tsx';

// Theme before the first paint: the backend state arrives asynchronously, so
// the last known theme is cached locally (an inline script would violate the CSP).
const cachedTheme = readThemeCache();
if (cachedTheme) applyTheme(cachedTheme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
