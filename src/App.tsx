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

const App: React.FC = () => {
  const { theme, accentColor } = useThemeStore();

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Apply accent color as CSS variable
  useEffect(() => {
    document.documentElement.style.setProperty('--accent-color', accentColor);
  }, [accentColor]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', maxWidth: '100vw', overflow: 'hidden' }}>
      <TopBar />
      <Dashboard />
    </div>
  );
};

export default App;
