import { describe, expect, it } from 'vitest';
import { GRID_CONTAINER_PADDING, GRID_MARGIN, MIN_FIT_ROW_HEIGHT, fitRowHeight } from './grid';

const totalHeight = (rowHeight: number, rows: number) =>
  rows * rowHeight + (rows - 1) * GRID_MARGIN[1] + 2 * GRID_CONTAINER_PADDING[1];

describe('fitRowHeight', () => {
  it('fills the height exactly when it divides evenly', () => {
    const rowHeight = fitRowHeight(600, 8);
    expect(rowHeight).toBe(61.5);
    expect(totalHeight(rowHeight, 8)).toBe(600);
  });

  it('never overflows the available height', () => {
    for (const height of [480, 599, 600, 601, 768, 1080, 1337]) {
      for (const rows of [1, 3, 7, 9, 12]) {
        expect(totalHeight(fitRowHeight(height, rows), rows)).toBeLessThanOrEqual(height);
        expect(totalHeight(fitRowHeight(height, rows), rows)).toBeGreaterThan(height - rows * 0.01 - 0.001);
      }
    }
  });

  it('falls back to the minimum for degenerate input', () => {
    expect(fitRowHeight(0, 8)).toBe(MIN_FIT_ROW_HEIGHT);
    expect(fitRowHeight(600, 0)).toBe(MIN_FIT_ROW_HEIGHT);
    expect(fitRowHeight(100, 40)).toBe(MIN_FIT_ROW_HEIGHT);
  });
});
