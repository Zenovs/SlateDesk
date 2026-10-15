import { planbarOrgField } from '../../planbar/options';
import type { PlanbarVisibility } from '../../planbar/types';
import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export const PLANBAR_NEWS_MODES = ['liste', 'rotation'] as const;
export type PlanbarNewsMode = (typeof PLANBAR_NEWS_MODES)[number];

export const PLANBAR_NEWS_SICHTBARKEIT = [
  'member',
  'koordinator',
  'projektleiter',
  'org_admin',
] as const satisfies readonly PlanbarVisibility[];

export type PlanbarNewsSettings = {
  /** Ids in `planbar.unternehmen`; empty = every Unternehmen with an API key. */
  unternehmen: string[];
  /** 1–20 posts (over all Unternehmen) */
  anzahl: number;
  mode: PlanbarNewsMode;
  rotateSeconds: number;
  showTeaser: boolean;
  showAuthor: boolean;
  showComments: boolean;
  /** Include posts up to this visibility level ('member' = only posts for everyone). */
  sichtbarkeit: PlanbarVisibility;
  refreshMinutes: number;
};

export const PLANBAR_NEWS_DEFAULTS: PlanbarNewsSettings = {
  unternehmen: [],
  anzahl: 6,
  mode: 'liste',
  rotateSeconds: 15,
  showTeaser: true,
  showAuthor: true,
  showComments: true,
  sichtbarkeit: 'member',
  refreshMinutes: 10,
};

const settingsSchema: SettingsField[] = [
  { type: 'section', label: 'Beiträge' },
  planbarOrgField(),
  {
    type: 'number',
    key: 'anzahl',
    label: 'Anzahl',
    description: 'Die neusten Beiträge aller gewählten Unternehmen zusammen.',
    min: 1,
    max: 20,
    step: 1,
    unit: 'Beiträge',
  },
  {
    type: 'select',
    key: 'sichtbarkeit',
    label: 'Sichtbarkeit',
    description:
      'Beiträge bis zu dieser Stufe zeigen. Der Bildschirm ist für alle lesbar, die davor stehen – eingeschränkte Beiträge nur bewusst einschliessen.',
    options: [
      { value: 'member', label: 'Nur Beiträge für alle' },
      { value: 'koordinator', label: 'Bis «Ab Koordinator»' },
      { value: 'projektleiter', label: 'Bis «Ab Projektleiter»' },
      { value: 'org_admin', label: 'Alle, auch «Nur Admin Unternehmen»' },
    ],
  },
  { type: 'section', label: 'Darstellung' },
  {
    type: 'radio',
    key: 'mode',
    label: 'Ansicht',
    options: [
      { value: 'liste', label: 'Liste' },
      { value: 'rotation', label: 'Ein Beitrag (wechselnd)' },
    ],
  },
  {
    type: 'number',
    key: 'rotateSeconds',
    label: 'Wechsel alle',
    min: 5,
    max: 120,
    step: 1,
    unit: 's',
    showIf: (values) => values.mode === 'rotation',
  },
  {
    type: 'boolean',
    key: 'showTeaser',
    label: 'Text anzeigen',
    description: 'In der Liste die erste Zeile nach dem Titel, beim einzelnen Beitrag der ganze Text.',
  },
  { type: 'boolean', key: 'showAuthor', label: 'Verfasser anzeigen' },
  { type: 'boolean', key: 'showComments', label: 'Kommentare anzeigen', description: 'Anzahl und letzter Kommentar.' },
  { type: 'number', key: 'refreshMinutes', label: 'Aktualisieren alle', min: 1, max: 60, step: 1, unit: 'Min.' },
];

export const planbarNewsManifest: WidgetManifest = {
  id: 'planbar-news',
  name: 'planbar News',
  description: 'Beiträge der planbar-Infowand als Liste oder einzeln im Wechsel',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'planbar',
  icon: 'Megaphone',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 4,
  defaultHeight: 4,
  permissions: ['network'],
  refreshInterval: PLANBAR_NEWS_DEFAULTS.refreshMinutes * 60,
  settingsSchema,
  defaultSettings: PLANBAR_NEWS_DEFAULTS,
};
