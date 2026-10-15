import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, DEFAULT_WIDGETS, firstFreeSlot, sanitizeWidgets, withDefaults } from './defaults';

describe('withDefaults', () => {
  it('returns the defaults for empty or garbage input', () => {
    expect(withDefaults({})).toEqual(DEFAULT_STATE);
    expect(withDefaults(null)).toEqual(DEFAULT_STATE);
    expect(withDefaults('kaputt')).toEqual(DEFAULT_STATE);
    expect(withDefaults([1, 2])).toEqual(DEFAULT_STATE);
  });

  it('deep-fills missing keys and keeps valid values', () => {
    const state = withDefaults({
      kiosk: { name: 'Empfang', displaySchedule: { enabled: true, on: '06:30' } },
      theme: { mode: 'light' },
      lagra: { enabled: true, token: 'abc' },
      planbar: { apiKey: 'pk_live_x' },
      layout: { cols: 24 },
    });
    expect(state.kiosk).toEqual({
      ...DEFAULT_STATE.kiosk,
      name: 'Empfang',
      displaySchedule: { ...DEFAULT_STATE.kiosk.displaySchedule, enabled: true, on: '06:30' },
    });
    expect(state.theme).toEqual({ mode: 'light', accent: null });
    expect(state.lagra).toEqual({ enabled: true, url: 'https://lagra.schnyder-werbung.ch', token: 'abc' });
    // The single key of older versions reads as Unternehmen «standard» (like the backend moves it).
    expect(state.planbar).toEqual({
      enabled: false,
      url: 'https://planbar.dev',
      unternehmen: { standard: { name: 'planbar', apiKey: 'pk_live_x' } },
    });
    expect(state.layout.cols).toBe(24);
    expect(state.layout.rowHeight).toBe(80);
    expect(state.layout.widgets.map((w) => w.instanceId)).toEqual(DEFAULT_WIDGETS.map((w) => w.instanceId));
    expect(state.data).toEqual({ todos: {}, announcements: {} });
  });

  it('replaces invalid values with defaults', () => {
    const state = withDefaults({
      version: 7,
      theme: { mode: 'pink', accent: 'red; background: url(x)' },
      layout: { cols: Number.NaN, rowHeight: 9999, fitRows: -3 },
      kiosk: {
        name: '   ',
        showTopBar: 'ja',
        cursorHideSeconds: -5,
        displaySchedule: { on: '25:00', off: '7:00', days: [5, 1, 1, 9, 'Mo', 0] },
      },
      widgetSettings: { a: { x: 1 }, b: 'kaputt', c: null },
      planbar: { enabled: 'ja', url: '  ', apiKey: 42 },
    });
    expect(state.version).toBe(1);
    expect(state.theme).toEqual({ mode: 'dark', accent: null });
    expect(state.layout.cols).toBe(12);
    expect(state.layout.rowHeight).toBe(400);
    expect(state.layout.fitRows).toBe(0);
    expect(state.kiosk.name).toBe('SlateDesk');
    expect(state.kiosk.showTopBar).toBe(true);
    expect(state.kiosk.cursorHideSeconds).toBe(0);
    expect(state.kiosk.displaySchedule).toEqual({ enabled: false, on: '07:00', off: '19:00', days: [0, 1, 5] });
    expect(state.widgetSettings).toEqual({ a: { x: 1 } });
    expect(state.planbar).toEqual(DEFAULT_STATE.planbar);
  });

  it('keeps valid planbar Unternehmen and drops broken ones', () => {
    // Parsed like the backend's JSON: «__proto__» is an own key there.
    const unternehmen = JSON.parse(
      JSON.stringify({
        wireon: { name: 'wireon', apiKey: '__gesetzt__' },
        'mgk3x1a2-9f3c2b7d1e0a4c55': { name: 'S'.repeat(80), apiKey: 7 },
        'mit leerzeichen': { name: 'x', apiKey: 'k' },
        ['a'.repeat(41)]: { name: 'zu lang', apiKey: 'k' },
        kaputt: 'pk_live_x',
        liste: [],
      }).replace('{', '{"__proto__":{"name":"p","apiKey":"k"},'),
    ) as Record<string, unknown>;
    expect(Object.keys(unternehmen)).toContain('__proto__');
    const state = withDefaults({ planbar: { enabled: true, apiKey: 'pk_live_alt', unternehmen } });
    expect(state.planbar.unternehmen).toEqual({
      wireon: { name: 'wireon', apiKey: '__gesetzt__' },
      'mgk3x1a2-9f3c2b7d1e0a4c55': { name: 'S'.repeat(60), apiKey: '' },
    });
    // Existing Unternehmen win over the old single key.
    expect(Object.keys(state.planbar.unternehmen)).not.toContain('standard');
    expect(withDefaults({ planbar: { apiKey: '  ' } }).planbar.unternehmen).toEqual({});
  });

  it('keeps an explicitly empty widget list', () => {
    expect(withDefaults({ layout: { widgets: [] } }).layout.widgets).toEqual([]);
  });

  it('accepts hex accents', () => {
    expect(withDefaults({ theme: { mode: 'dark', accent: '#12abEF' } }).theme.accent).toBe('#12abEF');
  });

  it('sanitizes todos and announcements, ids come from the keys', () => {
    const state = withDefaults({
      data: {
        todos: {
          t1: { id: 'falsch', text: 'Milch', done: 'ja', priority: 'dringend', due: '2026-10-20', createdAt: 5 },
          t2: { done: true },
          t3: 'kaputt',
        },
        announcements: {
          a1: { title: 'Apéro', level: 'party', pinned: true, until: Number.POSITIVE_INFINITY },
          a2: { text: 'ohne Titel' },
        },
      },
    });
    expect(state.data.todos).toEqual({ t1: { id: 't1', text: 'Milch', done: false, due: '2026-10-20', createdAt: 5 } });
    expect(state.data.announcements).toEqual({
      a1: { id: 'a1', title: 'Apéro', level: 'info', pinned: true, createdAt: 0 },
    });
  });
});

describe('sanitizeWidgets', () => {
  it('places items with Infinity/null/negative y below the others', () => {
    const widgets = sanitizeWidgets(
      [
        { instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 4, h: 3 },
        { instanceId: 'b', widgetId: 'todo', x: 4, y: Number.POSITIVE_INFINITY, w: 4, h: 2 },
        { instanceId: 'c', widgetId: 'news', x: 0, y: 2, w: 4, h: 5 },
        { instanceId: 'd', widgetId: 'nas', x: 0, y: null, w: 2, h: 2 },
        { instanceId: 'e', widgetId: 'weather', x: 0, y: -1, w: 2, h: 1 },
      ],
      12,
    );
    expect(widgets.map((w) => [w.instanceId, w.y])).toEqual([
      ['a', 0],
      ['b', 7],
      ['c', 2],
      ['d', 9],
      ['e', 11],
    ]);
  });

  it('rounds to integers, enforces w/h >= 1 and clamps into the columns', () => {
    const [a, b, c] = sanitizeWidgets(
      [
        { instanceId: 'a', widgetId: 'clock', x: 1.6, y: 2.4, w: 2.5, h: 0 },
        { instanceId: 'b', widgetId: 'clock', x: 10, y: 0, w: 6, h: -3 },
        { instanceId: 'c', widgetId: 'clock', x: Number.NaN, y: 0, w: 40, h: Number.NaN },
      ],
      12,
    );
    expect(a).toEqual({ instanceId: 'a', widgetId: 'clock', x: 2, y: 2, w: 3, h: 1 });
    expect(b).toEqual({ instanceId: 'b', widgetId: 'clock', x: 6, y: 0, w: 6, h: 1 });
    expect(c).toEqual({ instanceId: 'c', widgetId: 'clock', x: 0, y: 0, w: 12, h: 3 });
  });

  it('drops items without ids and duplicate instanceIds', () => {
    const widgets = sanitizeWidgets(
      [
        { instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 },
        { instanceId: 'a', widgetId: 'todo', x: 3, y: 0, w: 3, h: 3 },
        { widgetId: 'todo', x: 0, y: 0, w: 3, h: 3 },
        { instanceId: 'x', x: 0, y: 0, w: 3, h: 3 },
        null,
        'kaputt',
      ],
      12,
    );
    expect(widgets).toEqual([{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 }]);
  });

  it('returns [] for non-arrays', () => {
    expect(sanitizeWidgets({ a: 1 }, 12)).toEqual([]);
  });
});

describe('firstFreeSlot', () => {
  it('uses a gap the widget fits into', () => {
    const widgets = [
      { x: 0, y: 0, w: 8, h: 6 },
      { x: 8, y: 0, w: 4, h: 2 },
    ];
    expect(firstFreeSlot(widgets, 12, 4, 3)).toEqual({ x: 8, y: 2 });
  });

  it('may reach below the others where they leave room', () => {
    const widgets = [
      { x: 0, y: 0, w: 8, h: 6 },
      { x: 8, y: 0, w: 4, h: 2 },
    ];
    expect(firstFreeSlot(widgets, 12, 4, 8)).toEqual({ x: 8, y: 2 });
  });

  it('falls back to the first row below all widgets on a full dashboard', () => {
    expect(firstFreeSlot(DEFAULT_WIDGETS, 12, 4, 3)).toEqual({ x: 0, y: 11 });
    expect(firstFreeSlot([], 12, 4, 3)).toEqual({ x: 0, y: 0 });
  });

  it('clamps the width to the grid', () => {
    expect(firstFreeSlot([{ x: 0, y: 0, w: 2, h: 2 }], 6, 10, 2)).toEqual({ x: 0, y: 2 });
  });
});
