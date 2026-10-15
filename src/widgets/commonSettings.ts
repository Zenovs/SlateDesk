/**
 * Settings every widget has, appended to its own schema (section «Darstellung»).
 *
 * Pure data like the manifests: the web UI imports it through catalog.ts.
 * WidgetWrapper applies the values, so no widget has to know about them.
 */
import type { SettingsField } from '../types/settings';
import type { WidgetManifest } from '../types/widget';

/** Key in widgetSettings[instanceId]; percent, 100 = unchanged. */
export const FONT_SCALE_KEY = 'schriftgroesse';
export const FONT_SCALE_MIN = 60;
/** Upper end of the slider; a manifest may lower it with `maxFontScale` (widgets that fill their area). */
export const FONT_SCALE_MAX = 300;
export const FONT_SCALE_DEFAULT = 100;

const maxScaleOf = (manifest?: Pick<WidgetManifest, 'maxFontScale'>): number =>
  Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_DEFAULT, manifest?.maxFontScale ?? FONT_SCALE_MAX));

const commonSchema = (max: number): SettingsField[] => [
  { type: 'section', label: 'Darstellung' },
  {
    key: FONT_SCALE_KEY,
    type: 'range',
    label: 'Schriftgrösse',
    description:
      max > FONT_SCALE_DEFAULT
        ? 'Vergrössert oder verkleinert Text und Inhalt dieses Widgets – 100 % ist die normale Grösse.'
        : 'Verkleinert Text und Inhalt dieses Widgets. Grösser geht nicht: das Widget füllt seine Fläche schon ganz – dafür das Widget im Layout grösser ziehen.',
    min: FONT_SCALE_MIN,
    max,
    step: 5,
    unit: '%',
  },
];

const COMMON_DEFAULTS = { [FONT_SCALE_KEY]: FONT_SCALE_DEFAULT };

/** The manifest with the common settings appended (idempotent). */
export function withCommonSettings(manifest: WidgetManifest): WidgetManifest {
  const schema = manifest.settingsSchema ?? [];
  if (schema.some((field) => 'key' in field && field.key === FONT_SCALE_KEY)) return manifest;
  return {
    ...manifest,
    settingsSchema: [...schema, ...commonSchema(maxScaleOf(manifest))],
    defaultSettings: { ...(manifest.defaultSettings ?? {}), ...COMMON_DEFAULTS },
  };
}

/** Scale factor from a stored value: invalid or missing → 1, otherwise clamped to the widget's slider range. */
export function fontScaleOf(
  settings: Record<string, unknown> | undefined,
  manifest?: Pick<WidgetManifest, 'maxFontScale'>,
): number {
  const raw = settings?.[FONT_SCALE_KEY];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return 1;
  return Math.min(maxScaleOf(manifest), Math.max(FONT_SCALE_MIN, value)) / 100;
}
