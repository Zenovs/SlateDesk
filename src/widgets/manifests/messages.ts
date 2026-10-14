import type { WidgetManifest } from '../../types/widget';
import type { SettingsField } from '../../types/settings';

/** Pinnwand – shows `state.data.announcements` (erfasst in der Fernsteuerung). */
export type MessagesMode = 'liste' | 'rotation';
export type MessagesLevelFilter = 'alle' | 'wichtig';

export type MessagesSettings = {
  /** Optional heading above the announcements; '' = none. */
  title: string;
  mode: MessagesMode;
  rotateSeconds: number;
  maxItems: number;
  levelFilter: MessagesLevelFilter;
  showAuthor: boolean;
  showDate: boolean;
};

export const MESSAGES_ROTATE_MIN_SECONDS = 4;
export const MESSAGES_ROTATE_MAX_SECONDS = 120;
export const MESSAGES_MAX_ITEMS_LIMIT = 30;

export const messagesDefaultSettings: MessagesSettings = {
  title: '',
  mode: 'liste',
  rotateSeconds: 12,
  maxItems: 6,
  levelFilter: 'alle',
  showAuthor: true,
  showDate: true,
};

const messagesSettingsSchema: SettingsField[] = [
  { type: 'section', label: 'Anzeige' },
  {
    key: 'title',
    type: 'text',
    label: 'Überschrift',
    description: 'Optional, z.B. «Info-Board». Leer lassen für keine Überschrift.',
    placeholder: 'Keine Überschrift',
  },
  {
    key: 'mode',
    type: 'radio',
    label: 'Darstellung',
    options: [
      { value: 'liste', label: 'Liste' },
      { value: 'rotation', label: 'Einzeln im Wechsel' },
    ],
  },
  {
    key: 'rotateSeconds',
    type: 'range',
    label: 'Wechsel alle',
    min: MESSAGES_ROTATE_MIN_SECONDS,
    max: MESSAGES_ROTATE_MAX_SECONDS,
    step: 1,
    unit: 's',
    showIf: (values) => values.mode === 'rotation',
  },
  {
    key: 'maxItems',
    type: 'number',
    label: 'Höchstens anzeigen',
    description: 'Angeheftete Mitteilungen zuerst, danach die neusten.',
    min: 1,
    max: MESSAGES_MAX_ITEMS_LIMIT,
    step: 1,
    unit: 'Mitteilungen',
  },
  {
    key: 'levelFilter',
    type: 'radio',
    label: 'Mitteilungen',
    options: [
      { value: 'alle', label: 'Alle' },
      { value: 'wichtig', label: 'Nur wichtige' },
    ],
  },
  { type: 'section', label: 'Details' },
  { key: 'showAuthor', type: 'boolean', label: 'Verfasser anzeigen' },
  {
    key: 'showDate',
    type: 'boolean',
    label: 'Datum anzeigen',
    description: 'Veröffentlichungsdatum und, falls gesetzt, wie lange die Mitteilung sichtbar bleibt.',
  },
];

export const messagesManifest: WidgetManifest = {
  id: 'messages',
  name: 'Pinnwand',
  description: 'Mitteilungen und Ankündigungen aus der Fernsteuerung',
  version: '2.0.0',
  author: 'SlateDesk',
  category: 'Büro',
  icon: 'Megaphone',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 3,
  defaultHeight: 3,
  permissions: [],
  settingsSchema: messagesSettingsSchema,
  defaultSettings: messagesDefaultSettings,
};
