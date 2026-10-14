import type { WidgetManifest } from '../../types/widget';
import type { SettingsField } from '../../types/settings';

export type CalendarView = 'agenda' | 'heute' | 'jetzt';
export type CalendarPrivacy = 'normal' | 'besetzt';

export type CalendarSourceSetting = {
  name: string;
  url: string;
  color: string;
  enabled: boolean;
};

export type CalendarSettings = {
  sources: CalendarSourceSetting[];
  view: CalendarView;
  /** Including today: 1 = only today. */
  daysAhead: number;
  maxEvents: number;
  showLocation: boolean;
  privacy: CalendarPrivacy;
  refreshMinutes: number;
  showSourceColors: boolean;
};

const CALENDAR_DAYS_AHEAD = [1, 3, 7, 14, 30] as const;

/** Where Office 365 hands out the ICS link of a calendar. */
export const OFFICE365_ICS_HINT =
  'Outlook → Einstellungen → Kalender → Freigegebene Kalender → Kalender veröffentlichen → ICS-Link';

export const CALENDAR_DEFAULT_SETTINGS: CalendarSettings = {
  sources: [],
  view: 'agenda',
  daysAhead: 7,
  maxEvents: 8,
  showLocation: true,
  privacy: 'normal',
  refreshMinutes: 5,
  showSourceColors: true,
};

const SETTINGS_SCHEMA: SettingsField[] = [
  {
    type: 'section',
    label: 'Kalender',
    description: `ICS- oder webcal-Links. Office 365: ${OFFICE365_ICS_HINT}.`,
  },
  {
    key: 'sources',
    type: 'list',
    label: 'Kalenderquellen',
    addLabel: 'Kalender hinzufügen',
    itemTitleKey: 'name',
    newItem: () => ({ name: '', url: '', color: '#4a9eff', enabled: true }),
    itemFields: [
      { key: 'name', type: 'text', label: 'Name', placeholder: 'z.B. Team oder Sitzungszimmer' },
      {
        key: 'url',
        type: 'url',
        label: 'ICS-Link',
        placeholder: 'https://outlook.office365.com/owa/calendar/…/calendar.ics',
      },
      { key: 'color', type: 'color', label: 'Farbe' },
      { key: 'enabled', type: 'boolean', label: 'Anzeigen' },
    ],
  },
  { type: 'section', label: 'Anzeige' },
  {
    key: 'view',
    type: 'radio',
    label: 'Ansicht',
    options: [
      { value: 'agenda', label: 'Agenda' },
      { value: 'heute', label: 'Heute' },
      { value: 'jetzt', label: 'Jetzt / Als Nächstes' },
    ],
  },
  {
    key: 'daysAhead',
    type: 'select',
    label: 'Zeitraum',
    description: 'Wie weit voraus Termine gezeigt (Agenda) bzw. gesucht (Als Nächstes) werden.',
    options: CALENDAR_DAYS_AHEAD.map((days) => ({
      value: days,
      label: days === 1 ? 'Nur heute' : `Nächste ${days} Tage`,
    })),
    showIf: (values) => values.view !== 'heute',
  },
  { key: 'maxEvents', type: 'range', label: 'Maximale Anzahl Termine', min: 1, max: 30 },
  { key: 'showLocation', type: 'boolean', label: 'Ort anzeigen', showIf: (values) => values.privacy !== 'besetzt' },
  {
    key: 'showSourceColors',
    type: 'boolean',
    label: 'Kalenderfarben anzeigen',
    description: 'Aus: alle Termine in der Akzentfarbe.',
  },
  {
    type: 'section',
    label: 'Datenschutz',
    description: 'Als privat markierte Termine erscheinen immer nur als «Privat».',
  },
  {
    key: 'privacy',
    type: 'radio',
    label: 'Termintitel',
    description: 'Für Bildschirme, die Besucher sehen: «Besetzt» zeigt nur die Zeiten, ohne Titel und Ort.',
    options: [
      { value: 'normal', label: 'Anzeigen' },
      { value: 'besetzt', label: 'Nur «Besetzt»' },
    ],
  },
  { type: 'section', label: 'Aktualisierung' },
  {
    key: 'refreshMinutes',
    type: 'select',
    label: 'Kalender neu laden',
    options: [5, 10, 15, 30, 60].map((minutes) => ({ value: minutes, label: `Alle ${minutes} Minuten` })),
  },
];

export const calendarManifest: WidgetManifest = {
  id: 'calendar',
  name: 'Kalender',
  description: 'Termine aus ICS-Kalendern (Office 365, Google, iCloud …) – Agenda, Tagesansicht oder Raumbelegung',
  version: '3.0.0',
  author: 'SlateDesk',
  category: 'Zeit & Kalender',
  icon: 'CalendarDays',
  minWidth: 3,
  minHeight: 3,
  defaultWidth: 5,
  defaultHeight: 6,
  permissions: ['calendar.read'],
  refreshInterval: 300,
  settingsSchema: SETTINGS_SCHEMA,
  defaultSettings: CALENDAR_DEFAULT_SETTINGS,
};
