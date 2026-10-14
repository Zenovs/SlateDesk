import type { LagraTeil } from '../../lagra/types';
import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

/** Sections the tile can show, in lagra's order («neu» has its own widget). */
export const LAGRA_STATUS_SECTIONS = [
  'server',
  'jobs',
  'viren',
  'dam',
  'archiv',
  'feedback',
  'potentiale',
  'api',
  'nas',
] as const satisfies readonly LagraTeil[];

export type LagraStatusSection = (typeof LAGRA_STATUS_SECTIONS)[number];

export type LagraStatusSettings = Record<LagraStatusSection, boolean> & {
  /** Seconds between two requests. */
  refreshSeconds: number;
};

export const LAGRA_STATUS_LABELS: Record<LagraStatusSection, string> = {
  server: 'Server',
  jobs: 'Aufgaben',
  viren: 'Virenscanner',
  dam: 'DAM',
  archiv: 'Archiv',
  feedback: 'Rückmeldungen (Team)',
  potentiale: 'Potentiale',
  api: 'Schnittstellen',
  nas: 'NAS',
};

const SECTION_DESCRIPTIONS: Record<LagraStatusSection, string> = {
  server: 'CPU, Arbeitsspeicher, Grafikkarte, Temperaturen und Laufwerke',
  jobs: 'Laufende Aufgaben, Fehler der letzten 24 Stunden, Zeitplan',
  viren: 'Erreichbarkeit, Alter der Signaturen, Prüfungen und Funde',
  dam: 'Dateien, ausstehende Vorschauen, Fortschritt der KI-Verschlagwortung',
  archiv: 'Dateien im Archiv und letzter Abgleich',
  feedback: 'Zahlen fürs ganze Team – nicht die persönlichen',
  potentiale: 'Anzahl je Stand – ohne Kunden und Titel',
  api: 'Ollama, Aufrufe und Fehler der letzten 24 Stunden',
  nas: 'Volumen und Temperaturen. Fragt das NAS direkt und wird darum höchstens alle 2 Minuten aktualisiert.',
};

export const LAGRA_STATUS_DEFAULTS: LagraStatusSettings = {
  server: true,
  jobs: true,
  viren: true,
  dam: true,
  archiv: false,
  feedback: false,
  potentiale: false,
  api: false,
  nas: false,
  refreshSeconds: 30,
};

const settingsSchema: SettingsField[] = [
  {
    type: 'section',
    label: 'Bereiche',
    description: 'Der Bildschirm zeigt nur Zahlen und Zustände – keine Namen von Kunden oder Dateien.',
  },
  ...LAGRA_STATUS_SECTIONS.map(
    (section): SettingsField => ({
      type: 'boolean',
      key: section,
      label: LAGRA_STATUS_LABELS[section],
      description: SECTION_DESCRIPTIONS[section],
    }),
  ),
  { type: 'section', label: 'Aktualisierung' },
  {
    type: 'number',
    key: 'refreshSeconds',
    label: 'Aktualisieren alle',
    min: 10,
    max: 600,
    step: 5,
    unit: 's',
  },
];

export const lagraStatusManifest: WidgetManifest = {
  id: 'lagra-status',
  name: 'lagra Übersicht',
  description: 'Zustand von lagra auf einen Blick: Server, Aufgaben, Virenscanner, DAM und mehr',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'lagra',
  icon: 'Server',
  minWidth: 3,
  minHeight: 2,
  defaultWidth: 6,
  defaultHeight: 4,
  permissions: ['network'],
  refreshInterval: LAGRA_STATUS_DEFAULTS.refreshSeconds,
  settingsSchema,
  defaultSettings: LAGRA_STATUS_DEFAULTS,
};
