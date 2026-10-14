import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayNumber,
  daysBetween,
  endOfWeek,
  formatDay,
  formatWeekday,
  laterDay,
  weekdayIndex,
  zurichDay,
  zurichMinuteOfDay,
} from './days';

const at = (iso: string): number => Date.parse(iso);

describe('zurichDay', () => {
  it('switches at Zurich midnight in winter (UTC+1) and summer (UTC+2)', () => {
    expect(zurichDay(at('2026-01-14T22:59:59Z'))).toBe('2026-01-14');
    expect(zurichDay(at('2026-01-14T23:00:00Z'))).toBe('2026-01-15');
    expect(zurichDay(at('2026-07-14T21:59:59Z'))).toBe('2026-07-14');
    expect(zurichDay(at('2026-07-14T22:00:00Z'))).toBe('2026-07-15');
  });

  it('handles the start of summer time (29 March 2026, 02:00 → 03:00)', () => {
    expect(zurichDay(at('2026-03-28T22:59:59Z'))).toBe('2026-03-28');
    expect(zurichDay(at('2026-03-28T23:00:00Z'))).toBe('2026-03-29');
    expect(zurichDay(at('2026-03-29T01:00:00Z'))).toBe('2026-03-29');
    // The day has 23 hours: it ends at 22:00 UTC already.
    expect(zurichDay(at('2026-03-29T21:59:59Z'))).toBe('2026-03-29');
    expect(zurichDay(at('2026-03-29T22:00:00Z'))).toBe('2026-03-30');
  });

  it('handles the end of summer time (25 October 2026, 03:00 → 02:00)', () => {
    expect(zurichDay(at('2026-10-24T21:59:59Z'))).toBe('2026-10-24');
    expect(zurichDay(at('2026-10-24T22:00:00Z'))).toBe('2026-10-25');
    // The day has 25 hours: it ends at 23:00 UTC.
    expect(zurichDay(at('2026-10-25T22:59:59Z'))).toBe('2026-10-25');
    expect(zurichDay(at('2026-10-25T23:00:00Z'))).toBe('2026-10-26');
  });
});

describe('zurichMinuteOfDay', () => {
  it('reads the Zurich wall clock', () => {
    expect(zurichMinuteOfDay(at('2026-01-14T23:00:00Z'))).toBe(0);
    expect(zurichMinuteOfDay(at('2026-10-13T06:30:00Z'))).toBe(8 * 60 + 30);
    expect(zurichMinuteOfDay(at('2026-03-29T01:00:00Z'))).toBe(3 * 60);
    // 02:30 happens twice when summer time ends.
    expect(zurichMinuteOfDay(at('2026-10-25T00:30:00Z'))).toBe(2 * 60 + 30);
    expect(zurichMinuteOfDay(at('2026-10-25T01:30:00Z'))).toBe(2 * 60 + 30);
  });
});

describe('day arithmetic', () => {
  it('accepts only real calendar days', () => {
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayNumber('2026-02-29')).toBeNull();
    expect(dayNumber('2028-02-29')).not.toBeNull();
    expect(dayNumber('2026-13-01')).toBeNull();
    expect(dayNumber('13.10.2026')).toBeNull();
    expect(dayNumber(null)).toBeNull();
    expect(dayNumber('')).toBeNull();
  });

  it('adds days across months, years and the clock change', () => {
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('kaputt', 1)).toBe('kaputt');
  });

  it('counts calendar days between two days', () => {
    expect(daysBetween('2026-10-13', '2026-10-13')).toBe(0);
    expect(daysBetween('2026-10-13', '2026-10-14')).toBe(1);
    expect(daysBetween('2026-10-13', '2026-10-10')).toBe(-3);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-10-13', null)).toBeNull();
  });

  it('knows weekdays and the end of the week (Monday to Sunday)', () => {
    expect(weekdayIndex('2026-10-12')).toBe(0);
    expect(weekdayIndex('2026-10-13')).toBe(1);
    expect(weekdayIndex('2026-10-18')).toBe(6);
    expect(weekdayIndex('1969-12-31')).toBe(2);
    expect(endOfWeek('2026-10-13')).toBe('2026-10-18');
    expect(endOfWeek('2026-10-18')).toBe('2026-10-18');
    expect(endOfWeek('2026-12-29')).toBe('2027-01-03');
  });

  it('picks the later of two days, ignoring invalid ones', () => {
    expect(laterDay('2026-10-13', '2026-10-14')).toBe('2026-10-14');
    expect(laterDay('2026-10-14', '2026-10-13')).toBe('2026-10-14');
    expect(laterDay('', '2026-10-13')).toBe('2026-10-13');
    expect(laterDay('2026-10-13', 'x')).toBe('2026-10-13');
  });
});

describe('formatDay', () => {
  it('shows weekday and date, the year only when it differs', () => {
    expect(formatDay('2026-10-17', '2026-10-13')).toBe('Sa 17.10.');
    expect(formatDay('2027-01-05', '2026-10-13')).toBe('Di 05.01.27');
    expect(formatWeekday('2026-10-15')).toBe('Do');
  });
});
