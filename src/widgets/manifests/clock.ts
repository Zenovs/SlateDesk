import type { WidgetManifest } from '../../types/widget';
import type { SettingsField } from '../../types/settings';

export type ClockStyle = 'digital' | 'analog';
export type ClockTimeFormat = '24h' | '12h';
export type ClockDateFormat = 'lang' | 'DD.MM.YY' | 'DD.MM.YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'none';

export type WorldClock = {
  label: string;
  timezone: string;
};

export type ClockSettings = {
  style: ClockStyle;
  timeFormat: ClockTimeFormat;
  showSeconds: boolean;
  dateFormat: ClockDateFormat;
  showWeekNumber: boolean;
  timezone: string;
  showTimezoneLabel: boolean;
  worldClocks: WorldClock[];
};

export const DEFAULT_TIMEZONE = 'Europe/Zurich';

/** More are stored if the user adds them, but only this many fit in the row. */
export const MAX_WORLD_CLOCKS = 4;

/**
 * Curated zones with German names. Labels carry no abbreviation – those
 * change with daylight saving time and are computed live by the widget.
 */
export const TIMEZONE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'Europe/Zurich', label: 'Zürich' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Europe/Vienna', label: 'Wien' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Rome', label: 'Rom' },
  { value: 'Europe/Madrid', label: 'Madrid' },
  { value: 'Europe/Amsterdam', label: 'Amsterdam' },
  { value: 'Europe/Brussels', label: 'Brüssel' },
  { value: 'Europe/Stockholm', label: 'Stockholm' },
  { value: 'Europe/Warsaw', label: 'Warschau' },
  { value: 'Europe/Prague', label: 'Prag' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Dublin', label: 'Dublin' },
  { value: 'Europe/Lisbon', label: 'Lissabon' },
  { value: 'Europe/Helsinki', label: 'Helsinki' },
  { value: 'Europe/Athens', label: 'Athen' },
  { value: 'Europe/Istanbul', label: 'Istanbul' },
  { value: 'Europe/Moscow', label: 'Moskau' },
  { value: 'Africa/Casablanca', label: 'Casablanca' },
  { value: 'Africa/Lagos', label: 'Lagos' },
  { value: 'Africa/Cairo', label: 'Kairo' },
  { value: 'Africa/Johannesburg', label: 'Johannesburg' },
  { value: 'Africa/Nairobi', label: 'Nairobi' },
  { value: 'Asia/Jerusalem', label: 'Jerusalem' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Karachi', label: 'Karachi' },
  { value: 'Asia/Kolkata', label: 'Mumbai / Delhi' },
  { value: 'Asia/Bangkok', label: 'Bangkok' },
  { value: 'Asia/Singapore', label: 'Singapur' },
  { value: 'Asia/Hong_Kong', label: 'Hongkong' },
  { value: 'Asia/Shanghai', label: 'Shanghai / Peking' },
  { value: 'Asia/Taipei', label: 'Taipeh' },
  { value: 'Asia/Seoul', label: 'Seoul' },
  { value: 'Asia/Tokyo', label: 'Tokio' },
  { value: 'Australia/Perth', label: 'Perth' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Pacific/Auckland', label: 'Auckland' },
  { value: 'Pacific/Honolulu', label: 'Honolulu' },
  { value: 'America/Anchorage', label: 'Anchorage' },
  { value: 'America/Los_Angeles', label: 'Los Angeles / San Francisco' },
  { value: 'America/Vancouver', label: 'Vancouver' },
  { value: 'America/Denver', label: 'Denver' },
  { value: 'America/Phoenix', label: 'Phoenix' },
  { value: 'America/Chicago', label: 'Chicago' },
  { value: 'America/Mexico_City', label: 'Mexiko-Stadt' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Toronto', label: 'Toronto' },
  { value: 'America/Bogota', label: 'Bogotá' },
  { value: 'America/Sao_Paulo', label: 'São Paulo' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires' },
  { value: 'UTC', label: 'UTC (Weltzeit)' },
];

const DATE_FORMAT_OPTIONS: { value: ClockDateFormat; label: string }[] = [
  { value: 'lang', label: 'Ausgeschrieben (Dienstag, 13. Oktober 2026)' },
  { value: 'DD.MM.YY', label: 'DI 13.10.26' },
  { value: 'DD.MM.YYYY', label: 'DI 13.10.2026' },
  { value: 'MM/DD/YYYY', label: 'DI 10/13/2026' },
  { value: 'YYYY-MM-DD', label: 'DI 2026-10-13' },
  { value: 'none', label: 'Kein Datum' },
];

export const CLOCK_DEFAULT_SETTINGS: ClockSettings = {
  style: 'digital',
  timeFormat: '24h',
  showSeconds: false,
  dateFormat: 'lang',
  showWeekNumber: true,
  timezone: DEFAULT_TIMEZONE,
  showTimezoneLabel: false,
  worldClocks: [],
};

/**
 * Settings of a pre-3.0 clock (localStorage import) brought to 3.0 – apply
 * once, at the legacy import only. Back then every zone other than Zürich
 * was labelled automatically; 3.0 has a switch for that, off by default.
 * At runtime this must not run: a 3.0 clock whose switch was never touched
 * stores no `showTimezoneLabel` either (the form only writes changed keys).
 */
export function upgradeLegacyClockSettings(settings: Record<string, unknown>): Record<string, unknown> {
  if (settings.showTimezoneLabel !== undefined) return settings;
  if (typeof settings.timezone !== 'string' || settings.timezone === DEFAULT_TIMEZONE) return settings;
  return { ...settings, showTimezoneLabel: true };
}

const SETTINGS_SCHEMA: SettingsField[] = [
  { type: 'section', label: 'Anzeige' },
  {
    key: 'style',
    type: 'radio',
    label: 'Darstellung',
    options: [
      { value: 'digital', label: 'Digital' },
      { value: 'analog', label: 'Analog' },
    ],
  },
  {
    key: 'timeFormat',
    type: 'radio',
    label: 'Zeitformat',
    description: 'Gilt auch für die Weltzeituhren.',
    options: [
      { value: '24h', label: '24 Stunden' },
      { value: '12h', label: '12 Stunden (AM/PM)' },
    ],
  },
  {
    key: 'showSeconds',
    type: 'boolean',
    label: 'Sekunden anzeigen',
    description: 'Bei der analogen Uhr als Sekundenzeiger.',
  },
  { key: 'dateFormat', type: 'select', label: 'Datum', options: DATE_FORMAT_OPTIONS },
  { key: 'showWeekNumber', type: 'boolean', label: 'Kalenderwoche anzeigen', description: 'z.B. «KW 42» (nach ISO 8601).' },
  { type: 'section', label: 'Zeitzone' },
  { key: 'timezone', type: 'select', label: 'Zeitzone der Uhr', options: [...TIMEZONE_OPTIONS] },
  {
    key: 'showTimezoneLabel',
    type: 'boolean',
    label: 'Zeitzone anschreiben',
    description: 'Ort und aktuelles Kürzel (z.B. «Zürich · MESZ») unter der Uhr.',
  },
  {
    type: 'section',
    label: 'Weltzeituhren',
    description: `Bis zu ${MAX_WORLD_CLOCKS} weitere Zeitzonen, kompakt unter der Uhr – mit Hinweis, wenn dort schon ein anderer Tag ist.`,
  },
  {
    key: 'worldClocks',
    type: 'list',
    label: 'Weitere Uhren',
    addLabel: 'Uhr hinzufügen',
    itemTitleKey: 'label',
    newItem: () => ({ label: '', timezone: 'America/New_York' }),
    itemFields: [
      { key: 'label', type: 'text', label: 'Bezeichnung', placeholder: 'z.B. Büro New York (leer = Ortsname)' },
      { key: 'timezone', type: 'select', label: 'Zeitzone', options: [...TIMEZONE_OPTIONS] },
    ],
  },
];

export const clockManifest: WidgetManifest = {
  id: 'clock',
  name: 'Uhr',
  description: 'Uhrzeit, Datum und Kalenderwoche – digital oder analog, mit Weltzeituhren',
  version: '3.0.0',
  author: 'SlateDesk',
  category: 'Zeit & Kalender',
  icon: 'Clock',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 3,
  defaultHeight: 3,
  // Füllt seine Fläche schon ganz – «Schriftgrösse» nur verkleinern.
  maxFontScale: 100,
  permissions: [],
  settingsSchema: SETTINGS_SCHEMA,
  defaultSettings: CLOCK_DEFAULT_SETTINGS,
};
