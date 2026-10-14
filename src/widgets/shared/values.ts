/**
 * Defensive readers for widget settings and shared display types.
 *
 * Stored settings come from the kiosk dialog, the web UI or an import and
 * are never trusted: a wrong type falls back to the manifest default instead
 * of breaking the widget.
 */

/** Colour role of a status, dot, banner or meter (mapped to theme tokens in parts.css). */
export type Tone = 'neutral' | 'ok' | 'warn' | 'error' | 'accent';

const TONE_RANK: Record<Tone, number> = { neutral: 0, accent: 0, ok: 1, warn: 2, error: 3 };

/** The more severe of two tones (error > warn > ok > neutral). */
export const worseTone = (a: Tone, b: Tone): Tone => (TONE_RANK[b] > TONE_RANK[a] ? b : a);

/** Fill level → tone: from 75 % warn, from 90 % error. */
export const usageTone = (percent: number): Tone => (percent >= 90 ? 'error' : percent >= 75 ? 'warn' : 'accent');

/** Temperature → tone with the given warn / error thresholds in °C. */
export const temperatureTone = (celsius: number | null | undefined, warnAt: number, errorAt: number): Tone =>
  celsius === null || celsius === undefined ? 'neutral' : celsius >= errorAt ? 'error' : celsius >= warnAt ? 'warn' : 'neutral';

export const readBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

export const readString = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

/** Finite number clamped to [min, max], rounded when `integer`. */
export function readNumber(value: unknown, fallback: number, min: number, max: number, integer = true): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  return integer ? Math.round(clamped) : clamped;
}

export function readChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value) ? (value as T) : fallback;
}
