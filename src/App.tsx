/**
 * SlateDesk – Main Application
 * Phase 1 MVP: Dashboard with widget grid, theme system, and mock widgets.
 */
import React, { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { Dashboard } from './components/Dashboard';
import { useThemeStore } from './store/themeStore';
import { initializeWidgets } from './widgets';
import './styles/global.css';

// Register all widgets on app start
initializeWidgets();

const CURSOR_HIDE_DELAY = 50_000; // 50 Sekunden

const App: React.FC = () => {
  const { theme, accentColor } = useThemeStore();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--accent-color', accentColor);
  }, [accentColor]);

  // Mauszeiger nach 50s Stillstand ausblenden
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const hideCursor = () => { document.documentElement.classList.add('cursor-hidden'); };
    const showCursor = () => {
      document.documentElement.classList.remove('cursor-hidden');
      clearTimeout(timer);
      timer = setTimeout(hideCursor, CURSOR_HIDE_DELAY);
    };
    document.addEventListener('mousemove', showCursor);
    document.addEventListener('mousedown', showCursor);
    timer = setTimeout(hideCursor, CURSOR_HIDE_DELAY);
    return () => {
      document.removeEventListener('mousemove', showCursor);
      document.removeEventListener('mousedown', showCursor);
      clearTimeout(timer);
      document.documentElement.classList.remove('cursor-hidden');
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', maxWidth: '100vw', overflow: 'hidden' }}>
      <TopBar />
      <Dashboard />
    </div>
  );
};

export default App;
