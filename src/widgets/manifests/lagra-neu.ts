import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export const LAGRA_NEU_ARTEN = ['BILD', 'GRAFIK', 'alle'] as const;
export type LagraNeuArt = (typeof LAGRA_NEU_ARTEN)[number];

export const LAGRA_NEU_MODES = ['diashow', 'raster'] as const;
export type LagraNeuMode = (typeof LAGRA_NEU_MODES)[number];

export type LagraNeuSettings = {
  /** 1–30 */
  anzahl: number;
  /** Folder below lagra's API roots, e.g. '/daten/Intern/Schaufenster'; empty = all API roots. */
  ordner: string;
  art: LagraNeuArt;
  /** File names often name the customer – off by default. */
  showNames: boolean;
  mode: LagraNeuMode;
  /** Slideshow: seconds per image. */
  intervalSeconds: number;
  /** Minutes between two requests for the list. */
  refreshMinutes: number;
};

export const LAGRA_NEU_DEFAULTS: LagraNeuSettings = {
  anzahl: 12,
  ordner: '',
  art: 'BILD',
  showNames: false,
  mode: 'diashow',
  intervalSeconds: 8,
  refreshMinutes: 5,
};

const settingsSchema: SettingsField[] = [
  {
    type: 'section',
    label: 'Quelle',
    description:
      'Zeigt Kundenarbeit – auch Besuchern, die vor dem Bildschirm stehen. Am besten nur einen Ordner wählen, dessen Inhalt bewusst gezeigt werden darf.',
  },
  {
    type: 'text',
    key: 'ordner',
    label: 'Ordner (dringend empfohlen)',
    placeholder: '/daten/Intern/Schaufenster',
    description:
      'Ein eigens dafür kuratierter Ordner in lagra, z. B. «Schaufenster». Leer = alle Ordner, die lagra für die Schnittstelle freigibt – also auch unveröffentlichte Kundenarbeit.',
  },
  {
    type: 'select',
    key: 'art',
    label: 'Art',
    options: [
      { value: 'BILD', label: 'Bilder' },
      { value: 'GRAFIK', label: 'Grafiken' },
      { value: 'alle', label: 'Alle Dateien mit Vorschau' },
    ],
  },
  { type: 'number', key: 'anzahl', label: 'Anzahl', min: 1, max: 30, step: 1, unit: 'Dateien' },
  {
    type: 'boolean',
    key: 'showNames',
    label: 'Dateinamen anzeigen',
    description: 'Dateinamen nennen oft den Kunden – Besucher können sie am Bildschirm lesen.',
  },
  { type: 'section', label: 'Darstellung' },
  {
    type: 'radio',
    key: 'mode',
    label: 'Darstellung',
    options: [
      { value: 'diashow', label: 'Diashow' },
      { value: 'raster', label: 'Raster' },
    ],
  },
  {
    type: 'number',
    key: 'intervalSeconds',
    label: 'Bildwechsel alle',
    min: 3,
    max: 300,
    step: 1,
    unit: 's',
    showIf: (values) => values.mode !== 'raster',
  },
  { type: 'number', key: 'refreshMinutes', label: 'Neue Dateien prüfen alle', min: 1, max: 60, step: 1, unit: 'Min.' },
];

export const lagraNeuManifest: WidgetManifest = {
  id: 'lagra-neu',
  name: 'lagra: Neu im DAM',
  description: 'Diashow oder Raster der zuletzt in lagra aufgenommenen Bilder – am besten aus einem kuratierten Ordner',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'lagra',
  icon: 'Images',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 4,
  defaultHeight: 4,
  permissions: ['network'],
  refreshInterval: LAGRA_NEU_DEFAULTS.refreshMinutes * 60,
  settingsSchema,
  defaultSettings: LAGRA_NEU_DEFAULTS,
};
