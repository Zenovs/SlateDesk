/**
 * Integrity of the widget manifests – the contract between widgets, the
 * kiosk shell, the web UI and the backend's secret redaction.
 */
import { describe, expect, it } from 'vitest';
import { hasOptionProvider } from '../components/settings/optionProviders';
import { WIDGET_ICONS } from '../components/settings/widgetIcons';
import { PLANBAR_MEMBERS_PROVIDER, PLANBAR_PROJECTS_PROVIDER } from '../planbar/options';
import { DEFAULT_COLS, DEFAULT_STATE } from '../state/defaults';
import { GRID_CONTAINER_PADDING, GRID_MARGIN } from '../types/grid';
import { isSecretKey, type SettingsField, type ValueField } from '../types/settings';
import { getManifest, WIDGET_CATEGORIES, widgetCatalog } from './catalog';

/** Reference kiosk screen (1920×1080) minus its top bar (`.topbar` in src/styles/shell.css). */
const KIOSK_DASHBOARD_HEIGHT = 1080 - 52;

/** Every value field, including the item fields of `list` fields. */
function valueFields(schema: readonly SettingsField[], prefix = ''): { path: string; field: ValueField }[] {
  return schema.flatMap((field) => {
    if (field.type === 'section') return [];
    const path = `${prefix}${field.key}`;
    const own = { path, field };
    return field.type === 'list' ? [own, ...valueFields(field.itemFields, `${path}[].`)] : [own];
  });
}

/**
 * Choice fields against their defaults (manifest defaults, `newItem()` inside
 * lists): a multiselect stores a list of ids, static choices must contain the
 * defaults, and a named options provider must be registered – by importing its
 * module (e.g. src/planbar/options.ts) from the manifest.
 */
function checkChoiceFields(schema: readonly SettingsField[], values: Record<string, unknown>, prefix = ''): void {
  for (const field of schema) {
    if (field.type === 'section') continue;
    const path = `${prefix}${field.key}`;
    const value = values[field.key];
    if (field.type === 'list') {
      checkChoiceFields(field.itemFields, field.newItem(), `${path}[].`);
      continue;
    }
    if (field.type !== 'select' && field.type !== 'multiselect') continue;
    if (field.optionsProvider !== undefined) {
      expect(hasOptionProvider(field.optionsProvider), `«${path}»: options provider «${field.optionsProvider}» is not registered`).toBe(
        true,
      );
    }
    if (field.type === 'multiselect') {
      const list = Array.isArray(value) ? value : null;
      expect(list !== null && list.every((item) => typeof item === 'string'), `«${path}»: default must be a list of strings`).toBe(true);
      if (field.optionsProvider === undefined) {
        const known = (field.options ?? []).map((option) => option.value);
        for (const item of list ?? []) expect(known, `«${path}»: default «${String(item)}»`).toContain(item);
      }
    } else if (field.optionsProvider !== undefined) {
      // Loaded choices are strings; the static ones (e.g. «niemand») may be anything.
      const fixed = field.options.map((option) => option.value);
      expect(typeof value === 'string' || fixed.includes(value as string | number), `«${path}»: default`).toBe(true);
    }
  }
}

/** Settings are stored as JSON (state.json) – anything else would change on the round trip. */
const expectJsonData = (value: unknown, what: string): void => {
  expect(JSON.parse(JSON.stringify(value)), `${what} must be plain JSON data`).toStrictEqual(value);
};

describe('widget catalog', () => {
  it('has unique ids that resolve back to their manifest', () => {
    const ids = widgetCatalog.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const manifest of widgetCatalog) expect(getManifest(manifest.id)).toBe(manifest);
  });

  it.each(widgetCatalog.map((m) => [m.id, m] as const))('%s: sizes and category are valid', (_id, manifest) => {
    for (const size of [manifest.minWidth, manifest.minHeight, manifest.defaultWidth, manifest.defaultHeight]) {
      expect(Number.isInteger(size) && size >= 1).toBe(true);
    }
    expect(manifest.minWidth).toBeLessThanOrEqual(manifest.defaultWidth);
    expect(manifest.minHeight).toBeLessThanOrEqual(manifest.defaultHeight);
    expect(manifest.defaultWidth).toBeLessThanOrEqual(DEFAULT_COLS);
    if (manifest.category !== undefined) expect(WIDGET_CATEGORIES).toContain(manifest.category);
  });

  it.each(widgetCatalog.map((m) => [m.id, m] as const))('%s: declares a known icon and its settings', (_id, manifest) => {
    // Unknown names silently fall back to a grid icon – catch typos here.
    expect(manifest.icon, 'icon').toBeDefined();
    expect(Object.keys(WIDGET_ICONS), 'icon must be listed in widgetIcons.ts').toContain(manifest.icon);
    // The kiosk dialog and the web UI only render settings from the schema.
    expect(manifest.settingsSchema?.length ?? 0, 'settingsSchema').toBeGreaterThan(0);
    expect(manifest.defaultSettings, 'defaultSettings').toBeDefined();
  });

  it.each(widgetCatalog.map((m) => [m.id, m] as const))('%s: settings schema matches the backend rules', (_id, manifest) => {
    const schema = manifest.settingsSchema;
    if (!schema) return;

    const defaults = manifest.defaultSettings;
    expect(defaults, 'settingsSchema needs defaultSettings').toBeDefined();
    expectJsonData(defaults, 'defaultSettings');

    const topLevel = schema.filter((f): f is ValueField => f.type !== 'section').map((f) => f.key);
    expect(new Set(topLevel).size, 'duplicate keys').toBe(topLevel.length);
    for (const key of topLevel) expect(Object.keys(defaults ?? {}), `default for «${key}»`).toContain(key);

    for (const { path, field } of valueFields(schema)) {
      // The backend redacts by key name – type and name have to agree.
      expect(isSecretKey(field.key), `«${path}»: secret fields must (and only they may) end in apiKey/token/password/secret`).toBe(
        field.type === 'secret',
      );
      if (field.type === 'list') expectJsonData(field.newItem(), `«${path}»: newItem()`);
    }
    checkChoiceFields(schema, defaults ?? {});

    // Visibility rules must cope with the defaults (and never throw).
    const values = defaults ?? {};
    for (const field of schema) {
      if (field.showIf) expect(typeof field.showIf(values)).toBe('boolean');
    }
  });
});

describe('choice field rules', () => {
  it('accept id lists with registered providers or known static choices', () => {
    const schema: SettingsField[] = [
      { type: 'multiselect', key: 'benutzer', label: 'Personen', optionsProvider: PLANBAR_MEMBERS_PROVIDER },
      { type: 'multiselect', key: 'farben', label: 'Farben', options: [{ value: 'rot', label: 'Rot' }] },
      {
        type: 'select',
        key: 'projekt',
        label: 'Projekt',
        options: [{ value: '', label: 'Keines' }],
        optionsProvider: PLANBAR_PROJECTS_PROVIDER,
      },
    ];
    expect(() => checkChoiceFields(schema, { benutzer: ['u1'], farben: ['rot'], projekt: '' })).not.toThrow();
    expect(() => checkChoiceFields(schema, { benutzer: 'u1', farben: [], projekt: '' })).toThrow();
    expect(() => checkChoiceFields(schema, { benutzer: [1], farben: [], projekt: '' })).toThrow();
    expect(() => checkChoiceFields(schema, { benutzer: [], farben: ['blau'], projekt: '' })).toThrow();
    expect(() => checkChoiceFields(schema, { benutzer: [], farben: [], projekt: 7 })).toThrow();
  });

  it('reject providers nobody registered, also inside lists', () => {
    const unknown: SettingsField = { type: 'multiselect', key: 'x', label: 'X', optionsProvider: 'gibt.es.nicht' };
    expect(() => checkChoiceFields([unknown], { x: [] })).toThrow();
    const list: SettingsField = { type: 'list', key: 'gruppen', label: 'Gruppen', itemFields: [unknown], newItem: () => ({ x: [] }) };
    expect(() => checkChoiceFields([list], { gruppen: [] })).toThrow();
  });
});

describe('default dashboard', () => {
  it('only uses catalog widgets at least at their minimum size', () => {
    const { widgets, cols } = DEFAULT_STATE.layout;
    for (const widget of widgets) {
      const manifest = getManifest(widget.widgetId);
      expect(manifest, widget.widgetId).toBeDefined();
      if (!manifest) continue;
      expect(widget.w).toBeGreaterThanOrEqual(manifest.minWidth);
      expect(widget.h).toBeGreaterThanOrEqual(manifest.minHeight);
      expect(widget.x + widget.w).toBeLessThanOrEqual(cols);
    }
  });

  it('has no overlapping widgets', () => {
    const { widgets } = DEFAULT_STATE.layout;
    for (const [i, a] of widgets.entries()) {
      for (const b of widgets.slice(i + 1)) {
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.instanceId} / ${b.instanceId}`).toBe(false);
      }
    }
  });

  it('fits a 1920×1080 kiosk below the top bar without scrolling', () => {
    const { widgets, rowHeight, fitRows } = DEFAULT_STATE.layout;
    expect(fitRows).toBe(0);
    const rows = Math.max(...widgets.map((w) => w.y + w.h));
    const height = 2 * GRID_CONTAINER_PADDING[1] + rows * rowHeight + (rows - 1) * GRID_MARGIN[1];
    expect(height).toBeLessThanOrEqual(KIOSK_DASHBOARD_HEIGHT);
    // …and uses the screen: not even one more row would fit.
    expect(height + rowHeight + GRID_MARGIN[1]).toBeGreaterThan(KIOSK_DASHBOARD_HEIGHT);
  });
});

describe('isSecretKey', () => {
  it('mirrors the backend rule (case-insensitive suffix, any depth)', () => {
    for (const key of ['apiKey', 'openaiApiKey', 'token', 'lagraToken', 'PASSWORD', 'clientSecret']) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ['url', 'baseUrl', 'tokens', 'apiKeyHint', 'secrets', 'name']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});
