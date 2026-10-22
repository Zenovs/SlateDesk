import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type LifetimeSettings = {
  /** Seconds per round. */
  periodSeconds: number;
  /** How long the app has been running since its last start. */
  showUptime: boolean;
};

export const LIFETIME_PERIODS: readonly number[] = [6, 10, 15, 20, 30];

export const LIFETIME_DEFAULT_SETTINGS: LifetimeSettings = {
  periodSeconds: 15,
  showUptime: false,
};

const lifetimeSettingsSchema: SettingsField[] = [
  {
    key: 'periodSeconds',
    type: 'select',
    label: 'Eine Runde dauert',
    options: LIFETIME_PERIODS.map((seconds) => ({
      value: seconds,
      label: seconds === LIFETIME_DEFAULT_SETTINGS.periodSeconds ? `${seconds} Sekunden (Standard)` : `${seconds} Sekunden`,
    })),
  },
  {
    key: 'showUptime',
    type: 'boolean',
    label: 'Laufzeit anzeigen',
    description: 'Wie lange SlateDesk seit dem letzten Neustart läuft.',
  },
];

export const lifetimeManifest: WidgetManifest = {
  id: 'lifetime',
  name: 'Lifetime',
  description: 'Ein Punkt kreist ruhig, solange Kiosk und Dienst laufen – steht er still, hängt etwas',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'Netzwerk',
  icon: 'Activity',
  minWidth: 1,
  minHeight: 1,
  defaultWidth: 2,
  defaultHeight: 2,
  permissions: ['system'],
  refreshInterval: 5,
  settingsSchema: lifetimeSettingsSchema,
  defaultSettings: LIFETIME_DEFAULT_SETTINGS,
};
