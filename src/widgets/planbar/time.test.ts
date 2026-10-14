import { describe, expect, it } from 'vitest';
import type { PlanbarTimeEntry, PlanbarTimer } from '../../planbar/types';
import { orderEntries, targetPercent, timerElapsedMs, timerTodayMinutes } from './time';

const timer = (startedAt: string, elapsedMinutes = 0): PlanbarTimer => ({
  startedAt,
  elapsedMinutes,
  label: 'Hosting klären',
  projectLabel: 'Website Relaunch',
  taskLabel: 'Hosting klären',
  ticketId: 'p-web',
  subTaskId: 't-1',
  url: null,
});

const entry = (id: string, name: string): PlanbarTimeEntry => ({
  user: { id, name },
  todayMinutes: 0,
  weekMinutes: 0,
  weekDays: [0, 0, 0, 0, 0, 0, 0],
  timer: null,
});

describe('running timer', () => {
  it('counts up from its start', () => {
    const now = Date.parse('2026-10-13T06:30:00Z');
    expect(timerElapsedMs(timer('2026-10-13T05:00:00Z'), now)).toBe(90 * 60_000);
    expect(timerElapsedMs(timer('kaputt', 30), now)).toBe(30 * 60_000);
    expect(timerElapsedMs(timer('2026-10-13T07:00:00Z'), now)).toBe(0);
  });

  it('counts only the part since Zurich midnight to today', () => {
    // 08:30 in Zurich (summer time).
    const now = Date.parse('2026-10-13T06:30:00Z');
    expect(timerTodayMinutes(timer('2026-10-13T05:00:00Z'), now)).toBe(90);
    // Left running since 22:00 the evening before.
    expect(timerTodayMinutes(timer('2026-10-12T20:00:00Z'), now)).toBe(8 * 60 + 30);
    // Winter time: 00:30 in Zurich is 23:30 UTC.
    expect(timerTodayMinutes(timer('2026-12-01T22:00:00Z'), Date.parse('2026-12-01T23:30:00Z'))).toBe(30);
  });
});

describe('orderEntries', () => {
  const entries = [entry('c', 'carla@schnyder-werbung.ch'), entry('b', 'Beat Leiter'), entry('a', 'Anna Muster')];

  it('keeps the selected order and drops people planbar does not know', () => {
    expect(orderEntries(entries, ['b', 'x', 'c']).map((e) => e.user.id)).toEqual(['b', 'c']);
  });

  it('sorts everyone by name without a selection', () => {
    expect(orderEntries(entries, []).map((e) => e.user.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('targetPercent', () => {
  it('measures against the target and allows overtime', () => {
    expect(targetPercent(252, 504)).toBe(50);
    expect(targetPercent(600, 504)).toBeGreaterThan(100);
    expect(targetPercent(100, 0)).toBe(0);
    expect(targetPercent(-5, 504)).toBe(0);
  });
});
