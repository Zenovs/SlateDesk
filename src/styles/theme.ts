/**
 * Applies theme mode and accent colour to <html>.
 *
 * Used by main.tsx before the first paint (from a localStorage cache – the
 * backend state arrives asynchronously) and by App whenever state.theme
 * changes. Without a custom accent all accent variables are removed again, so
 * the theme's own tokens (tokens.css) apply.
 */
import type { ThemeData, ThemeMode } from '../state/types';

const THEME_CACHE_KEY = 'slatedesk-theme-cache';

/** Inline variables derived from a custom accent (removed when accent is null). */
const ACCENT_VARIABLES = [
  '--accent-color',
  '--accent-color-rgb',
  '--accent-color-light',
  '--accent-glow',
  '--text-accent',
  '--chart-line',
  '--chart-area',
] as const;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

/** Mixes `rgb` towards `target` by `amount` (0..1). */
const mix = (rgb: Rgb, target: number, amount: number): Rgb =>
  rgb.map((c) => Math.round(c + (target - c) * amount)) as Rgb;

const css = ([r, g, b]: Rgb): string => `rgb(${r}, ${g}, ${b})`;

function accentVariables(accent: string, mode: ThemeMode): Record<(typeof ACCENT_VARIABLES)[number], string> | null {
  const rgb = parseHex(accent);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  return {
    '--accent-color': css(rgb),
    '--accent-color-rgb': `${r}, ${g}, ${b}`,
    '--accent-color-light': css(mix(rgb, 255, 0.2)),
    '--accent-glow': `rgba(${r}, ${g}, ${b}, 0.25)`,
    // Light theme: text on light backgrounds needs a darker shade for contrast.
    '--text-accent': css(mode === 'light' ? mix(rgb, 0, 0.25) : rgb),
    '--chart-line': css(rgb),
    '--chart-area': `rgba(${r}, ${g}, ${b}, ${mode === 'light' ? 0.12 : 0.15})`,
  };
}

export function applyTheme(theme: ThemeData, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', theme.mode);
  const vars = theme.accent ? accentVariables(theme.accent, theme.mode) : null;
  for (const name of ACCENT_VARIABLES) {
    if (vars) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
}

export function readThemeCache(): ThemeData | null {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { mode, accent } = parsed as Record<string, unknown>;
    if (mode !== 'dark' && mode !== 'light') return null;
    return { mode, accent: typeof accent === 'string' && parseHex(accent) ? accent : null };
  } catch {
    return null;
  }
}

export function writeThemeCache(theme: ThemeData): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ mode: theme.mode, accent: theme.accent }));
  } catch {
    // Storage full or unavailable – the cache only prevents a flash at startup.
  }
}
