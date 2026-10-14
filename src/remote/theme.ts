/**
 * Appearance of the web UI itself (not the kiosk's theme): follows the
 * operating system (prefers-color-scheme) unless the viewer picked light or
 * dark. The choice is remembered per browser.
 */
import { create } from 'zustand';
import { readLocal, writeLocal } from './storage';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface RemoteThemeState {
  preference: ThemePreference;
  systemDark: boolean;
}

const STORAGE_KEY = 'slatedesk-remote:theme';
/** Browser chrome colour (mobile address bar) – matches --bg-primary in remote.css. */
const THEME_COLORS: Record<ResolvedTheme, string> = { dark: '#0d0d0f', light: '#eef4f3' };

const darkQuery: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function storedPreference(): ThemePreference {
  const raw = readLocal(STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export const useRemoteTheme = create<RemoteThemeState>(() => ({
  preference: storedPreference(),
  systemDark: darkQuery?.matches ?? true,
}));

/** Selector: the theme actually shown. */
export const resolveTheme = (state: RemoteThemeState): ResolvedTheme =>
  state.preference === 'system' ? (state.systemDark ? 'dark' : 'light') : state.preference;

export function setThemePreference(preference: ThemePreference): void {
  writeLocal(STORAGE_KEY, preference === 'system' ? null : preference);
  useRemoteTheme.setState({ preference });
}

/** Switches to the other theme (an explicit choice from then on). */
export function toggleTheme(): void {
  setThemePreference(resolveTheme(useRemoteTheme.getState()) === 'dark' ? 'light' : 'dark');
}

function applyTheme(state: RemoteThemeState): void {
  const theme = resolveTheme(state);
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[theme];
}

let started = false;

/** Applies the theme before the first render and keeps `<html data-theme>` in sync for the page's lifetime. */
export function startRemoteTheme(): void {
  if (started) return;
  started = true;
  applyTheme(useRemoteTheme.getState());
  useRemoteTheme.subscribe(applyTheme);
  darkQuery?.addEventListener('change', (event) => useRemoteTheme.setState({ systemDark: event.matches }));
}
