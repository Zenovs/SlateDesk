/**
 * Theme Store – light/dark mode and accent colour.
 * Mirrors `state.theme` of the backend state (useAppState).
 */
import { create } from 'zustand';
import { useAppState } from '../state/appState';
import { themeActions } from '../state/dataActions';
import type { ThemeData, ThemeMode } from '../state/types';

interface ThemeState {
  theme: ThemeMode;
  /**
   * User-chosen accent colour (hex) or `null` = the active theme's own accent.
   * When null, don't set `--accent-color` inline (remove the property), so the
   * theme tokens apply.
   */
  accentColor: string | null;
  toggleTheme: () => void;
  setTheme: (theme: ThemeMode) => void;
  /** `null` resets to the theme default. */
  setAccentColor: (color: string | null) => void;
}

const fromTheme = (theme: ThemeData) => ({ theme: theme.mode, accentColor: theme.accent ?? null });

export const useThemeStore = create<ThemeState>()(() => ({
  ...fromTheme(useAppState.getState().state.theme),
  toggleTheme: () => {
    void themeActions.toggle();
  },
  setTheme: (theme) => {
    void themeActions.setMode(theme);
  },
  setAccentColor: (color) => {
    void themeActions.setAccent(color);
  },
}));

const unsubscribe = useAppState.subscribe((next, prev) => {
  if (next.state.theme !== prev.state.theme) useThemeStore.setState(fromTheme(next.state.theme));
});
import.meta.hot?.dispose(unsubscribe);
