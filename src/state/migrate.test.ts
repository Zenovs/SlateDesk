import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE } from './defaults';
import { buildInitialOps, LEGACY_KEYS, type LegacyStorage, MIGRATED_KEY, migrateLegacyState, readLegacyState } from './migrate';
import { applyOps } from './ops';
import { withDefaults } from './defaults';
import type { RawState, StateOp } from './types';

class MemoryStorage implements LegacyStorage {
  readonly items = new Map<string, string>();
  readonly reads: string[] = [];

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) this.items.set(key, value);
  }

  getItem(key: string): string | null {
    this.reads.push(key);
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const legacyLayout = [
  { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 },
  // JSON.stringify(Infinity) → null: the old addWidget bug
  { instanceId: 'news-abc', widgetId: 'news', x: 3, y: null, w: 4, h: 3 },
  { instanceId: 'ghost-1', widgetId: 'ghost', x: 0, y: 3, w: 2, h: 2 },
  { instanceId: 'todo-1', widgetId: 'todo', x: 20, y: 0, w: 4.4, h: 3 },
];

const legacyStorage = (extra: Record<string, string> = {}) =>
  new MemoryStorage({
    [LEGACY_KEYS.layout]: JSON.stringify(legacyLayout),
    [LEGACY_KEYS.widgetSettings]: JSON.stringify({
      'clock-1': { format: '12h' },
      'news-abc': { apiKey: 'geheim', country: 'ch' },
      'ghost-1': { x: 1 },
      'removed-9': { apiKey: 'alt' },
      'todo-1': 'kaputt',
    }),
    [LEGACY_KEYS.theme]: 'light',
    [LEGACY_KEYS.accent]: '#e8642b',
    ...extra,
  });

describe('readLegacyState', () => {
  it('sanitizes the layout and keeps only known widgets', () => {
    const legacy = readLegacyState(legacyStorage());
    expect(legacy.widgets).toEqual([
      { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 },
      { instanceId: 'news-abc', widgetId: 'news', x: 3, y: 3, w: 4, h: 3 },
      { instanceId: 'todo-1', widgetId: 'todo', x: 8, y: 0, w: 4, h: 3 },
    ]);
  });

  it('keeps settings only for migrated instances and valid objects', () => {
    const legacy = readLegacyState(legacyStorage());
    expect(legacy.widgetSettings).toEqual({
      'clock-1': { format: '12h' },
      'news-abc': { apiKey: 'geheim', country: 'ch' },
    });
  });

  it('keeps the automatic zone label of pre-3.0 clocks outside Zürich', () => {
    const layout = [
      { instanceId: 'clock-ny', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 },
      { instanceId: 'clock-zh', widgetId: 'clock', x: 3, y: 0, w: 3, h: 3 },
      { instanceId: 'news-1', widgetId: 'news', x: 6, y: 0, w: 4, h: 3 },
    ];
    const legacy = readLegacyState(
      new MemoryStorage({
        [LEGACY_KEYS.layout]: JSON.stringify(layout),
        [LEGACY_KEYS.widgetSettings]: JSON.stringify({
          'clock-ny': { timezone: 'America/New_York' },
          'clock-zh': { timezone: 'Europe/Zurich' },
          'news-1': { timezone: 'America/New_York' },
        }),
      }),
    );
    expect(legacy.widgetSettings).toEqual({
      'clock-ny': { timezone: 'America/New_York', showTimezoneLabel: true },
      'clock-zh': { timezone: 'Europe/Zurich' },
      'news-1': { timezone: 'America/New_York' },
    });
  });

  it('drops the old default accent but keeps a chosen one', () => {
    expect(readLegacyState(legacyStorage()).theme).toEqual({ mode: 'light', accent: null });
    expect(readLegacyState(legacyStorage({ [LEGACY_KEYS.accent]: '#336699' })).theme).toEqual({
      mode: 'light',
      accent: '#336699',
    });
  });

  it('honours a custom list of known widget ids', () => {
    const legacy = readLegacyState(legacyStorage(), ['clock']);
    expect(legacy.widgets?.map((w) => w.instanceId)).toEqual(['clock-1']);
  });

  it('tolerates corrupt values', () => {
    const legacy = readLegacyState(
      new MemoryStorage({ [LEGACY_KEYS.layout]: '{kaputt', [LEGACY_KEYS.widgetSettings]: '[]', [LEGACY_KEYS.theme]: 'blau' }),
    );
    expect(legacy).toEqual({ widgets: null, widgetSettings: {}, theme: null });
  });
});

describe('buildInitialOps', () => {
  it('imports the legacy state into an empty backend state', () => {
    const ops = buildInitialOps({}, legacyStorage());
    const state = withDefaults(applyOps({}, ops));
    // Where the old grid showed them: it moved every widget up into free space.
    expect(state.layout.widgets.map((w) => [w.instanceId, w.x, w.y, w.w])).toEqual([
      ['clock-1', 0, 0, 3],
      ['news-abc', 3, 0, 4],
      ['todo-1', 8, 0, 4],
    ]);
    expect(state.layout.freePlacement).toBe(true);
    expect(state.layout.cols).toBe(12);
    expect(state.layout.rowHeight).toBe(80);
    expect(state.widgetSettings).toEqual({
      'clock-1': { format: '12h' },
      'news-abc': { apiKey: 'geheim', country: 'ch' },
    });
    expect(state.theme).toEqual({ mode: 'light', accent: null });
    expect(state.kiosk).toEqual(DEFAULT_STATE.kiosk);
    expect(state.lagra).toEqual(DEFAULT_STATE.lagra);
    expect(state.planbar).toEqual(DEFAULT_STATE.planbar);
  });

  it('writes every top-level section so the backend state is complete', () => {
    const raw = applyOps({}, buildInitialOps({}, legacyStorage()));
    expect(Object.keys(raw).sort()).toEqual([
      'data',
      'kiosk',
      'lagra',
      'layout',
      'planbar',
      'theme',
      'version',
      'widgetSettings',
    ]);
  });

  it('uses the default dashboard without legacy data', () => {
    const raw = applyOps({}, buildInitialOps({}, new MemoryStorage()));
    expect(withDefaults(raw).layout.widgets).toEqual(DEFAULT_STATE.layout.widgets);
    expect(withDefaults(raw).theme).toEqual(DEFAULT_STATE.theme);
  });

  it('never reads legacy keys again once migrated', () => {
    const storage = legacyStorage({ [MIGRATED_KEY]: '1' });
    const raw = applyOps({}, buildInitialOps({}, storage));
    expect(withDefaults(raw).layout.widgets).toEqual(DEFAULT_STATE.layout.widgets);
    expect(storage.reads).not.toContain(LEGACY_KEYS.layout);
  });

  it('does not touch legacy data when the backend already has a layout', () => {
    const storage = legacyStorage();
    const raw: RawState = { layout: { widgets: [], freePlacement: true }, theme: { mode: 'dark', accent: null } };
    const ops = buildInitialOps(raw, storage);
    expect(ops.some((op) => op.path[0] === 'layout' || op.path[0] === 'theme')).toBe(false);
    expect(storage.reads).not.toContain(LEGACY_KEYS.layout);
  });

  it('stores a layout from before free placement as its grid showed it, once', () => {
    const widgets = [
      { instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 4, h: 2 },
      // A gap of three rows above (e.g. a removed widget) – the old grid moved it up.
      { instanceId: 'b', widgetId: 'news', x: 0, y: 5, w: 4, h: 2 },
      { instanceId: 'c', widgetId: 'todo', x: 6, y: 4, w: 4, h: 2 },
    ];
    const raw: RawState = { layout: { widgets, cols: 12 } };
    const migrated = applyOps(raw, buildInitialOps(raw, null));
    const state = withDefaults(migrated);
    expect(state.layout.freePlacement).toBe(true);
    expect(state.layout.widgets.map((w) => [w.instanceId, w.x, w.y])).toEqual([
      ['a', 0, 0],
      ['b', 0, 2],
      ['c', 6, 0],
    ]);
    expect(buildInitialOps(migrated, null).some((op) => op.path[0] === 'layout')).toBe(false);
  });

  it('adds legacy settings without overwriting existing ones', () => {
    const raw: RawState = { widgetSettings: { 'clock-1': { format: '24h' } } };
    const next = applyOps(raw, buildInitialOps(raw, legacyStorage()));
    expect(next.widgetSettings).toEqual({
      'clock-1': { format: '24h' },
      'news-abc': { apiKey: 'geheim', country: 'ch' },
    });
  });

  it('moves the single planbar key of older versions into an Unternehmen (browser state)', () => {
    const complete = JSON.parse(JSON.stringify(DEFAULT_STATE)) as RawState;
    const legacy: RawState = { ...complete, planbar: { enabled: true, url: 'https://planbar.dev', apiKey: 'pk_live_alt' } };
    const next = applyOps(legacy, buildInitialOps(legacy, null));
    expect(next.planbar).toEqual({
      enabled: true,
      url: 'https://planbar.dev',
      unternehmen: { standard: { name: 'planbar', apiKey: 'pk_live_alt' } },
    });
    // Nothing left to do afterwards; an empty old key just goes away.
    expect(buildInitialOps(next, null)).toEqual([]);
    const empty: RawState = { ...complete, planbar: { apiKey: '', unternehmen: { a: { name: 'A', apiKey: 'k' } } } };
    expect(applyOps(empty, buildInitialOps(empty, null)).planbar).toEqual({ unternehmen: { a: { name: 'A', apiKey: 'k' } } });
  });

  it('returns no ops for a complete state', () => {
    const complete = JSON.parse(JSON.stringify(DEFAULT_STATE)) as RawState;
    expect(buildInitialOps(complete, legacyStorage())).toEqual([]);
  });
});

describe('migrateLegacyState', () => {
  it('marks the migration as done after a successful write', async () => {
    const storage = legacyStorage();
    const written: StateOp[][] = [];
    const ok = await migrateLegacyState({}, async (ops) => {
      written.push(ops);
      return true;
    }, storage);
    expect(ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(storage.items.get(MIGRATED_KEY)).toBe('1');
    expect(storage.items.get(LEGACY_KEYS.layout)).toBe(JSON.stringify(legacyLayout));
  });

  it('retries next time when the write failed', async () => {
    const storage = legacyStorage();
    const ok = await migrateLegacyState({}, async () => false, storage);
    expect(ok).toBe(false);
    expect(storage.items.has(MIGRATED_KEY)).toBe(false);
  });
});
