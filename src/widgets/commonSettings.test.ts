import { describe, expect, it } from 'vitest';
import type { WidgetManifest } from '../types/widget';
import { widgetCatalog } from './catalog';
import { FONT_SCALE_KEY, fontScaleOf, withCommonSettings } from './commonSettings';

const bare: WidgetManifest = {
  id: 'test',
  name: 'Test',
  description: '',
  version: '1.0.0',
  author: 'SlateDesk',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 3,
  defaultHeight: 3,
  permissions: [],
  settingsSchema: [{ key: 'farbe', type: 'text', label: 'Farbe' }],
  defaultSettings: { farbe: 'rot' },
};

describe('common widget settings', () => {
  it('appends «Darstellung → Schriftgrösse» with default 100 and keeps the own settings', () => {
    const manifest = withCommonSettings(bare);
    expect(manifest.settingsSchema?.map((f) => ('key' in f ? f.key : f.label))).toEqual(['farbe', 'Darstellung', FONT_SCALE_KEY]);
    expect(manifest.defaultSettings).toEqual({ farbe: 'rot', [FONT_SCALE_KEY]: 100 });
    expect(bare.settingsSchema).toHaveLength(1);
  });

  it('lets widgets that fill their area only shrink (maxFontScale)', () => {
    const filling = withCommonSettings({ ...bare, maxFontScale: 100 });
    const field = filling.settingsSchema?.find((f) => 'key' in f && f.key === FONT_SCALE_KEY);
    expect(field).toMatchObject({ type: 'range', min: 60, max: 100 });
    expect(fontScaleOf({ [FONT_SCALE_KEY]: 130 }, { maxFontScale: 100 })).toBe(1);
    expect(fontScaleOf({ [FONT_SCALE_KEY]: 80 }, { maxFontScale: 100 })).toBe(0.8);
    expect(widgetCatalog.find((m) => m.id === 'clock')?.maxFontScale).toBe(100);
    expect(widgetCatalog.find((m) => m.id === 'qrcode')?.maxFontScale).toBe(100);
  });

  it('is idempotent', () => {
    const once = withCommonSettings(bare);
    expect(withCommonSettings(once)).toBe(once);
  });

  it('is part of every widget in the catalog, and no widget uses the key itself', () => {
    for (const manifest of widgetCatalog) {
      const keys = (manifest.settingsSchema ?? []).flatMap((f) => ('key' in f ? [f.key] : []));
      expect(keys.filter((k) => k === FONT_SCALE_KEY), manifest.id).toHaveLength(1);
      expect(keys.at(-1), manifest.id).toBe(FONT_SCALE_KEY);
    }
  });

  it('turns stored values into a clamped scale factor', () => {
    expect(fontScaleOf(undefined)).toBe(1);
    expect(fontScaleOf({})).toBe(1);
    expect(fontScaleOf({ [FONT_SCALE_KEY]: 125 })).toBe(1.25);
    expect(fontScaleOf({ [FONT_SCALE_KEY]: '80' })).toBe(0.8);
    expect(fontScaleOf({ [FONT_SCALE_KEY]: 10 })).toBe(0.6);
    expect(fontScaleOf({ [FONT_SCALE_KEY]: 999 })).toBe(1.5);
    expect(fontScaleOf({ [FONT_SCALE_KEY]: 'gross' })).toBe(1);
    expect(fontScaleOf({ [FONT_SCALE_KEY]: null })).toBe(1);
  });
});
