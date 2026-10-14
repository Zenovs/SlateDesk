import { describe, expect, it } from 'vitest';
import { LEGACY_KEYS } from '../state/migrate';
import { CAMERA_LEGACY_DEFAULTS } from '../widgets/manifests/camera';
import { SLEEPER_LEGACY_DEFAULTS, SLEEPER_TIMEOUT_LIMITS } from '../widgets/manifests/sleeper';
import { legacyDefaultsPatch, wasInLegacyLayout } from './legacyDefaults';

const storageWith = (layout: unknown) => ({
  getItem: (key: string) => (key === LEGACY_KEYS.layout ? JSON.stringify(layout) : null),
});

const OLD_LAYOUT = [
  { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 },
  { instanceId: 'sleeper-lx3k', widgetId: 'sleeper', x: 3, y: 0, w: 2, h: 3 },
  { instanceId: 'camera-9f2a', widgetId: 'camera', x: 5, y: 0, w: 3, h: 4 },
];

describe('wasInLegacyLayout', () => {
  it('finds instances of the old layout by id and widget', () => {
    const storage = storageWith(OLD_LAYOUT);
    expect(wasInLegacyLayout('sleeper', 'sleeper-lx3k', storage)).toBe(true);
    expect(wasInLegacyLayout('camera', 'sleeper-lx3k', storage)).toBe(false);
    expect(wasInLegacyLayout('sleeper', 'sleeper-new', storage)).toBe(false);
  });

  it('survives missing, corrupt and blocked storage', () => {
    expect(wasInLegacyLayout('sleeper', 'sleeper-lx3k', null)).toBe(false);
    expect(wasInLegacyLayout('sleeper', 'sleeper-lx3k', { getItem: () => '{kaputt' })).toBe(false);
    expect(wasInLegacyLayout('sleeper', 'sleeper-lx3k', storageWith({ widgets: OLD_LAYOUT }))).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(wasInLegacyLayout('sleeper', 'sleeper-lx3k', blocked)).toBe(false);
  });
});

describe('legacyDefaultsPatch', () => {
  const storage = storageWith(OLD_LAYOUT);

  it('keeps an imported Ruhemodus that never auto-started stopped, with its old timeout', () => {
    expect(legacyDefaultsPatch('sleeper', 'sleeper-lx3k', undefined, SLEEPER_LEGACY_DEFAULTS, storage)).toEqual({
      autoStart: false,
      timeoutMinutes: 180,
    });
    expect(SLEEPER_LEGACY_DEFAULTS.timeoutMinutes).toBeLessThanOrEqual(SLEEPER_TIMEOUT_LIMITS.max);
  });

  it('fills only the keys the user never changed', () => {
    const stored = { autoStart: true, deviceId: 'abc' };
    expect(legacyDefaultsPatch('sleeper', 'sleeper-lx3k', stored, SLEEPER_LEGACY_DEFAULTS, storage)).toEqual({
      timeoutMinutes: 180,
    });
    expect(
      legacyDefaultsPatch('camera', 'camera-9f2a', { deviceId: 'abc' }, CAMERA_LEGACY_DEFAULTS, storage),
    ).toEqual({ autoStart: false });
  });

  it('leaves new instances and complete settings alone', () => {
    expect(legacyDefaultsPatch('sleeper', 'sleeper-new', undefined, SLEEPER_LEGACY_DEFAULTS, storage)).toBeNull();
    expect(
      legacyDefaultsPatch('camera', 'camera-9f2a', { autoStart: true }, CAMERA_LEGACY_DEFAULTS, storage),
    ).toBeNull();
    expect(legacyDefaultsPatch('camera', 'camera-9f2a', undefined, CAMERA_LEGACY_DEFAULTS, null)).toBeNull();
  });
});
