import { describe, expect, it } from 'vitest';
import { applyOp, applyOps, jsonEqual, shareStructure } from './ops';
import type { RawState } from './types';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const sample = (): RawState =>
  deepFreeze({
    version: 1,
    layout: {
      widgets: [
        { instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 },
        { instanceId: 'b', widgetId: 'todo', x: 3, y: 0, w: 4, h: 3 },
      ],
      cols: 12,
    },
    widgetSettings: { a: { format: '24h', seconds: true } },
    theme: { mode: 'dark', accent: null },
  });

describe('set', () => {
  it('replaces a value at a path', () => {
    const next = applyOp(sample(), { op: 'set', path: ['theme', 'mode'], value: 'light' });
    expect(next.theme).toEqual({ mode: 'light', accent: null });
  });

  it('creates missing intermediate objects', () => {
    const next = applyOp({}, { op: 'set', path: ['kiosk', 'displaySchedule', 'on'], value: '08:00' });
    expect(next).toEqual({ kiosk: { displaySchedule: { on: '08:00' } } });
  });

  it('treats null intermediates as missing', () => {
    const next = applyOp({ lagra: null }, { op: 'set', path: ['lagra', 'url'], value: 'https://x.ch' });
    expect(next).toEqual({ lagra: { url: 'https://x.ch' } });
  });

  it('replaces and appends array elements by index', () => {
    const replaced = applyOp(sample(), { op: 'set', path: ['layout', 'widgets', 0, 'x'], value: 5 });
    expect((replaced.layout as { widgets: { x: number }[] }).widgets[0].x).toBe(5);

    const appended = applyOp(sample(), {
      op: 'set',
      path: ['layout', 'widgets', 2],
      value: { instanceId: 'c', widgetId: 'news', x: 0, y: 3, w: 4, h: 3 },
    });
    expect((appended.layout as { widgets: unknown[] }).widgets).toHaveLength(3);
  });

  it('rejects an index beyond the end of an array', () => {
    expect(() => applyOp(sample(), { op: 'set', path: ['layout', 'widgets', 5], value: {} })).toThrow(
      /Ungültiger Pfad/,
    );
  });

  it('replaces the whole state with an empty path', () => {
    const next = applyOp(sample(), { op: 'set', path: [], value: { version: 1, theme: { mode: 'light' } } });
    expect(next).toEqual({ version: 1, theme: { mode: 'light' } });
  });

  it('validates a root replacement', () => {
    expect(() => applyOp(sample(), { op: 'set', path: [], value: { foo: 1 } })).toThrow(/Unbekannter Schlüssel/);
    expect(() => applyOp(sample(), { op: 'set', path: [], value: [1, 2] })).toThrow(/muss ein Objekt sein/);
    expect(() => applyOp(sample(), { op: 'set', path: [], value: { theme: 'dark' } })).toThrow(
      /«theme» muss ein Objekt sein/,
    );
  });

  it('stores values as JSON (cloned, NaN → null, undefined dropped)', () => {
    const value = { a: 1, b: undefined, c: Number.NaN, nested: { list: [1, 2] } };
    const next = applyOp({}, { op: 'set', path: ['widgetSettings', 'x'], value });
    value.nested.list.push(3);
    expect(next.widgetSettings).toEqual({ x: { a: 1, c: null, nested: { list: [1, 2] } } });
  });

  it('rejects a missing value', () => {
    expect(() => applyOp({}, { op: 'set', path: ['version'], value: undefined })).toThrow(/Wert fehlt/);
  });
});

describe('merge', () => {
  it('merges shallowly and keeps other keys', () => {
    const next = applyOp(sample(), { op: 'merge', path: ['widgetSettings', 'a'], value: { seconds: false, tz: 'UTC' } });
    expect(next.widgetSettings).toEqual({ a: { format: '24h', seconds: false, tz: 'UTC' } });
  });

  it('creates the target object if missing', () => {
    const next = applyOp(sample(), { op: 'merge', path: ['widgetSettings', 'new'], value: { city: 'Bern' } });
    expect((next.widgetSettings as Record<string, unknown>).new).toEqual({ city: 'Bern' });
  });

  it('merges into the root', () => {
    const state = sample();
    const next = applyOp(state, { op: 'merge', path: [], value: { lagra: { enabled: true } } });
    expect(next.lagra).toEqual({ enabled: true });
    expect(next.layout).toBe(state.layout);
  });

  it('replaces a non-object target with the patch', () => {
    const next = applyOp(sample(), { op: 'merge', path: ['theme', 'accent'], value: { light: '#fff' } });
    expect(next.theme).toEqual({ mode: 'dark', accent: { light: '#fff' } });
  });

  it('with create: false merges into an existing target only', () => {
    const state = sample();
    const merged = applyOp(state, { op: 'merge', path: ['widgetSettings', 'a'], value: { seconds: false }, create: false });
    expect(merged.widgetSettings).toEqual({ a: { format: '24h', seconds: false } });

    // A concurrent delete won: the edit must not bring back a half-empty record.
    const missing = applyOp(state, { op: 'merge', path: ['data', 'todos', 'x'], value: { text: 'neu' }, create: false });
    expect(missing).toBe(state);
    const missingLeaf = applyOp(state, {
      op: 'merge',
      path: ['widgetSettings', 'gone'],
      value: { city: 'Bern' },
      create: false,
    });
    expect(missingLeaf).toBe(state);
    // Like delete: mistyped steps on the way are no-ops, not errors.
    expect(applyOp(state, { op: 'merge', path: ['theme', 'mode', 'x'], value: { a: 1 }, create: false })).toBe(state);
    expect(applyOp(state, { op: 'merge', path: ['layout', 'widgets', 9], value: { x: 1 }, create: false })).toBe(state);
    // An existing non-object target is replaced, exactly as without the flag.
    const replaced = applyOp(state, { op: 'merge', path: ['theme', 'accent'], value: { a: 1 }, create: false });
    expect(replaced.theme).toEqual({ mode: 'dark', accent: { a: 1 } });
  });

  it('rejects a non-object value and invalid results', () => {
    expect(() => applyOp(sample(), { op: 'merge', path: ['version'], value: { a: 1 } })).toThrow(
      /«version» muss eine ganze Zahl sein/,
    );
    expect(() =>
      applyOp(sample(), { op: 'merge', path: ['theme'], value: 'light' as unknown as Record<string, unknown> }),
    ).toThrow(/merge bei «theme» erwartet ein Objekt/);
  });
});

describe('delete', () => {
  it('removes an object key', () => {
    const next = applyOp(sample(), { op: 'delete', path: ['widgetSettings', 'a'] });
    expect(next.widgetSettings).toEqual({});
  });

  it('removes an array element', () => {
    const next = applyOp(sample(), { op: 'delete', path: ['layout', 'widgets', 0] });
    expect((next.layout as { widgets: { instanceId: string }[] }).widgets.map((w) => w.instanceId)).toEqual(['b']);
  });

  it('is a no-op (same reference) for missing keys, indices and intermediates', () => {
    const state = sample();
    expect(applyOp(state, { op: 'delete', path: ['widgetSettings', 'nope'] })).toBe(state);
    expect(applyOp(state, { op: 'delete', path: ['layout', 'widgets', 9] })).toBe(state);
    expect(applyOp(state, { op: 'delete', path: ['data', 'todos', 'x'] })).toBe(state);
    expect(applyOp(state, { op: 'delete', path: ['version', 'x'] })).toBe(state);
  });

  it('refuses to delete the whole state', () => {
    expect(() => applyOp(sample(), { op: 'delete', path: [] })).toThrow(/Wurzel/);
  });
});

describe('push', () => {
  it('appends to an existing array', () => {
    const next = applyOp(sample(), {
      op: 'push',
      path: ['layout', 'widgets'],
      value: { instanceId: 'c', widgetId: 'news', x: 0, y: 3, w: 4, h: 3 },
    });
    expect((next.layout as { widgets: { instanceId: string }[] }).widgets.map((w) => w.instanceId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('creates the array if missing', () => {
    const next = applyOp({}, { op: 'push', path: ['kiosk', 'displaySchedule', 'days'], value: 6 });
    expect(next).toEqual({ kiosk: { displaySchedule: { days: [6] } } });
  });

  it('rejects pushing to a non-array', () => {
    expect(() => applyOp(sample(), { op: 'push', path: ['theme'], value: 1 })).toThrow(/erwartet eine Liste/);
    expect(() => applyOp(sample(), { op: 'push', path: [], value: 1 })).toThrow(/Wurzel/);
  });
});

describe('invalid paths', () => {
  it('rejects unknown top-level keys', () => {
    expect(() => applyOp({}, { op: 'set', path: ['foo'], value: 1 })).toThrow(/Unbekannter Schlüssel im Zustand: «foo»/);
    expect(() => applyOp({}, { op: 'set', path: ['foo', 'bar'], value: 1 })).toThrow(/Unbekannter Schlüssel/);
  });

  it('rejects __proto__ keys', () => {
    expect(() => applyOp({}, { op: 'set', path: ['widgetSettings', '__proto__', 'x'], value: 1 })).toThrow(
      /nicht erlaubt/,
    );
    expect(() =>
      applyOp({}, { op: 'merge', path: ['widgetSettings'], value: JSON.parse('{"__proto__": {"x": 1}}') }),
    ).toThrow(/nicht erlaubt/);
  });

  it('rejects non-index segments on lists and invalid numbers', () => {
    expect(() => applyOp(sample(), { op: 'set', path: ['layout', 'widgets', 'first'], value: 1 })).toThrow(
      /ist eine Liste, «first» ist kein Index/,
    );
    expect(() => applyOp(sample(), { op: 'set', path: ['layout', 'widgets', '01', 'x'], value: 1 })).toThrow(
      /kein Index/,
    );
    expect(() => applyOp(sample(), { op: 'set', path: ['layout', 'widgets', -1], value: 1 })).toThrow(
      /kein gültiges Pfadsegment/,
    );
    expect(() => applyOp(sample(), { op: 'set', path: ['layout', 'widgets', 1.5], value: 1 })).toThrow(
      /kein gültiges Pfadsegment/,
    );
  });

  it('addresses object keys with numbers and lists with numeric strings (like the backend)', () => {
    const keyed = applyOp(sample(), { op: 'set', path: ['widgetSettings', 7], value: { a: 1 } });
    expect((keyed.widgetSettings as Record<string, unknown>)['7']).toEqual({ a: 1 });
    const indexed = applyOp(sample(), { op: 'set', path: ['layout', 'widgets', '1', 'x'], value: 9 });
    expect((indexed.layout as { widgets: { x: number }[] }).widgets[1].x).toBe(9);
  });

  it('creates an intermediate object at the next free list index', () => {
    const next = applyOp(sample(), { op: 'set', path: ['layout', 'widgets', 2, 'instanceId'], value: 'c' });
    expect((next.layout as { widgets: unknown[] }).widgets[2]).toEqual({ instanceId: 'c' });
    expect(() => applyOp(sample(), { op: 'set', path: ['layout', 'widgets', 3, 'x'], value: 1 })).toThrow(
      /ausserhalb/,
    );
  });

  it('ignores deletes through missing or mistyped steps', () => {
    const state = sample();
    expect(applyOp(state, { op: 'delete', path: ['layout', 'widgets', 'first'] })).toBe(state);
    expect(applyOp(state, { op: 'delete', path: ['layout', 'widgets', 7, 'x'] })).toBe(state);
    expect(applyOp(state, { op: 'delete', path: ['foo'] })).toBe(state);
  });

  it('rejects writing below a primitive', () => {
    expect(() => applyOp(sample(), { op: 'set', path: ['version', 'x'], value: 1 })).toThrow(
      /«version» ist weder Objekt noch Liste/,
    );
  });

  it('rejects unknown operations', () => {
    expect(() => applyOp({}, { op: 'rename', path: ['version'] } as never)).toThrow(/Unbekannte Operation/);
  });
});

describe('applyOps', () => {
  it('applies in order', () => {
    const next = applyOps({}, [
      { op: 'set', path: ['data', 'todos', 't1'], value: { id: 't1', text: 'A', done: false } },
      { op: 'merge', path: ['data', 'todos', 't1'], value: { done: true } },
      { op: 'set', path: ['data', 'todos', 't2'], value: { id: 't2', text: 'B', done: false } },
      { op: 'delete', path: ['data', 'todos', 't2'] },
    ]);
    expect(next).toEqual({ data: { todos: { t1: { id: 't1', text: 'A', done: true } } } });
  });

  it('never mutates the input and keeps untouched subtrees', () => {
    const state = sample();
    const before = JSON.stringify(state);
    const next = applyOps(state, [
      { op: 'set', path: ['theme', 'mode'], value: 'light' },
      { op: 'merge', path: ['widgetSettings', 'a'], value: { seconds: false } },
      { op: 'push', path: ['layout', 'widgets'], value: { instanceId: 'c' } },
      { op: 'delete', path: ['layout', 'widgets', 0] },
    ]);
    expect(JSON.stringify(state)).toBe(before);
    expect(next).not.toBe(state);
    expect(next.version).toBe(state.version);
    expect((next.layout as { widgets: unknown[] }).widgets[0]).toBe(
      (state.layout as { widgets: unknown[] }).widgets[1],
    );
  });

  it('throws on an invalid op and leaves the input untouched', () => {
    const state = sample();
    expect(() =>
      applyOps(state, [
        { op: 'set', path: ['theme', 'mode'], value: 'light' },
        { op: 'set', path: ['nope'], value: 1 },
      ]),
    ).toThrow();
    expect((state.theme as { mode: string }).mode).toBe('dark');
  });
});

describe('shareStructure', () => {
  it('keeps identity of deep-equal subtrees', () => {
    const prev = sample();
    const next = JSON.parse(JSON.stringify(prev)) as RawState;
    (next.theme as { mode: string }).mode = 'light';
    const shared = shareStructure(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared.layout).toBe(prev.layout);
    expect(shared.widgetSettings).toBe(prev.widgetSettings);
    expect(shared.theme).toEqual({ mode: 'light', accent: null });
  });

  it('returns the previous value when everything is equal', () => {
    const prev = sample();
    expect(shareStructure(prev, JSON.parse(JSON.stringify(prev)))).toBe(prev);
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: [1] }, { a: [1, 2] })).toBe(false);
  });
});
