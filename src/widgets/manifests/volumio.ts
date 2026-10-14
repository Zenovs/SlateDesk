import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

/** What the widget shows once playback has been stopped for `idleMinutes`. */
export type VolumioIdleView = 'logo' | 'letzterTitel' | 'nichts';

export type VolumioSettings = {
  /** IP, hostname or URL, optionally with port: "192.168.1.20", "volumio.local", "http://host:3000". */
  host: string;
  pollSeconds: number;
  showControls: boolean;
  showVolume: boolean;
  /** Percent per tap on − / +. */
  volumeStep: number;
  /** Upper limit for «lauter» – a visitor tapping + must not blast the office. */
  maxVolume: number;
  showProgress: boolean;
  showQuality: boolean;
  idleView: VolumioIdleView;
  idleMinutes: number;
};

export const VOLUMIO_DEFAULT_SETTINGS: VolumioSettings = {
  host: '',
  pollSeconds: 3,
  showControls: true,
  showVolume: true,
  volumeStep: 5,
  maxVolume: 70,
  showProgress: true,
  showQuality: false,
  idleView: 'logo',
  idleMinutes: 10,
};

const volumioSettingsSchema: SettingsField[] = [
  { type: 'section', label: 'Verbindung' },
  {
    key: 'host',
    type: 'text',
    label: 'Volumio-Adresse',
    placeholder: 'z.B. 192.168.1.20 oder volumio.local',
    description:
      'IP-Adresse oder Hostname, optional mit Port (http://volumio.local:3000). Zu finden in Volumio unter Einstellungen → Netzwerk.',
  },
  {
    key: 'pollSeconds',
    type: 'select',
    label: 'Aktualisierung',
    options: [
      { value: 2, label: 'Alle 2 Sekunden' },
      { value: 3, label: 'Alle 3 Sekunden' },
      { value: 5, label: 'Alle 5 Sekunden' },
      { value: 10, label: 'Alle 10 Sekunden' },
      { value: 30, label: 'Alle 30 Sekunden' },
    ],
  },
  { type: 'section', label: 'Anzeige' },
  { key: 'showProgress', type: 'boolean', label: 'Fortschritt anzeigen', description: 'Position und Länge des Titels' },
  {
    key: 'showQuality',
    type: 'boolean',
    label: 'Audioqualität anzeigen',
    description: 'Format, Abtastrate, Bittiefe und Quelle',
  },
  {
    key: 'idleView',
    type: 'select',
    label: 'Bei gestoppter Wiedergabe',
    options: [
      { value: 'logo', label: 'Volumio-Symbol zeigen' },
      { value: 'letzterTitel', label: 'Letzten Titel weiter zeigen' },
      { value: 'nichts', label: 'Nichts zeigen (leer)' },
    ],
  },
  {
    key: 'idleMinutes',
    type: 'number',
    label: 'Umschalten nach',
    unit: 'Minuten',
    min: 0,
    max: 240,
    step: 1,
    description: 'Bis dahin bleibt der letzte Titel abgedunkelt sichtbar. 0 = sofort.',
    showIf: (values) => values.idleView !== 'letzterTitel',
  },
  { type: 'section', label: 'Bedienung' },
  {
    key: 'showControls',
    type: 'boolean',
    label: 'Wiedergabe-Tasten',
    description: 'Zurück, Wiedergabe/Pause und Weiter',
  },
  { key: 'showVolume', type: 'boolean', label: 'Lautstärke-Tasten', description: 'Leiser, lauter und stumm' },
  {
    key: 'volumeStep',
    type: 'number',
    label: 'Schrittweite',
    unit: '%',
    min: 1,
    max: 25,
    step: 1,
    showIf: (values) => values.showVolume === true,
  },
  {
    key: 'maxVolume',
    type: 'range',
    label: 'Maximale Lautstärke',
    min: 10,
    max: 100,
    step: 5,
    unit: '%',
    description: '«Lauter» geht nie über diesen Wert hinaus.',
    showIf: (values) => values.showVolume === true,
  },
];

export const volumioManifest: WidgetManifest = {
  id: 'volumio',
  name: 'Volumio',
  description: 'Aktueller Titel von Volumio mit Wiedergabe- und Lautstärke-Tasten',
  version: '2.0.0',
  author: 'SlateDesk',
  category: 'Medien',
  icon: 'Music',
  minWidth: 2,
  minHeight: 3,
  defaultWidth: 4,
  defaultHeight: 4,
  permissions: ['network'],
  settingsSchema: volumioSettingsSchema,
  defaultSettings: VOLUMIO_DEFAULT_SETTINGS,
};
