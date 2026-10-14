import { PLANBAR_MEMBERS_PROVIDER, PLANBAR_PROJECTS_PROVIDER } from '../../planbar/options';
import type { PlanbarWorkStatus, PlanbarWorkType } from '../../planbar/types';
import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export const PLANBAR_AUFGABEN_STATUS = ['offen', 'alle'] as const satisfies readonly PlanbarWorkStatus[];
export const PLANBAR_AUFGABEN_TYPEN = ['alle', 'aufgabe', 'projekt'] as const satisfies readonly PlanbarWorkType[];

/** How far ahead (→ planbar's `bis`): due today (and overdue), this week, this and next week, everything. */
export const PLANBAR_ZEITRAEUME = ['heute', 'woche', 'zwei-wochen', 'alle'] as const;
export type PlanbarZeitraum = (typeof PLANBAR_ZEITRAEUME)[number];

export const PLANBAR_GRUPPIERUNGEN = ['faelligkeit', 'person', 'projekt'] as const;
export type PlanbarGruppierung = (typeof PLANBAR_GRUPPIERUNGEN)[number];

export type PlanbarAufgabenSettings = {
  /** planbar user ids (planbar.mitglieder), in the chosen order. Empty = nothing to show yet. */
  benutzer: string[];
  /** Optional filter: project (ticket) ids. Empty = all projects. */
  projekte: string[];
  status: PlanbarWorkStatus;
  typ: PlanbarWorkType;
  zeitraum: PlanbarZeitraum;
  gruppierung: PlanbarGruppierung;
  /** planbar's `limit` (1–200). */
  maxItems: number;
  showProject: boolean;
  /** Only shown when more than one person is selected. */
  showAssignee: boolean;
  /** Tick off tasks on the kiosk (PATCH, needs «Aufgaben & Zeiten – Schreiben»). */
  allowComplete: boolean;
  refreshSeconds: number;
};

export const PLANBAR_AUFGABEN_DEFAULTS: PlanbarAufgabenSettings = {
  benutzer: [],
  projekte: [],
  status: 'offen',
  typ: 'alle',
  zeitraum: 'alle',
  gruppierung: 'faelligkeit',
  maxItems: 30,
  showProject: true,
  showAssignee: true,
  allowComplete: false,
  refreshSeconds: 60,
};

const settingsSchema: SettingsField[] = [
  { type: 'section', label: 'Wessen Arbeit' },
  {
    type: 'multiselect',
    key: 'benutzer',
    label: 'Personen',
    description: 'Wie «Meine Aufgaben» in planbar: Aufgaben, bei denen die Person zuständig ist oder mitarbeitet.',
    optionsProvider: PLANBAR_MEMBERS_PROVIDER,
    placeholder: 'Person suchen',
  },
  {
    type: 'multiselect',
    key: 'projekte',
    label: 'Nur diese Projekte (optional)',
    description: 'Leer = alle Projekte.',
    optionsProvider: PLANBAR_PROJECTS_PROVIDER,
    placeholder: 'Projekt suchen',
  },
  { type: 'section', label: 'Auswahl' },
  {
    type: 'radio',
    key: 'typ',
    label: 'Einträge',
    options: [
      { value: 'alle', label: 'Aufgaben und Projekte' },
      { value: 'aufgabe', label: 'Nur Aufgaben' },
      { value: 'projekt', label: 'Nur Projekte' },
    ],
  },
  {
    type: 'radio',
    key: 'status',
    label: 'Status',
    description: 'Offen heisst wie in planbar: ohne Aufgaben pausierter Projekte.',
    options: [
      { value: 'offen', label: 'Nur offene' },
      { value: 'alle', label: 'Auch erledigte' },
    ],
  },
  {
    type: 'select',
    key: 'zeitraum',
    label: 'Fällig',
    description: 'Mit einer Grenze fallen Einträge ohne Fälligkeit weg.',
    options: [
      { value: 'alle', label: 'Alle, auch ohne Datum' },
      { value: 'heute', label: 'Heute und überfällig' },
      { value: 'woche', label: 'Bis Ende dieser Woche' },
      { value: 'zwei-wochen', label: 'Bis Ende nächster Woche' },
    ],
  },
  { type: 'number', key: 'maxItems', label: 'Höchstens', min: 1, max: 200, step: 1, unit: 'Einträge' },
  { type: 'section', label: 'Darstellung' },
  {
    type: 'radio',
    key: 'gruppierung',
    label: 'Gruppieren',
    options: [
      { value: 'faelligkeit', label: 'Nach Fälligkeit' },
      { value: 'person', label: 'Nach Person' },
      { value: 'projekt', label: 'Nach Projekt' },
    ],
  },
  { type: 'boolean', key: 'showProject', label: 'Projekt und Kunde anzeigen' },
  {
    type: 'boolean',
    key: 'showAssignee',
    label: 'Zuständige anzeigen',
    description: 'Nur wenn mehrere Personen ausgewählt sind.',
  },
  { type: 'section', label: 'Bedienung am Bildschirm' },
  {
    type: 'boolean',
    key: 'allowComplete',
    label: 'Abhaken erlauben',
    description:
      'Antippen des Kreises hakt die Aufgabe in planbar ab – 5 Sekunden lang lässt es sich rückgängig machen. Der API-Schlüssel braucht dafür bei «Aufgaben & Zeiten» das Recht «Schreiben».',
  },
  { type: 'number', key: 'refreshSeconds', label: 'Aktualisieren alle', min: 30, max: 600, step: 10, unit: 's' },
];

export const planbarAufgabenManifest: WidgetManifest = {
  id: 'planbar-aufgaben',
  name: 'planbar Aufgaben',
  description: 'Arbeitsliste aus planbar: offene Aufgaben und Projekte ausgewählter Personen, nach Fälligkeit gruppiert',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'planbar',
  icon: 'ClipboardCheck',
  minWidth: 3,
  minHeight: 2,
  defaultWidth: 4,
  defaultHeight: 5,
  permissions: ['network'],
  refreshInterval: PLANBAR_AUFGABEN_DEFAULTS.refreshSeconds,
  settingsSchema,
  defaultSettings: PLANBAR_AUFGABEN_DEFAULTS,
};
