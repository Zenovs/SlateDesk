/**
 * Theme Store – Manages light/dark theme state.
 * Persists theme preference to localStorage.
 */
import { create } from 'zustand';
import type { ThemeMode } from '../types/widget';

interface ThemeState {
  theme: ThemeMode;
  accentColor: string;
  toggleTheme: () => void;
  setTheme: (theme: ThemeMode) => void;
  setAccentColor: (color: string) => void;
}

const getStoredTheme = (): ThemeMode => {
  const stored = localStorage.getItem('slatedesk-theme');
  return (stored === 'light' || stored === 'dark') ? stored : 'dark';
};

const getStoredAccent = (): string => {
  return localStorage.getItem('slatedesk-accent') || '#e8642b';
};

export const useThemeStore = create<ThemeState>((set) => ({
  theme: getStoredTheme(),
  accentColor: getStoredAccent(),
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('slatedesk-theme', next);
      return { theme: next };
    }),
  setTheme: (theme) => {
    localStorage.setItem('slatedesk-theme', theme);
    set({ theme });
  },
  setAccentColor: (color) => {
    localStorage.setItem('slatedesk-accent', color);
    set({ accentColor: color });
  },
}));
