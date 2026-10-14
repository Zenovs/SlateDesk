import { describe, expect, it } from 'vitest';
import {
  dayOffset,
  formatAgo,
  formatBytes,
  formatBytesOf,
  formatCount,
  formatDaysAgo,
  formatDayTime,
  formatDuration,
  formatPercent,
  parseClamdDate,
  percentOf,
} from './format';

const NBSP = String.fromCharCode(0xa0);
/** Non-breaking spaces → plain spaces, so expectations stay readable. */
const plain = (text: string): string => text.split(NBSP).join(' ');

describe('numbers', () => {
  it('groups thousands the Swiss way', () => {
    // ICU versions differ between ' and ’ – both are correct de-CH.
    expect(formatCount(184220)).toMatch(/^184['’]220$/);
    expect(formatCount(Number.NaN)).toBe('–');
    expect(plain(formatPercent(37.4))).toBe('37 %');
  });

  it('humanises bytes in binary steps', () => {
    expect(plain(formatBytes(0))).toBe('0 B');
    expect(plain(formatBytes(512))).toBe('512 B');
    // One decimal below 100, whole numbers above.
    expect(plain(formatBytes(9663676416))).toBe('9.0 GB');
    expect(plain(formatBytes(135089336320))).toBe('126 GB');
    expect(plain(formatBytes(1966087954432))).toBe('1.8 TB');
    expect(plain(formatBytesOf(41231564800, 135089336320))).toBe('38.4 / 126 GB');
    expect(plain(formatBytesOf(0, 0))).toBe('0 / 0 B');
  });

  it('clamps shares to 0–100', () => {
    expect(percentOf(5, 10)).toBe(50);
    expect(percentOf(20, 10)).toBe(100);
    expect(percentOf(5, 0)).toBe(0);
  });
});

describe('durations and times', () => {
  it('formats durations', () => {
    expect(plain(formatDuration(13))).toBe('13 s');
    expect(plain(formatDuration(6041))).toBe('1 Std. 40 Min.');
    expect(plain(formatDuration(7200))).toBe('2 Std.');
    expect(plain(formatDuration(1728000))).toBe('20 Tage');
    expect(plain(formatDuration(90000))).toBe('1 Tag 1 Std.');
  });

  it('formats ages relative to now', () => {
    const now = new Date(2026, 9, 13, 10, 0).getTime();
    expect(formatAgo(now - 10_000, now)).toBe('gerade eben');
    expect(plain(formatAgo(now - 5 * 60_000, now))).toBe('vor 5 Min.');
    expect(plain(formatAgo(now - 2 * 3_600_000, now))).toBe('vor 2 Std.');
    expect(plain(formatAgo(now - 3 * 86_400_000, now))).toBe('vor 3 Tagen');
    expect(formatAgo(new Date(2026, 8, 12).getTime(), now)).toBe('am 12.09.2026');
    expect(formatDaysAgo(0)).toBe('heute');
    expect(formatDaysAgo(1)).toBe('gestern');
  });

  it('names the day only when it is not today', () => {
    const now = new Date(2026, 9, 13, 10, 0).getTime(); // Tuesday
    expect(formatDayTime(new Date(2026, 9, 13, 15, 30).getTime(), now)).toBe('15:30');
    expect(formatDayTime(new Date(2026, 9, 14, 3, 0).getTime(), now)).toBe('morgen 03:00');
    expect(formatDayTime(new Date(2026, 9, 12, 22, 10).getTime(), now)).toBe('gestern 22:10');
    expect(formatDayTime(new Date(2026, 9, 16, 3, 0).getTime(), now)).toBe('Fr 03:00');
    expect(formatDayTime(new Date(2026, 9, 24, 3, 0).getTime(), now)).toBe('24.10. 03:00');
    expect(dayOffset(new Date(2026, 9, 14, 0, 30).getTime(), now)).toBe(1);
  });

  it("reads clamd's asctime date", () => {
    expect(parseClamdDate('Mon Oct 12 22:31:12 2026')).toBe(new Date(2026, 9, 12, 22, 31, 12).getTime());
    expect(parseClamdDate('Tue Oct  6 04:05:00 2026')).toBe(new Date(2026, 9, 6, 4, 5, 0).getTime());
    expect(parseClamdDate(null)).toBeNull();
    expect(parseClamdDate('kaputt')).toBeNull();
  });
});
