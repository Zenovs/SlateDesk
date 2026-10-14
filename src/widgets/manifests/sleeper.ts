import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type SleeperSettings = {
  /** '' = default camera (never pinned to a deviceId). Chosen on the kiosk (settingsExtra). */
  deviceId: string;
  autoStart: boolean;
  /** Minutes without a detected person or touch until the display goes off. */
  timeoutMinutes: number;
  /** Dark overlay for SLEEPER_DIM_SECONDS before the display is switched off. */
  dimFirst: boolean;
  /** Never wake the display while the display schedule (kiosk settings) has it off. */
  respectSchedule: boolean;
  checkEverySeconds: number;
  /** 0..1 */
  scoreThreshold: number;
  /** TinyFaceDetector input size in px. */
  inputSize: number;
};

export const SLEEPER_DEFAULT_SETTINGS: SleeperSettings = {
  deviceId: '',
  autoStart: true,
  timeoutMinutes: 15,
  dimFirst: true,
  respectSchedule: true,
  checkEverySeconds: 2,
  scoreThreshold: 0.4,
  inputSize: 160,
};

export const SLEEPER_TIMEOUT_LIMITS = { min: 1, max: 240 } as const;
export const SLEEPER_CHECK_LIMITS = { min: 1, max: 10 } as const;
export const SLEEPER_DIM_SECONDS = 30;

/**
 * Defaults of the pre-backend widget for instances imported from it (it saved
 * only changed keys): it did not start on its own and waited 180 minutes.
 */
export const SLEEPER_LEGACY_DEFAULTS: Pick<SleeperSettings, 'autoStart' | 'timeoutMinutes'> = {
  autoStart: false,
  timeoutMinutes: Math.min(180, SLEEPER_TIMEOUT_LIMITS.max),
};

const sleeperSettingsSchema: SettingsField[] = [
  {
    type: 'section',
    label: 'Ruhemodus',
    description:
      'Schaltet den Bildschirm aus, wenn die Kamera eine Weile niemanden sieht – und wieder ein, sobald jemand davorsteht oder den Bildschirm berührt.',
  },
  {
    key: 'timeoutMinutes',
    type: 'range',
    label: 'Ausschalten nach',
    description: 'So lange ohne erkannte Person und ohne Berührung.',
    min: SLEEPER_TIMEOUT_LIMITS.min,
    max: SLEEPER_TIMEOUT_LIMITS.max,
    step: 1,
    unit: 'Min.',
  },
  {
    key: 'dimFirst',
    type: 'boolean',
    label: 'Zuerst abdunkeln',
    description: `${SLEEPER_DIM_SECONDS} Sekunden abgedunkelt, bevor der Bildschirm ausgeht – eine Berührung hält ihn wach.`,
  },
  {
    key: 'respectSchedule',
    type: 'boolean',
    label: 'Bildschirm-Zeitplan beachten',
    description: 'Ausserhalb der Einschaltzeiten des Kiosks weckt die Kamera den Bildschirm nicht.',
  },
  {
    key: 'autoStart',
    type: 'boolean',
    label: 'Automatisch starten',
    description: 'Ruhemodus beim Start des Kiosks aktivieren.',
  },
  { type: 'section', label: 'Erkennung', description: 'Welche Kamera verwendet wird, lässt sich am Kiosk einstellen.' },
  {
    key: 'checkEverySeconds',
    type: 'range',
    label: 'Prüfen alle',
    description: 'Wie oft die Kamera nach Personen schaut.',
    min: SLEEPER_CHECK_LIMITS.min,
    max: SLEEPER_CHECK_LIMITS.max,
    step: 1,
    unit: 's',
  },
  {
    key: 'scoreThreshold',
    type: 'range',
    label: 'Erkennungsschwelle',
    description: 'Höher = weniger Fehlerkennungen, dafür werden entfernte Gesichter eher übersehen.',
    min: 0.1,
    max: 0.9,
    step: 0.05,
  },
  {
    key: 'inputSize',
    type: 'select',
    label: 'Genauigkeit',
    description: 'Genauer erkennt auch Personen weiter weg, braucht aber mehr Rechenleistung.',
    options: [
      { value: 128, label: 'Sehr schnell (128 px)' },
      { value: 160, label: 'Schnell (160 px)' },
      { value: 224, label: 'Ausgewogen (224 px)' },
      { value: 320, label: 'Genau (320 px)' },
    ],
  },
];

export const sleeperManifest: WidgetManifest = {
  id: 'sleeper',
  name: 'Ruhemodus',
  description: 'Schaltet den Bildschirm aus, wenn niemand da ist, und weckt ihn per Kamera wieder auf',
  version: '2.0.0',
  author: 'SlateDesk',
  category: 'Sensorik & KI',
  icon: 'MoonStar',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 2,
  defaultHeight: 3,
  permissions: ['camera'],
  settingsSchema: sleeperSettingsSchema,
  defaultSettings: SLEEPER_DEFAULT_SETTINGS,
  singleton: true,
};
