import type { WidgetManifest } from '../../types/widget';
import type { SettingsField } from '../../types/settings';

/** Aufgaben – shows `state.data.todos` (erfasst in der Fernsteuerung oder am Kiosk). */
export type TodoShow = 'offen' | 'alle';
export type TodoSortBy = 'faelligkeit' | 'prioritaet' | 'erstellt';

export type TodoSettings = {
  /** '' = alle Listen, otherwise the list name (case-insensitive). */
  list: string;
  show: TodoShow;
  /** Only with show 'alle': done items disappear after this many hours (0 = immediately). */
  hideDoneAfterHours: number;
  sortBy: TodoSortBy;
  groupByDue: boolean;
  /** Tap toggles done on the kiosk. */
  allowToggle: boolean;
  /** Input + add button on the kiosk. */
  allowAdd: boolean;
  showAssignee: boolean;
  showListName: boolean;
};

export const TODO_HIDE_DONE_MAX_HOURS = 24 * 30;

export const todoDefaultSettings: TodoSettings = {
  list: '',
  show: 'offen',
  hideDoneAfterHours: 12,
  sortBy: 'faelligkeit',
  groupByDue: true,
  allowToggle: true,
  allowAdd: false,
  showAssignee: true,
  showListName: false,
};

const todoSettingsSchema: SettingsField[] = [
  { type: 'section', label: 'Aufgaben' },
  {
    key: 'list',
    type: 'text',
    label: 'Liste',
    description: 'Name einer Liste, z.B. «Einkauf». Leer lassen für alle Listen.',
    placeholder: 'Alle Listen',
  },
  {
    key: 'show',
    type: 'radio',
    label: 'Anzeigen',
    options: [
      { value: 'offen', label: 'Nur offene' },
      { value: 'alle', label: 'Offene und erledigte' },
    ],
  },
  {
    key: 'hideDoneAfterHours',
    type: 'number',
    label: 'Erledigte ausblenden nach',
    description: '0 = sofort ausblenden.',
    min: 0,
    max: TODO_HIDE_DONE_MAX_HOURS,
    step: 1,
    unit: 'Stunden',
    showIf: (values) => values.show === 'alle',
  },
  { type: 'section', label: 'Reihenfolge' },
  {
    key: 'sortBy',
    type: 'select',
    label: 'Sortieren nach',
    options: [
      { value: 'faelligkeit', label: 'Fälligkeit' },
      { value: 'prioritaet', label: 'Priorität' },
      { value: 'erstellt', label: 'Erfassung (neuste zuerst)' },
    ],
  },
  {
    key: 'groupByDue',
    type: 'boolean',
    label: 'Nach Fälligkeit gruppieren',
    description: 'Überfällig, Heute, Morgen, Diese Woche, Später, Ohne Datum',
  },
  { type: 'section', label: 'Bedienung am Bildschirm' },
  {
    key: 'allowToggle',
    type: 'boolean',
    label: 'Abhaken erlauben',
    description: 'Antippen markiert eine Aufgabe als erledigt.',
  },
  {
    key: 'allowAdd',
    type: 'boolean',
    label: 'Erfassen erlauben',
    description: 'Zeigt ein Eingabefeld für neue Aufgaben.',
  },
  { type: 'section', label: 'Details' },
  { key: 'showAssignee', type: 'boolean', label: 'Zuständige Person anzeigen' },
  {
    key: 'showListName',
    type: 'boolean',
    label: 'Listenname anzeigen',
    description: 'Bei allen Listen an jeder Aufgabe, sonst als Überschrift.',
  },
];

export const todoManifest: WidgetManifest = {
  id: 'todo',
  name: 'Aufgaben',
  description: 'Gemeinsame Aufgabenlisten mit Fälligkeit und Priorität',
  version: '3.0.0',
  author: 'SlateDesk',
  category: 'Büro',
  icon: 'ListTodo',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 4,
  defaultHeight: 3,
  permissions: [],
  settingsSchema: todoSettingsSchema,
  defaultSettings: todoDefaultSettings,
};
