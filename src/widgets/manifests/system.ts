import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type SystemWidgetSettings = {
  /** Address and QR code of the web UI – never the PIN. */
  showRemote: boolean;
  /** Load, memory, disk, version, session. */
  showDetails: boolean;
};

export const SYSTEM_WIDGET_DEFAULTS: SystemWidgetSettings = {
  showRemote: true,
  showDetails: true,
};

const settingsSchema: SettingsField[] = [
  {
    type: 'boolean',
    key: 'showRemote',
    label: 'Fernsteuerung anzeigen',
    description: 'Adresse und QR-Code, damit sich die Fernsteuerung mit dem Handy öffnen lässt. Der PIN wird nie angezeigt.',
  },
  {
    type: 'boolean',
    key: 'showDetails',
    label: 'Details anzeigen',
    description: 'Last, Arbeitsspeicher, Speicherplatz, Version und Sitzung',
  },
];

export const systemManifest: WidgetManifest = {
  id: 'system',
  name: 'Kiosk-Status',
  description: 'Name, Adresse, Laufzeit, Temperatur und Auslastung dieses Bildschirms – mit QR-Code zur Fernsteuerung',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'Netzwerk',
  icon: 'Monitor',
  minWidth: 3,
  minHeight: 2,
  defaultWidth: 4,
  defaultHeight: 4,
  permissions: ['system'],
  refreshInterval: 30,
  settingsSchema,
  defaultSettings: SYSTEM_WIDGET_DEFAULTS,
};
