import { describe, expect, it } from 'vitest';
import { formatCount } from '../shared/format';
import {
  deadlineText,
  dueText,
  formatElapsed,
  formatHours,
  formatHoursOf,
  formatMinutes,
  initials,
  personHue,
} from './format';

const NBSP = '\u00a0';

describe('hours and minutes', () => {
  it('formats booked minutes as h:mm', () => {
    expect(formatMinutes(0)).toBe('0:00');
    expect(formatMinutes(450)).toBe('7:30');
    expect(formatMinutes(59.6)).toBe('1:00');
    expect(formatMinutes(504)).toBe('8:24');
    expect(formatMinutes(-5)).toBe('0:00');
    expect(formatMinutes(Number.NaN)).toBe('0:00');
  });

  it('formats a running timer as h:mm:ss', () => {
    expect(formatElapsed(3_909_000)).toBe('1:05:09');
    expect(formatElapsed(59_999)).toBe('0:00:59');
    expect(formatElapsed(-1)).toBe('0:00:00');
  });

  it('formats hours with at most one decimal and de-CH grouping', () => {
    expect(formatHours(2)).toBe(`2${NBSP}Std.`);
    expect(formatHours(1.5)).toBe(`1.5${NBSP}Std.`);
    expect(formatHours(1.25)).toBe(`1.3${NBSP}Std.`);
    expect(formatHours(0.04)).toBe(`0${NBSP}Std.`);
    // Grouping character as the platform's de-CH locale writes it (’ or ').
    expect(formatHours(1234)).toBe(`${formatCount(1234)}${NBSP}Std.`);
    expect(formatHours(Number.NaN)).toBe('–');
    expect(formatHoursOf(12.5, 16)).toBe(`12.5 / 16${NBSP}Std.`);
  });
});

describe('initials', () => {
  it('uses first and last name, or the start of a single name / e-mail', () => {
    expect(initials('Anna Muster')).toBe('AM');
    expect(initials('Hans-Peter Müller')).toBe('HM');
    expect(initials('  beat  ')).toBe('BE');
    expect(initials('carla@schnyder-werbung.ch')).toBe('CA');
    expect(initials('carla.muster@schnyder-werbung.ch')).toBe('CM');
    expect(initials('')).toBe('?');
  });

  it('gives every person a stable hue', () => {
    const hue = personHue('cmv6tqqct0002vtincdowd0j7');
    expect(hue).toBe(personHue('cmv6tqqct0002vtincdowd0j7'));
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
    expect(personHue('cmv6tqqcw0003vtinqamf0m6q')).not.toBe(hue);
  });
});

describe('deadlineText', () => {
  const today = '2026-10-13';

  it('names overdue, close and later deadlines', () => {
    expect(deadlineText('2026-10-12', today)).toEqual({ text: '1 Tag überfällig', tone: 'overdue' });
    expect(deadlineText('2026-10-10', today)).toEqual({ text: '3 Tage überfällig', tone: 'overdue' });
    expect(deadlineText('2026-10-13', today)).toEqual({ text: 'heute fällig', tone: 'soon' });
    expect(deadlineText('2026-10-14', today)).toEqual({ text: 'morgen fällig', tone: 'soon' });
    expect(deadlineText('2026-10-16', today)).toEqual({ text: 'in 3 Tagen', tone: 'soon' });
    expect(deadlineText('2026-10-20', today)).toEqual({ text: 'in 7 Tagen', tone: 'normal' });
    expect(deadlineText('2026-10-27', today)).toEqual({ text: 'bis Di 27.10.', tone: 'normal' });
  });
});

describe('dueText', () => {
  // Tuesday: Wednesday … Sunday are «this week».
  const today = '2026-10-13';

  it('uses words near today, the weekday within this week and the date beyond', () => {
    expect(dueText('2026-10-13', today)).toBe('Heute');
    expect(dueText('2026-10-14', today)).toBe('Morgen');
    expect(dueText('2026-10-12', today)).toBe('Gestern');
    expect(dueText('2026-10-15', today)).toBe('Do');
    expect(dueText('2026-10-18', today)).toBe('So');
    expect(dueText('2026-10-19', today)).toBe('Mo 19.10.');
    expect(dueText('2026-10-06', today)).toBe('Di 06.10.');
  });

  it('shows the date on Sunday for next week already', () => {
    expect(dueText('2026-10-20', '2026-10-18')).toBe('Di 20.10.');
  });
});
