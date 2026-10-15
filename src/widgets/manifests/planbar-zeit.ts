import { DEPENDS_ON_ORGS, PLANBAR_MEMBERS_PROVIDER, planbarOrgField } from '../../planbar/options';
import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type PlanbarZeitSettings = {
  /** Ids in `planbar.unternehmen`; empty = every Unternehmen with an API key. */
  unternehmen: string[];
  /** planbar user ids in display order; empty = everyone in the organisations. */
  benutzer: string[];
  /** Hours of the week and a bar per weekday. */
  showWeek: boolean;
  /** Target per working day (Mo–Fr) for the progress bars; 0 = no target. */
  sollStundenProTag: number;
  refreshSeconds: number;
};

export const PLANBAR_ZEIT_DEFAULTS: PlanbarZeitSettings = {
  unternehmen: [],
  benutzer: [],
  showWeek: true,
  sollStundenProTag: 8.4,
  refreshSeconds: 60,
};

const settingsSchema: SettingsField[] = [
  { type: 'section', label: 'Personen' },
  planbarOrgField(),
  {
    type: 'multiselect',
    key: 'benutzer',
    label: 'Personen',
    description:
      'In dieser Reihenfolge. Leer = alle Personen der gewählten Unternehmen. Wer für mehrere Unternehmen arbeitet, erscheint einmal mit der Summe.',
    optionsProvider: PLANBAR_MEMBERS_PROVIDER,
    optionsDependsOn: DEPENDS_ON_ORGS,
    ordered: true,
    placeholder: 'Person suchen',
  },
  { type: 'section', label: 'Darstellung' },
  { type: 'boolean', key: 'showWeek', label: 'Woche anzeigen', description: 'Stunden der Woche und ein Balken pro Tag.' },
  {
    type: 'number',
    key: 'sollStundenProTag',
    label: 'Soll pro Arbeitstag',
    description: 'Für den Fortschritt (Woche: fünf Arbeitstage). 0 = ohne Soll.',
    min: 0,
    max: 24,
    step: 0.1,
    unit: 'Std.',
  },
  { type: 'number', key: 'refreshSeconds', label: 'Aktualisieren alle', min: 30, max: 600, step: 10, unit: 's' },
];

export const planbarZeitManifest: WidgetManifest = {
  id: 'planbar-zeit',
  name: 'planbar Zeit',
  description: 'Erfasste Stunden von heute und dieser Woche pro Person, mit laufendem Timer',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'planbar',
  icon: 'Timer',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 4,
  defaultHeight: 3,
  permissions: ['network'],
  refreshInterval: PLANBAR_ZEIT_DEFAULTS.refreshSeconds,
  settingsSchema,
  defaultSettings: PLANBAR_ZEIT_DEFAULTS,
};
