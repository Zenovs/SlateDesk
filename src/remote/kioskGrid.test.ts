import { describe, expect, it } from 'vitest';
import { bottomOf, DEFAULT_WIDGETS } from '../state/defaults';
import type { WidgetInstance } from '../state/types';
import { getManifest } from '../widgets/catalog';
import { rescaleWidgets, shownWidgets } from './kioskGrid';

const DEFAULT_LAYOUT = shownWidgets([...DEFAULT_WIDGETS]);
const byId = (widgets: readonly WidgetInstance[]) => new Map(widgets.map((w) => [w.instanceId, w]));

function overlaps(a: WidgetInstance, b: WidgetInstance): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function expectValid(widgets: readonly WidgetInstance[], cols: number): void {
  for (const widget of widgets) {
    expect(widget.x).toBeGreaterThanOrEqual(0);
    expect(widget.x + widget.w).toBeLessThanOrEqual(cols);
    expect(widget.w).toBeGreaterThanOrEqual(Math.min(cols, getManifest(widget.widgetId)?.minWidth ?? 1));
  }
  for (const [index, a] of widgets.entries()) {
    for (const b of widgets.slice(index + 1)) expect(overlaps(a, b), `${a.instanceId} / ${b.instanceId}`).toBe(false);
  }
}

describe('rescaleWidgets', () => {
  it('keeps the default dashboard in its rows for every column count that fits it', () => {
    for (let cols = 8; cols <= 24; cols += 1) {
      const scaled = rescaleWidgets(DEFAULT_LAYOUT, 12, cols);
      expectValid(scaled, cols);
      // Rows (y, h) stay as they were – nothing is pushed below the screen edge.
      const before = byId(DEFAULT_LAYOUT);
      for (const widget of scaled) {
        expect({ y: widget.y, h: widget.h }, `${cols} Spalten: ${widget.instanceId}`).toEqual({
          y: before.get(widget.instanceId)?.y,
          h: before.get(widget.instanceId)?.h,
        });
      }
      expect(bottomOf(scaled)).toBe(bottomOf(DEFAULT_LAYOUT));
    }
  });

  it('keeps neighbours side by side when both edges land on .5 (12 → 18, 12 → 14)', () => {
    const at18 = byId(rescaleWidgets(DEFAULT_LAYOUT, 12, 18));
    const calendar = at18.get('calendar-1')!;
    const weather = at18.get('weather-1')!;
    expect(calendar.x + calendar.w).toBeLessThanOrEqual(weather.x);
    expect(weather.y).toBe(0);

    const at14 = byId(rescaleWidgets(DEFAULT_LAYOUT, 12, 14));
    expect(at14.get('calendar-1')!.x + at14.get('calendar-1')!.w).toBeLessThanOrEqual(at14.get('weather-1')!.x);
    expect(at14.get('news-1')!.y).toBe(7);
  });

  it('makes room for minimum widths by moving the neighbouring edges', () => {
    // 10 → 8: weather would get 2 columns (minimum 3) – the calendar gives one up.
    const at10 = rescaleWidgets(DEFAULT_LAYOUT, 12, 10);
    const at8 = rescaleWidgets(at10, 10, 8);
    expectValid(at8, 8);
    expect(bottomOf(at8)).toBe(bottomOf(DEFAULT_LAYOUT));
  });

  it('restores the layout when switching back', () => {
    for (const cols of [8, 9, 11, 13, 14, 15, 16, 18, 20, 24]) {
      expect(rescaleWidgets(rescaleWidgets(DEFAULT_LAYOUT, 12, cols), cols, 12), `12 → ${cols} → 12`).toEqual(DEFAULT_LAYOUT);
    }
  });

  it('stays valid when the minimum widths do not fit side by side', () => {
    // clock (2) + calendar (3) + weather (3) need 8 columns.
    const at6 = rescaleWidgets(DEFAULT_LAYOUT, 12, 6);
    expectValid(at6, 6);
    expect(at6.map((w) => w.instanceId)).toEqual(DEFAULT_LAYOUT.map((w) => w.instanceId));
  });

  it('returns a copy for an unchanged column count', () => {
    const same = rescaleWidgets(DEFAULT_LAYOUT, 12, 12);
    expect(same).toEqual(DEFAULT_LAYOUT);
    expect(same).not.toBe(DEFAULT_LAYOUT);
  });
});
