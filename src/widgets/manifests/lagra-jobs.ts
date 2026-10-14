import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type LagraJobsSettings = {
  /** Only jobs whose last run failed or was cancelled. */
  onlyProblems: boolean;
  maxJobs: number;
  /** «nächster Lauf ~03:00» */
  showNextRun: boolean;
  /** Seconds between two requests. */
  refreshSeconds: number;
};

export const LAGRA_JOBS_DEFAULTS: LagraJobsSettings = {
  onlyProblems: false,
  maxJobs: 12,
  showNextRun: true,
  refreshSeconds: 60,
};

const settingsSchema: SettingsField[] = [
  {
    type: 'boolean',
    key: 'onlyProblems',
    label: 'Nur Probleme',
    description: 'Nur Aufgaben zeigen, deren letzter Lauf fehlgeschlagen ist oder abgebrochen wurde',
  },
  { type: 'number', key: 'maxJobs', label: 'Höchstens', min: 1, max: 20, step: 1, unit: 'Aufgaben' },
  { type: 'boolean', key: 'showNextRun', label: 'Nächsten Lauf anzeigen', description: 'Ungefähre Zeit, z. B. «~03:00»' },
  { type: 'number', key: 'refreshSeconds', label: 'Aktualisieren alle', min: 15, max: 600, step: 5, unit: 's' },
];

export const lagraJobsManifest: WidgetManifest = {
  id: 'lagra-jobs',
  name: 'lagra Aufgaben',
  description: 'Hintergrundaufgaben von lagra: letzter Lauf, Fortschritt, nächster Lauf und Zeitplan',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'lagra',
  icon: 'ListChecks',
  minWidth: 3,
  minHeight: 2,
  defaultWidth: 4,
  defaultHeight: 4,
  permissions: ['network'],
  refreshInterval: LAGRA_JOBS_DEFAULTS.refreshSeconds,
  settingsSchema,
  defaultSettings: LAGRA_JOBS_DEFAULTS,
};
