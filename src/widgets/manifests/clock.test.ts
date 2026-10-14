import { describe, expect, it } from 'vitest';
import { upgradeLegacyClockSettings } from './clock';

describe('upgradeLegacyClockSettings', () => {
  it('keeps the automatic zone label of pre-3.0 clocks outside Zürich', () => {
    expect(upgradeLegacyClockSettings({ timezone: 'America/New_York', timeFormat: '12h' })).toEqual({
      timezone: 'America/New_York',
      timeFormat: '12h',
      showTimezoneLabel: true,
    });
  });

  it('leaves Zürich, missing zones and explicit choices alone', () => {
    const zurich = { timezone: 'Europe/Zurich' };
    const noZone = { showSeconds: true };
    const explicit = { timezone: 'Asia/Tokyo', showTimezoneLabel: false };
    expect(upgradeLegacyClockSettings(zurich)).toBe(zurich);
    expect(upgradeLegacyClockSettings(noZone)).toBe(noZone);
    expect(upgradeLegacyClockSettings(explicit)).toBe(explicit);
  });
});
