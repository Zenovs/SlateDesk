import { describe, expect, it } from 'vitest';
import { initialTileLayout, parseTileLayout, resolveTileLayout, tileRows, type TileLayout } from './tileLayout';

describe('parseTileLayout', () => {
  it('treats anything unusable as automatic', () => {
    for (const value of [null, undefined, 'eigen', [], {}, { columns: 3 }, { columns: 'drei', items: [] }]) {
      expect(parseTileLayout(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('clamps columns and items and drops broken or repeated tiles', () => {
    const layout = parseTileLayout({
      columns: 9,
      items: [
        { id: 'server', x: 5, y: -2, w: 3, h: 20 },
        { id: 'server', x: 0, y: 0, w: 1, h: 1 },
        { id: 'jobs', x: 1.4, y: 0.6, w: 1, h: 1 },
        { id: '', x: 0, y: 0, w: 1, h: 1 },
        { id: 'dam', x: 'links', y: 0, w: 1, h: 1 },
        'viren',
      ],
    });
    expect(layout).toEqual({
      columns: 6,
      items: [
        { id: 'server', x: 3, y: 0, w: 3, h: 6 },
        { id: 'jobs', x: 1, y: 1, w: 1, h: 1 },
      ],
    });
  });
});

describe('resolveTileLayout', () => {
  const layout: TileLayout = {
    columns: 3,
    items: [
      { id: 'server', x: 0, y: 0, w: 2, h: 2 },
      { id: 'jobs', x: 2, y: 0, w: 1, h: 1 },
      { id: 'dam', x: 2, y: 1, w: 1, h: 1 },
    ],
  };

  it('keeps the stored places of the active tiles, in reading order', () => {
    expect(resolveTileLayout(layout, ['jobs', 'dam', 'server'])).toEqual([
      { id: 'server', x: 0, y: 0, w: 2, h: 2 },
      { id: 'jobs', x: 2, y: 0, w: 1, h: 1 },
      { id: 'dam', x: 2, y: 1, w: 1, h: 1 },
    ]);
  });

  it('closes the gap of a switched-off tile', () => {
    expect(resolveTileLayout(layout, ['server', 'dam'])).toEqual([
      { id: 'server', x: 0, y: 0, w: 2, h: 2 },
      { id: 'dam', x: 2, y: 0, w: 1, h: 1 },
    ]);
  });

  it('puts newly switched-on tiles into the first free cell', () => {
    expect(resolveTileLayout(layout, ['server', 'jobs', 'dam', 'viren', 'nas'])).toEqual([
      { id: 'server', x: 0, y: 0, w: 2, h: 2 },
      { id: 'jobs', x: 2, y: 0, w: 1, h: 1 },
      { id: 'dam', x: 2, y: 1, w: 1, h: 1 },
      { id: 'viren', x: 0, y: 2, w: 1, h: 1 },
      { id: 'nas', x: 1, y: 2, w: 1, h: 1 },
    ]);
  });

  it('moves a tile whose place is taken instead of overlapping', () => {
    const clash: TileLayout = {
      columns: 2,
      items: [
        { id: 'server', x: 0, y: 0, w: 2, h: 1 },
        { id: 'jobs', x: 1, y: 0, w: 1, h: 1 },
      ],
    };
    expect(resolveTileLayout(clash, ['server', 'jobs'])).toEqual([
      { id: 'server', x: 0, y: 0, w: 2, h: 1 },
      { id: 'jobs', x: 0, y: 1, w: 1, h: 1 },
    ]);
  });
});

describe('initialTileLayout and tileRows', () => {
  it('starts with the active tiles side by side, in up to two rows', () => {
    const four = initialTileLayout(['server', 'jobs', 'viren', 'dam']);
    expect(four.columns).toBe(4);
    expect(tileRows(four.items)).toBe(1);
    const nine = initialTileLayout(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    expect(nine.columns).toBe(5);
    expect(tileRows(nine.items)).toBe(2);
    expect(nine.items.at(-1)).toEqual({ id: 'i', x: 3, y: 1, w: 1, h: 1 });
    expect(initialTileLayout([]).columns).toBe(1);
    expect(tileRows([])).toBe(1);
  });
});
