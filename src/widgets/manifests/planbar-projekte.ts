import { DEPENDS_ON_ORGS, PLANBAR_MEMBERS_PROVIDER, PLANBAR_PROJECTS_PROVIDER, planbarOrgField } from '../../planbar/options';
import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

/** Projects by filter (status, people, leader) or a hand-picked, ordered list. */
export const PLANBAR_PROJEKTE_AUSWAHL = ['filter', 'ausgewaehlt'] as const;
export type PlanbarProjekteAuswahl = (typeof PLANBAR_PROJEKTE_AUSWAHL)[number];

/** 'laufend' = only open and in progress (without planned and paused projects). */
export const PLANBAR_PROJEKTE_STATUS = ['aktiv', 'laufend', 'erledigt', 'alle'] as const;
export type PlanbarProjekteStatus = (typeof PLANBAR_PROJEKTE_STATUS)[number];

export const PLANBAR_PROJEKTE_SORTIERUNG = ['deadline', 'fortschritt', 'name'] as const;
export type PlanbarProjekteSortierung = (typeof PLANBAR_PROJEKTE_SORTIERUNG)[number];

export type PlanbarProjekteSettings = {
  /** Ids in `planbar.unternehmen`; empty = every Unternehmen with an API key. */
  unternehmen: string[];
  auswahl: PlanbarProjekteAuswahl;
  /** Project (ticket) ids in display order – used with auswahl 'ausgewaehlt'. */
  projekte: string[];
  status: PlanbarProjekteStatus;
  /** planbar user ids: projects they are involved in. Empty = everyone. */
  beteiligte: string[];
  /** planbar user id of the project leader, '' = any. */
  leiter: string;
  sortierung: PlanbarProjekteSortierung;
  maxItems: number;
  /** Booked against planned (or estimated) hours. */
  showHours: boolean;
  showMilestones: boolean;
  showMembers: boolean;
  refreshMinutes: number;
};

export const PLANBAR_PROJEKTE_DEFAULTS: PlanbarProjekteSettings = {
  unternehmen: [],
  auswahl: 'filter',
  projekte: [],
  status: 'aktiv',
  beteiligte: [],
  leiter: '',
  sortierung: 'deadline',
  maxItems: 6,
  showHours: true,
  showMilestones: true,
  showMembers: true,
  refreshMinutes: 5,
};

const byFilter = (values: Record<string, unknown>): boolean => values.auswahl !== 'ausgewaehlt';

const settingsSchema: SettingsField[] = [
  { type: 'section', label: 'Projekte' },
  planbarOrgField(),
  {
    type: 'radio',
    key: 'auswahl',
    label: 'Welche Projekte',
    options: [
      { value: 'filter', label: 'Nach Filter' },
      { value: 'ausgewaehlt', label: 'Ausgewählte Projekte' },
    ],
  },
  {
    type: 'multiselect',
    key: 'projekte',
    label: 'Projekte',
    description: 'In der gewählten Reihenfolge – auch wenn sie inzwischen erledigt sind.',
    optionsProvider: PLANBAR_PROJECTS_PROVIDER,
    optionsDependsOn: DEPENDS_ON_ORGS,
    ordered: true,
    placeholder: 'Projekt suchen',
    showIf: (values) => values.auswahl === 'ausgewaehlt',
  },
  {
    type: 'select',
    key: 'status',
    label: 'Status',
    options: [
      { value: 'aktiv', label: 'Aktiv (auch geplant und pausiert)' },
      { value: 'laufend', label: 'Laufend (offen und in Bearbeitung)' },
      { value: 'erledigt', label: 'Erledigt' },
      { value: 'alle', label: 'Alle' },
    ],
    showIf: byFilter,
  },
  {
    type: 'multiselect',
    key: 'beteiligte',
    label: 'Beteiligte Personen (optional)',
    description: 'Projekte, die sie leiten, verantworten, mitbearbeiten oder in denen sie Aufgaben haben. Leer = alle.',
    optionsProvider: PLANBAR_MEMBERS_PROVIDER,
    optionsDependsOn: DEPENDS_ON_ORGS,
    placeholder: 'Person suchen',
    showIf: byFilter,
  },
  {
    type: 'select',
    key: 'leiter',
    label: 'Projektleitung',
    options: [{ value: '', label: 'Alle' }],
    optionsProvider: PLANBAR_MEMBERS_PROVIDER,
    optionsDependsOn: DEPENDS_ON_ORGS,
    showIf: byFilter,
  },
  {
    type: 'select',
    key: 'sortierung',
    label: 'Sortieren nach',
    options: [
      { value: 'deadline', label: 'Termin (angeheftete zuerst, wie in planbar)' },
      { value: 'fortschritt', label: 'Fortschritt (am wenigsten erledigt zuerst)' },
      { value: 'name', label: 'Name' },
    ],
    showIf: byFilter,
  },
  { type: 'number', key: 'maxItems', label: 'Höchstens', min: 1, max: 30, step: 1, unit: 'Projekte' },
  { type: 'section', label: 'Details' },
  {
    type: 'boolean',
    key: 'showHours',
    label: 'Stunden anzeigen',
    description: 'Erfasste gegenüber geplanten Stunden – rot, wenn das Budget überschritten ist.',
  },
  { type: 'boolean', key: 'showMilestones', label: 'Nächsten Meilenstein anzeigen' },
  {
    type: 'boolean',
    key: 'showMembers',
    label: 'Beteiligte anzeigen',
    description: 'Initialen mit der Zahl offener Aufgaben.',
  },
  { type: 'number', key: 'refreshMinutes', label: 'Aktualisieren alle', min: 1, max: 60, step: 1, unit: 'Min.' },
];

export const planbarProjekteManifest: WidgetManifest = {
  id: 'planbar-projekte',
  name: 'planbar Projekte',
  description: 'Projektübersicht aus planbar: Fortschritt, Termin, Stunden, Meilenstein und Beteiligte',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'planbar',
  icon: 'FolderKanban',
  minWidth: 3,
  minHeight: 2,
  defaultWidth: 6,
  defaultHeight: 4,
  permissions: ['network'],
  refreshInterval: PLANBAR_PROJEKTE_DEFAULTS.refreshMinutes * 60,
  settingsSchema,
  defaultSettings: PLANBAR_PROJEKTE_DEFAULTS,
};
