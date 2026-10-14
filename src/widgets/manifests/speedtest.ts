import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type SpeedtestSettings = {
  /** 0 = nur manuell. The schedule counts from the last measurement, so it survives restarts. */
  intervalMinutes: number;
  /** Measure right after the app started instead of waiting for the schedule. */
  runOnStartup: boolean;
  /** Full scale of the download gauge (the subscribed bandwidth). */
  expectedDownloadMbps: number;
  /** Full scale of the upload gauge – uplinks are usually much slower. */
  expectedUploadMbps: number;
  slowDownloadMbps: number;
  slowUploadMbps: number;
  historyHours: number;
  showPing: boolean;
};

export const SPEEDTEST_INTERVAL_OPTIONS: readonly number[] = [0, 15, 30, 60, 120, 240];

export const SPEEDTEST_DEFAULT_SETTINGS: SpeedtestSettings = {
  intervalMinutes: 60,
  runOnStartup: false,
  expectedDownloadMbps: 100,
  expectedUploadMbps: 20,
  slowDownloadMbps: 10,
  slowUploadMbps: 2,
  historyHours: 12,
  showPing: true,
};

const speedtestSettingsSchema: SettingsField[] = [
  { type: 'section', label: 'Messung' },
  {
    key: 'intervalMinutes',
    type: 'select',
    label: 'Automatisch messen',
    description:
      'Eine Messung überträgt bis zu ca. 35 MB (stündlich also rund 0.8 GB pro Tag). Der Zeitplan zählt ab der letzten Messung und läuft nach einem Neustart weiter.',
    options: [
      { value: 0, label: 'Nur manuell' },
      { value: 15, label: 'Alle 15 Minuten' },
      { value: 30, label: 'Alle 30 Minuten' },
      { value: 60, label: 'Stündlich' },
      { value: 120, label: 'Alle 2 Stunden' },
      { value: 240, label: 'Alle 4 Stunden' },
    ],
  },
  {
    key: 'runOnStartup',
    type: 'boolean',
    label: 'Beim Start messen',
    description: 'Sonst gilt der Zeitplan ab der letzten Messung',
  },
  {
    type: 'section',
    label: 'Erwartete Geschwindigkeit',
    description: 'Vollausschlag der Anzeigen – am besten die Werte des Internet-Abos.',
  },
  { key: 'expectedDownloadMbps', type: 'number', label: 'Download', unit: 'Mbit/s', min: 1, max: 100000, step: 1 },
  { key: 'expectedUploadMbps', type: 'number', label: 'Upload', unit: 'Mbit/s', min: 1, max: 100000, step: 1 },
  {
    type: 'section',
    label: 'Warnung «Internet langsam»',
    description: 'Erscheint, wenn eine Messung unter diesen Werten liegt.',
  },
  { key: 'slowDownloadMbps', type: 'number', label: 'Download unter', unit: 'Mbit/s', min: 0, max: 100000, step: 0.5 },
  { key: 'slowUploadMbps', type: 'number', label: 'Upload unter', unit: 'Mbit/s', min: 0, max: 100000, step: 0.5 },
  { type: 'section', label: 'Anzeige' },
  {
    key: 'historyHours',
    type: 'select',
    label: 'Verlauf',
    options: [
      { value: 6, label: 'Letzte 6 Stunden' },
      { value: 12, label: 'Letzte 12 Stunden' },
      { value: 24, label: 'Letzte 24 Stunden' },
      { value: 48, label: 'Letzte 48 Stunden' },
    ],
  },
  { key: 'showPing', type: 'boolean', label: 'Ping und Jitter anzeigen' },
];

export const speedtestManifest: WidgetManifest = {
  id: 'speedtest',
  name: 'Speedtest',
  description: 'Download, Upload und Ping der Internetverbindung',
  version: '3.0.0',
  author: 'SlateDesk',
  category: 'Netzwerk',
  icon: 'Gauge',
  minWidth: 3,
  minHeight: 3,
  defaultWidth: 4,
  defaultHeight: 4,
  permissions: ['network'],
  settingsSchema: speedtestSettingsSchema,
  defaultSettings: SPEEDTEST_DEFAULT_SETTINGS,
};
